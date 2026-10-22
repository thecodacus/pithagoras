import { setTimeout as delay } from "node:timers/promises";
import { endpoints, type TtsEngine } from "../engines";
import { DEFAULT_KOKORO_VOICE, isKokoroVoice } from "../kokoro-voices";
import * as service from "./service";
import { DEFAULT_INSTRUCTION, setting } from "./store";

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
  form.set("language", setting("language") ?? "auto");
  // audio.cpp names the model it loaded; Whisper.cpp has one model, and is sent none.
  if (listen.model) form.set("model", listen.model);
  const upstream = await fetch(listen.url, { method: "POST", body: form, redirect: "error", signal });
  if (!upstream.ok) throw new Error(`${name} returned HTTP ${upstream.status}`);
  const result = (await upstream.json()) as { text?: unknown };
  if (typeof result.text !== "string") throw new Error(`${name} returned no transcript`);
  return result.text;
}

const ENGINE_NAMES: Record<TtsEngine, string> = { breeze: "Breeze", chatterbox: "Chatterbox", kokoro: "Kokoro" };

/** What the engine is asked for one phrase, in `voice` where it speaks with that, else in the voice set on the page. */
function speechRequest(engine: TtsEngine, text: string, voice: string | undefined): Record<string, unknown> {
  if (engine === "kokoro") {
    // Kokoro has no streaming mode in audio.cpp either, and is fast enough that a phrase is ready soon after it is asked
    // for. The voice names the language, so none is sent.
    return { model: "kokoro", input: text, voice: isKokoroVoice(voice) ? voice : setting("kokoroVoice") ?? DEFAULT_KOKORO_VOICE, speed: setting("speed") ?? 1, response_format: "wav", options: { seed: "42" } };
  }
  // Chatterbox clones a speaker; it has no designed or built-in voice.
  if (engine === "chatterbox") throw new Error("Chatterbox speaks with a reference clone: choose a voice with a recording on the Voice service page");
  return {
    model: "breeze",
    input: text,
    stream: true,
    stream_format: "audio",
    response_format: "pcm",
    options: { instruction: setting("instruction") ?? DEFAULT_INSTRUCTION, guidance_scale: String(setting("cfgScale") ?? 4), seed: "42", stream_frames_per_event: "8", stream_lookahead_margin: "4" },
  };
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
 * application/octet-stream), and Kokoro's WAV as the engine answers it, which voice mode checks.
 */
export async function speak(text: string, voice: string | undefined, signal: AbortSignal): Promise<Response> {
  const choice = engines();
  const speech = endpoints(choice).speak;
  if (!speech) throw new Error("This installation has no speech synthesis: replies are not spoken");
  const name = ENGINE_NAMES[speech.engine];
  const upstream = await postSpeech(speech.url, speechRequest(speech.engine, text, voice), signal);
  if (!upstream.ok) throw new Error(`${name} returned HTTP ${upstream.status}`);
  if (speech.engine !== "breeze") return upstream;
  const type = upstream.headers.get("content-type");
  if (!type?.startsWith("audio/pcm") && !type?.startsWith("application/octet-stream")) throw new Error("Expected PCM audio from the Breeze API");
  const rate = upstream.headers.get("x-sample-rate");
  if (rate && rate !== "24000") throw new Error(`Unsupported Breeze sample rate: ${rate}`);
  return new Response(upstream.body, { headers: { "content-type": "audio/pcm", "x-sample-rate": "24000" } });
}
