import { after } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import { fakeDocker, type FakeContainer } from "../../docker/test/fake-docker.ts";
import { dockerFor } from "../../docker/src/docker.ts";
import { setPortal } from "../src/server/host.ts";
import { openStore, putSettings } from "../src/server/store.ts";

/**
 * The voice service as its server half runs it, against a Docker daemon of the tests' own (Docker's fake-docker.ts):
 * `voiceDocker` is the daemon and the machine around it, and `voiceService` the service with Docker's own API for the
 * extension and a portal that keeps what the service tells it, without the portal's host. The GPUs are what the tests
 * say: nvidia-smi on the host, and nvidia-smi in the container the GPU check runs. No GPU, no image and no container of
 * this machine is touched, and the voice processes answer as a test says.
 */

/** Docker's words for a container that asks for a GPU it has no runtime for. */
export const NO_RUNTIME = 'could not select device driver "nvidia" with capabilities: [[gpu]]';
export const CUDA = "nvidia/cuda:12.4.1-devel-ubuntu22.04";
export const BASE = "ubuntu:22.04";
export const CONTAINER = "pithagoras-voice";
export const PROBE = "pithagoras-voice-probe";

/** A line of nvidia-smi for a card: its index, its UUID where given, its name, and its memory in MiB. */
export const GPU = (index: number, total: number, free: number, name = `Test GPU ${index}`, uuid?: string) => `${index}, ${uuid ? `${uuid}, ` : ""}${name}, ${total}, ${free}\n`;

