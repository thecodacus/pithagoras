import { setTimeout as delay } from "node:timers/promises";
import { endpoints, type TtsEngine } from "../engines";
import { isKokoroVoice } from "../kokoro-voices";
import { spokenNumbers } from "../numbers";
import * as service from "./service";
import { speech } from "./store";
import { findVoice, voiceAudio } from "./voices";

/**
 * How the voice service listens and speaks for voice mode (`transcribe` and `speak` of its provider): what each engine
 * of the container is sent, at its address on the portal's loopback (`endpoints`), and what it answers.
 */

/** The engines of the running container, or the error voice mode is given where there are none. */
function engines() {
  const choice = service.serving();
  if (!choice) throw new Error("The voice service is not running");
  return choice;
}

/** The words said in a WAV, as the container's recognition hears them, in the language set (`auto` detects it). */
export async function transcribe(wav: Buffer, signal: AbortSignal): Promise<string> {
  const choice = engines();
  const listen = endpoints(choice).listen;
  const name = choice.asr === "whisper" ? "Whisper" : "Qwen3-ASR";
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "recording.wav");
  form.set("response_format", "json");
  form.set("language", speech().language);
  // audio.cpp names the model it loaded; Whisper.cpp has one model, and is sent none.
  if (listen.model) form.set("model", listen.model);
  const upstream = await fetch(listen.url, { method: "POST", body: form, redirect: "error", signal });
  if (!upstream.ok) throw new Error(`${name} returned HTTP ${upstream.status}`);
  const result = (await upstream.json()) as { text?: unknown };
  if (typeof result.text !== "string") throw new Error(`${name} returned no transcript`);
  return result.text;
}

const ENGINE_NAMES: Record<TtsEngine, string> = { breeze: "Breeze", chatterbox: "Chatterbox", kokoro: "Kokoro" };

/** A clone's recording as the engines take it. */
const reference = (id: string) => ({ type: "base64", data: voiceAudio(id).toString("base64") });

/**
 * What the engine is asked for one phrase, in `voice` where it speaks with that, else in the voice set on the page.
 * Breeze speaks with the designed voice or a voice of the library, Chatterbox with a clone of the library, and Kokoro
 * with one of its own.
 */
function speechRequest(engine: TtsEngine, text: string, voice: string | undefined): Record<string, unknown> {
  const said = speech();
  const asked = voice ? findVoice(voice) : undefined;
  if (engine === "kokoro") {
    // Kokoro has no streaming mode in audio.cpp either, and is fast enough that a phrase is ready soon after it is asked
    // for. The voice names the language, so none is sent.
    return { model: "kokoro", input: text, voice: isKokoroVoice(voice) ? voice : said.kokoroVoice, speed: said.speed, response_format: "wav", options: { seed: "42" } };
  }
  if (engine === "chatterbox") {
    // Chatterbox clones a speaker; it has no designed or built-in voice.
    const clone = asked?.kind === "clone" ? asked : findVoice(said.voice);
    if (clone?.kind !== "clone") throw new Error("Chatterbox speaks with a reference clone: choose a voice with a recording on the Voice service page");
    // No streaming mode in audio.cpp either: one phrase, one WAV. It reads digits unreliably, so numbers are written out.
    return { model: "chatterbox", input: spokenNumbers(text, said.language), language: said.language, response_format: "wav", options: { exaggeration: String(said.exaggeration), seed: "42" }, voice_ref: reference(clone.id) };
  }
  // A voice of the library, else the designed one; one chosen on the page that has gone since is the designed one too.
  const own = voice === "design" ? undefined : asked ?? findVoice(said.voice);
  const request: Record<string, unknown> = {
    model: "breeze",
    input: text,
    stream: true,
    stream_format: "audio",
    response_format: "pcm",
    options: { instruction: own?.instruction ?? said.instruction, guidance_scale: String(said.cfgScale), seed: "42", stream_frames_per_event: "8", stream_lookahead_margin: "4" },
  };
  if (own?.kind === "clone") Object.assign(request, { voice_ref: reference(own.id), reference_text: own.transcript });
  return request;
}

/** Asks the engine, and keeps asking while it is busy with a phrase before (409): until it answers otherwise, or `signal` ends. */
async function postSpeech(url: string, request: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
  while (true) {
    const upstream = await fetch(url, { method: "POST", body: JSON.stringify(request), headers: { "Content-Type": "application/json" }, redirect: "error", signal });
    if (upstream.status !== 409) return upstream;
    // Cancelling a phrase may leave the engine finishing its current GPU operation.
    await upstream.body?.cancel();
    await delay(750, undefined, { signal });
  }
}

/**
 * One phrase, as voice mode is answered with it: Breeze's 24 kHz PCM as it streams, labelled as PCM (audio.cpp calls it
 * application/octet-stream), and Kokoro's and Chatterbox's WAV as the engine answers it, which voice mode checks.
 */
export async function speak(text: string, voice: string | undefined, signal: AbortSignal): Promise<Response> {
  const choice = engines();
  const speaker = endpoints(choice).speak;
  if (!speaker) throw new Error("This installation has no speech synthesis: replies are not spoken");
  const name = ENGINE_NAMES[speaker.engine];
  const upstream = await postSpeech(speaker.url, speechRequest(speaker.engine, text, voice), signal);
  if (!upstream.ok) throw new Error(`${name} returned HTTP ${upstream.status}`);
  if (speaker.engine !== "breeze") return upstream;
  const type = upstream.headers.get("content-type");
  if (!type?.startsWith("audio/pcm") && !type?.startsWith("application/octet-stream")) throw new Error("Expected PCM audio from the Breeze API");
  const rate = upstream.headers.get("x-sample-rate");
  if (rate && rate !== "24000") throw new Error(`Unsupported Breeze sample rate: ${rate}`);
  return new Response(upstream.body, { headers: { "content-type": "audio/pcm", "x-sample-rate": "24000" } });
}
