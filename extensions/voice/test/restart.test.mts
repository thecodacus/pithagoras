import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "../../../tests/helpers.mts";
import type { FakeContainer } from "../../docker/test/fake-docker.ts";
import { serveVoice } from "./portal.mts";
import { CONTAINER } from "./service.mts";

/**
 * The voice container comes back after the host restarts, as Docker's `unless-stopped` has it, against Docker's fake
 * daemon and through the routes of the service's page: a new one is made so, one made before with no restart policy is
 * given it as it is, a setup that keeps failing while Docker starts it again shows the failure, one Docker brought back
 * is no failure, and Retry, Install and the person's Stop do what they say. No GPU, no image and no container of this
 * machine is touched.
 */

inProcessHome("pithagoras-voice-restart-");
const { machine, at, docker: daemon } = await serveVoice();
const { state: offers } = await import("../src/server/provider.ts");

const json = { "content-type": "application/json" };
const state = async () => (await fetch(`${at}/state`)).json();
const post = (route: string, body: unknown = {}) => fetch(`${at}${route}`, { method: "POST", headers: json, body: JSON.stringify(body) });
const UNLESS_STOPPED = { RestartPolicy: { Name: "unless-stopped" } };
const RECOGNITION_ONLY = { tts: "none", asr: "whisper", asrModel: "base" };
/** The voice container Voice made, for the original engines on the portal's loopback, as Docker has it now. */
const voiceIs = (container: Partial<FakeContainer> & { HostConfig: Record<string, unknown> }) =>
  machine.putVoice({
    Labels: { "pithagoras.extension": "pithagoras-voice", "pithagoras.addon": "voice", "pithagoras.voice-network": "shared-v1", "pithagoras.voice-recipe": "breeze+whisper:base" },
    ...container,
    HostConfig: { NetworkMode: "container:portal-one", ...container.HostConfig },
  });
/**
 * Docker's own next try at the voice container: a run it began by itself, at a time of its own (`State.StartedAt`, in
 * Docker's nanoseconds, so never one a start by request was given).
 */
let tries = 0;
const dockersTry = (more: Partial<FakeContainer> = {}) =>
  Object.assign(machine.voice()!, { State: "running", code: 0, started: `2026-10-23T11:52:${String(++tries).padStart(2, "0")}.000000001Z`, ...more });
/** How many times Docker was asked to stop the voice container, and to start it, from now on. */
const asked = () => {
  const starts = daemon.starts.length;
  const said = { stops: 0, starts: () => daemon.starts.slice(starts).filter((name) => name === CONTAINER).length };
  daemon.runs.onStop = (c) => {
    if (c.Name === CONTAINER) said.stops++;
  };
  return said;
};

test("a voice container is made to come back after the host restarts, unless the person stopped it", async () => {
  machine.reset();
  machine.hostGpus(null);
  assert.equal((await post("/install", RECOGNITION_ONLY)).status, 200);
  await machine.settle();
  assert.deepEqual((machine.made()[0].made as any).HostConfig.RestartPolicy, { Name: "unless-stopped" });
  assert.equal((await state()).state, "running");
  assert.deepEqual(daemon.updates, [], "one made so has nothing to change");
});

test("one made before with no restart policy is given unless-stopped as it is: not made again or restarted, and a stopped one stays stopped", async () => {
  machine.reset();
  voiceIs({ State: "running", HostConfig: { RestartPolicy: { Name: "no" } } });
  const { Id } = machine.voice()!;
  const said = asked();
  assert.equal((await state()).state, "running");
  assert.deepEqual(daemon.updates, [{ name: CONTAINER, changes: UNLESS_STOPPED }]);
  assert.deepEqual((machine.voice()!.HostConfig as any).RestartPolicy, { Name: "unless-stopped" });
  assert.deepEqual([machine.voice()!.Id, machine.voice()!.State, daemon.created, said.stops, said.starts()], [Id, "running", [], 0, 0]);
  // Once: what the page asks next finds it as it is now.
  await state();
  assert.equal(daemon.updates.length, 1);

  machine.reset();
  voiceIs({ State: "exited", HostConfig: { RestartPolicy: { Name: "no" } } });
  const stopped = asked();
  assert.equal((await state()).state, "stopped");
  assert.deepEqual(daemon.updates, [{ name: CONTAINER, changes: UNLESS_STOPPED }]);
  assert.deepEqual([machine.voice()!.State, daemon.created, stopped.starts()], ["exited", [], 0]);
});