/** The daemon, nvidia-smi and the voice processes, as `voiceService` describes them; `reset` goes back to how they began. */
export async function voiceDocker() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-docker-"));
  const daemon = await fakeDocker();
  process.env.DOCKER_SOCKET = daemon.socket;
  process.env.PORTAL_CONTAINER_NAME = "portal-test";
  delete process.env.VOICE_GPU;
  delete process.env.VOICE_VRAM_RESERVE_MIB;
  const smi = path.join(dir, "nvidia-smi");
  const smiOutput = path.join(dir, "smi-output");
  writeFileSync(smi, `#!/bin/sh\ncat "${smiOutput}"\n`);
  chmodSync(smi, 0o755);
  // A host with no nvidia-smi until a test says what it prints (hostGpus): the GPUs of the machine the tests run on are not the test's.
  process.env.NVIDIA_SMI = path.join(dir, "no-such-nvidia-smi");

  /** What nvidia-smi in the GPU check's container prints, as it starts, or null for a Docker with no runtime for a GPU. */
  let inDocker: string | null | (() => string) = "";
  daemon.runs.refuseStart = (c) => (inDocker === null && (c.made?.HostConfig as { DeviceRequests?: unknown } | undefined)?.DeviceRequests ? NO_RUNTIME : undefined);
  // The check's container prints what it was given and exits; the voice container runs until it is stopped.
  daemon.runs.onStart = (c) => {
    if (c.Name !== PROBE) return new Promise<void>(() => {});
    c.out = typeof inDocker === "function" ? inDocker() : (inDocker ?? "");
    c.code = 0;
  };

  // The voice processes on the portal's loopback answer their health checks, unless a test says one does not, and a
  // load or an unload of the speech model is kept. What they are asked to hear and to say is kept too, and answered as
  // a test says, or as the engines answer: recognition with a transcript, Breeze with PCM as audio.cpp labels it, and
  // the others with a 24 kHz WAV. Anything else is fetched as it is.
  const real = globalThis.fetch;
  const voiceProcesses = {
    unhealthy: [] as string[],
    models: [] as { url: string; body: unknown }[],
    /** How many of the next loads of a speech model fail, as an engine with no room left on its GPU answers. */
    failLoads: 0,
    /** Each recording sent to recognition: where, and the form it was sent as. */
    heard: [] as { url: string; form: FormData }[],
    /** Each phrase asked for: where, and the JSON it was asked with. */
    spoken: [] as { url: string; body: any }[],
    /** How a phrase is answered, where a test says. */
    speak: undefined as ((body: any, init?: RequestInit) => Response | Promise<Response>) | undefined,
  };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const at = String(url);
    if (!/^http:\/\/127\.0\.0\.1:(7862|7863|8188)\//.test(at)) return real(url, init);
    if (at.includes("/v1/models/")) {
      voiceProcesses.models.push({ url: at, body: JSON.parse(String(init?.body)) });
      if (at.endsWith("/load") && voiceProcesses.failLoads > 0) {
        voiceProcesses.failLoads--;
        return new Response("boom", { status: 500 });
      }
    }
    if (/\/(inference|v1\/audio\/transcriptions)$/.test(at)) {
      voiceProcesses.heard.push({ url: at, form: init?.body as FormData });
      return Response.json({ text: " Heard you. " });
    }
    if (at.endsWith("/v1/audio/speech")) {
      const body = JSON.parse(String(init?.body));
      voiceProcesses.spoken.push({ url: at, body });
      if (voiceProcesses.speak) return voiceProcesses.speak(body, init);
      return body.model === "breeze" ? new Response(PCM, { headers: { "content-type": "application/octet-stream" } }) : new Response(wav24k(PCM), { headers: { "content-type": "audio/wav" } });
    }
    return new Response("{}", { status: voiceProcesses.unhealthy.some((port) => at.includes(port)) ? 503 : 200 });
  }) as typeof fetch;

  after(async () => {
    globalThis.fetch = real;
    await daemon.close();
  });

  const service = await import("../src/server/service.ts");
  // Run from its source, the half reads the script where the package keeps it.
  service.setupScript.url = new URL("../setup.sh", import.meta.url);
  let old = 0;
  const dropVoice = () => {
    const at = daemon.containers.findIndex((c) => c.Name === CONTAINER);
    if (at >= 0) daemon.containers.splice(at, 1);
  };
  return {
    daemon,
    service,
    voiceProcesses,
    /** What nvidia-smi on the portal's host prints, or null for a host that has none. */
    hostGpus(output: string | null) {
      if (output === null) process.env.NVIDIA_SMI = path.join(dir, "no-such-nvidia-smi");
      else {
        process.env.NVIDIA_SMI = smi;
        writeFileSync(smiOutput, output);
      }
    },
    /** What nvidia-smi prints in the check's container (worked out as it starts), or null for a Docker with no runtime for a GPU. */
    dockerGpus(output: string | null | (() => string)) {
      inDocker = output;
    },
    /** The portal's own container, running under the name the portal is told (PORTAL_CONTAINER_NAME), with this id. */
    portalIs(id: string) {
      const at = daemon.containers.findIndex((c) => c.Name === "portal-test");
      if (at >= 0) daemon.containers.splice(at, 1);
      daemon.containers.push({ Id: id, Name: "portal-test", Image: "pithagoras-portal:latest", State: "running", Labels: {}, Tty: false, out: "", err: "" });
    },
    /** The voice container as Docker has it now. */
    voice: (): FakeContainer | undefined => daemon.containers.find((c) => c.Name === CONTAINER),
    /** The voice containers made, in the order they were. */
    made: () => daemon.created.filter((c) => c.Name === CONTAINER),
    /** A container by the voice container's name, as an earlier portal made it (no extension's name on it), in place of one there is. */
    putVoice(container: Partial<FakeContainer> & { HostConfig?: Record<string, unknown> }) {
      dropVoice();
      daemon.containers.push({ Id: `old-${++old}`.padEnd(12, "0"), Name: CONTAINER, Image: CUDA, State: "exited", Labels: {}, Tty: true, out: "services ready", err: "", ...container });
    },
    dropVoice,
    /**
     * As the tests began: the portal's container running as `portal-one`, no voice container, both images there, a
     * Docker that hands out GPUs, the host's memory and threads as `host` says, nothing chosen or set on the page, and
     * every voice process answering as the engines do. Nothing is said to have happened.
     */
    reset() {
      daemon.containers.length = 0;
      daemon.volumes.length = 0;
      for (const list of [daemon.created, daemon.starts, daemon.updates, daemon.pulls]) list.length = 0;
      daemon.failing.clear();
      daemon.images.clear();
      daemon.images.add(CUDA);
      daemon.images.add(BASE);
      daemon.runs.onStop = undefined;
      daemon.hold.pull = undefined;
      this.portalIs("portal-one");
      inDocker = "";
      voiceProcesses.unhealthy = [];
      voiceProcesses.models.length = 0;
      voiceProcesses.failLoads = 0;
      voiceProcesses.heard.length = 0;
      voiceProcesses.spoken.length = 0;
      voiceProcesses.speak = undefined;
      delete process.env.VOICE_GPU;
      delete process.env.VOICE_VRAM_RESERVE_MIB;
      putSettings({ gpu: undefined, setupPending: undefined, lazyLoad: undefined, voice: undefined, instruction: undefined, cfgScale: undefined, exaggeration: undefined, kokoroVoice: undefined, speed: undefined, language: undefined });
      service.hostReader.read = () => ({ totalMiB: 16384, freeMiB: 12000, threads: 8 });
    },
    /** Until a setup that is under way has ended: a minute at most, for a machine that is busy with other tests. */
    async settle() {
      for (const until = Date.now() + 60_000; Date.now() < until && (await service.status()).busy; ) await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}

/** The service with Docker's own API for the extension, and a portal that keeps what the service tells it, as `told` has it. */
export async function voiceService() {
  const machine = await voiceDocker();
  const data = mkdtempSync(path.join(os.tmpdir(), "voice-service-"));
  mkdirSync(path.join(data, "docker"));
  const docker = dockerFor(path.join(data, "docker")).forExtension("pithagoras-voice");
  /** What the service told the portal: its log, and each time it made itself voice mode's source or gave it back. */
  const told = { log: [] as string[], chosen: [] as boolean[] };
  setPortal({
    extension: "pithagoras-voice",
    extensions: { use: () => docker },
    log: (text: string) => told.log.push(text),
    voice: { provide() {}, choose: (chosen: boolean) => told.chosen.push(chosen) },
    dataDir: () => data,
  } as unknown as ServerPortal);
  openStore(data);
  return Object.assign(machine, { docker, told, data });
}

/** Two samples of speech, as the engines answer them here. */
export const PCM = Buffer.from([0, 0, 255, 127]);

/** `pcm` as a WAV of mono 24 kHz 16-bit samples, as Chatterbox and Kokoro answer. */
export function wav24k(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** A container's environment as names and values. */
export const env = (spec: { Env?: unknown }) => Object.fromEntries((spec.Env as string[]).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