test("a setup that keeps failing shows the failure and its log while Docker starts it again, between its tries and in one; Retry runs it now", async () => {
  machine.reset();
  voiceIs({ State: "restarting", code: 1, restarts: 3, out: "VOICE_STAGE: Building audio.cpp\nVOICE_SETUP_ERROR: setup or service failed (line 98)\n", HostConfig: UNLESS_STOPPED });
  const between = await state();
  assert.deepEqual([between.state, between.busy, between.error, between.retrying], ["failed", false, "Voice setup or service exited, and Docker is starting it again. Review the log, or retry now.", true]);
  assert.match(between.progress, /VOICE_SETUP_ERROR: setup or service failed \(line 98\)/);
  // Docker's next try, which does not answer yet: still the failure, not Starting, so the page does not flicker with each try.
  dockersTry();
  machine.voiceProcesses.unhealthy = ["8188", "7862"];
  const inTry = await state();
  assert.deepEqual([inTry.state, inTry.error], ["failed", between.error]);

  // Retry setup, between two tries: a start would be Docker's "running already". Docker's tries are ended, and the
  // setup runs now, in the same container.
  Object.assign(machine.voice()!, { State: "restarting", code: 1 });
  const { Id } = machine.voice()!;
  const said = asked();
  assert.equal((await post("/start")).status, 200);
  await machine.settle();
  assert.deepEqual([said.stops, said.starts(), daemon.created, machine.voice()!.Id], [1, 1, [], Id]);
  const retried = await state();
  assert.deepEqual([retried.state, retried.error], ["starting", ""], "a start of the person's, with Docker's tries counted from none");
  machine.voiceProcesses.unhealthy = [];
  assert.equal((await state()).state, "running");

  // And in one of Docker's tries, after the service that answered exited: a run Docker began, not answering yet.
  dockersTry({ restarts: 1 });
  machine.voiceProcesses.unhealthy = ["8188"];
  assert.equal((await state()).state, "failed");
  const again = asked();
  assert.equal((await post("/start")).status, 200);
  await machine.settle();
  assert.deepEqual([again.stops, again.starts(), daemon.created], [1, 1, []]);
  assert.equal((await state()).state, "starting");
});

test("one Docker brought back is no failure once its services answered: a check slow once after leaves it voice mode's, and Start and a GPU choice leave it running", async () => {
  machine.reset();
  // Docker started it again once, and goes on counting that start for as long as the run it began lasts.
  voiceIs({ State: "running", restarts: 1, started: "2026-10-23T11:51:00.000000001Z", HostConfig: UNLESS_STOPPED });
  assert.equal((await state()).state, "running");
  machine.voiceProcesses.unhealthy = ["8188"];
  const slow = await state();
  assert.deepEqual([slow.state, slow.error, slow.retrying], ["starting", "", false]);
  assert.ok(offers(), "voice mode still listens and speaks through it");

  const said = asked();
  assert.equal((await post("/start")).status, 200);
  await machine.settle();
  const gpu = await fetch(`${at}/gpu`, { method: "PUT", headers: json, body: JSON.stringify({ gpu: "" }) });
  assert.deepEqual([gpu.status, (await gpu.json()).restarting], [200, true]);
  await machine.settle();
  assert.deepEqual([said.stops, said.starts(), daemon.created, machine.voice()!.State], [0, 0, [], "running"]);
  machine.voiceProcesses.unhealthy = [];
  assert.equal((await state()).state, "running");
});

test("Install with other engines replaces a container Docker is starting again", async () => {
  machine.reset();
  machine.hostGpus(null);
  voiceIs({ State: "restarting", code: 1, restarts: 2, HostConfig: UNLESS_STOPPED });
  const said = asked();
  assert.equal((await post("/install", RECOGNITION_ONLY)).status, 200);
  await machine.settle();
  assert.equal(said.stops, 1, "stopped first, as a running one is");
  assert.equal(machine.made().length, 1);
  assert.deepEqual([machine.voice()!.Labels["pithagoras.voice-recipe"], machine.voice()!.State], ["none+whisper:base", "running"]);
  assert.equal((await state()).state, "running");
});

test("the person's Stop is Docker's stop, which unless-stopped keeps: it stays stopped, and a failure stopped is not said to be started again", async () => {
  machine.reset();
  voiceIs({ State: "running", HostConfig: UNLESS_STOPPED });
  const said = asked();
  assert.equal((await post("/stop")).status, 200);
  assert.equal(said.stops, 1);
  assert.equal((await state()).state, "stopped");
  assert.deepEqual([machine.voice()!.State, said.starts()], ["exited", 0]);

  // Stopped between Docker's tries: Docker counted them, and no longer tries.
  machine.reset();
  voiceIs({ State: "restarting", code: 1, restarts: 2, HostConfig: UNLESS_STOPPED });
  const ended = asked();
  assert.equal((await post("/stop")).status, 200);
  const now = await state();
  assert.deepEqual([ended.stops, machine.voice()!.State, ended.starts()], [1, "exited", 0]);
  assert.deepEqual([now.state, now.error, now.retrying], ["failed", "Voice setup or service exited. Review the log, then retry.", false]);
});
