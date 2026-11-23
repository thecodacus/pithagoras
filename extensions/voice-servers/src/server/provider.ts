import { setTimeout as delay } from "node:timers/promises";
import type { VoiceProvider } from "@pithagoras/extension-api/server";
import { offered, serverOf, speechRequest, type SpeechRequest } from "./requests";
import { storedAt, storeOnServer } from "./server-store";
import { RAW_RATE_DEFAULT, settings } from "./store";
import { findVoice } from "./voices";

/**
 * The person's own servers as voice mode is offered them (`portal.voice.provide`): what they offer, read from the
 * settings alone, each recording sent as OpenAI's audio API takes it, and each phrase as the speech server takes it
 * (requests.ts): as OpenAI's API takes it while custom voices are off. No key is sent.
 */

/**
 * Recognition while there is an address for it; speech too while there is one for that, with the voices it offers: the
 * ones listed on the page, or with custom voices on, those of the library the speech engine speaks with. No server is
 * asked.
 */
export function state() {
  const s = settings();
  return s.sttUrl ? { speaks: !!s.ttsUrl, voices: offered(s) } : undefined;
}

/**
 * The words said in `wav`, as the recognition server hears them. Dictation goes to its own address and model where
 * they are set, and to voice mode's otherwise, each on its own: a dictation model with no address of its own goes to
 * voice mode's address.
 */
async function transcribe(wav: Buffer, { purpose, signal }: { purpose: "voice" | "dictation"; signal: AbortSignal }): Promise<string> {
  const { sttUrl, sttModel, dictationUrl, dictationModel, language } = settings();
  const dictation = purpose === "dictation";
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "recording.wav");
  form.set("response_format", "json");
  // OpenAI's needs one, such as whisper-1; whisper.cpp has one model and ignores it.
  const model = (dictation && dictationModel) || sttModel;
  if (model) form.set("model", model);
  // Left out, the server detects it.
  if (language) form.set("language", language);
  // Voice mode asks only while state() offers recognition, which is while there is an address for it.
  const upstream = await fetch((dictation && dictationUrl) || sttUrl!, { method: "POST", body: form, redirect: "error", signal });
  if (!upstream.ok) throw new Error(`The speech recognition server answered HTTP ${upstream.status}`);
  const { text } = ((await upstream.json().catch(() => undefined)) ?? {}) as { text?: unknown };
  if (typeof text !== "string") throw new Error("The speech recognition server gave no transcript");
  return text;
}

/**
 * Asks the speech server, and where `retryBusy`, keeps asking while it is busy with a phrase before (409), as the voice
 * service does with audio.cpp and the portal did with Breeze-TTS: cancelling a phrase may leave it finishing what it was
 * doing. Until it answers otherwise, or `signal` ends.
 */
async function post(url: string, request: SpeechRequest, retryBusy: boolean, signal: AbortSignal): Promise<globalThis.Response> {
  while (true) {
    const init = "json" in request ? { headers: { "content-type": "application/json" }, body: JSON.stringify(request.json) } : { body: request.form };
    const upstream = await fetch(url, { method: "POST", ...init, redirect: "error", signal });
    if (upstream.status !== 409 || !retryBusy) return upstream;
    await upstream.body?.cancel();
    await delay(750, undefined, { signal });
  }
}

/**
 * One phrase, as the speech server says it in `voice` where it is one of the voices offered, else in the voice chosen
 * on the page, else in its own. A WAV is asked for, which says its own rate, and its answer is labelled so whatever the
 * server calls it: voice mode reads it whole and plays it at that rate where it is mono or stereo, 16-bit integer or
 * 32-bit float, and refuses it otherwise. Breeze streams instead, raw PCM (audio.cpp calls it application/octet-stream),
 * passed on as it comes. So is the answer of any server that says `audio/pcm`. Raw PCM has no header: its rate is the one
 * the server says (an `x-sample-rate` header, or a `rate=` parameter of the content type), else the one set for raw audio.
 *
 * A clone spoken with by Chatterbox-TTS-Server is stored there first where it is not stored at this address yet, and
 * again where the server answers that it does not have it (404), as after it was installed anew.
 */
async function speak(text: string, { voice, signal }: { voice?: string; signal: AbortSignal }): Promise<globalThis.Response> {
  const s = settings();
  if (!s.ttsUrl) throw new Error("No speech synthesis address is set");
  const server = serverOf(s);
  const chosen = offered(s).some((v) => v.id === voice) ? voice : s.voice;
  const request = speechRequest(s, text, chosen);
  const send = () => post(s.ttsUrl!, request, server === "breeze-audiocpp" || server === "breeze-tts" || server === "chatterbox-audiocpp", signal);
  const stored = server === "chatterbox-tts-server" && chosen ? findVoice(chosen) : undefined;
  if (stored && !storedAt(stored, s.ttsUrl)) await storeOnServer(stored, s.ttsUrl, signal);
  let upstream = await send();
  if (stored && upstream.status === 404) {
    await upstream.body?.cancel();
    await storeOnServer(stored, s.ttsUrl, signal);
    upstream = await send();
  }
  if (!upstream.ok) throw new Error(`The speech server answered HTTP ${upstream.status}`);
  const type = upstream.headers.get("content-type");
  if (!request.pcm && !type?.startsWith("audio/pcm")) return new Response(upstream.body, { headers: { "content-type": "audio/wav" } });
  if (!type?.startsWith("audio/pcm") && !type?.startsWith("application/octet-stream")) {
    await upstream.body?.cancel();
    throw new Error(`The speech server answered ${type || "no type"}, not the PCM Breeze streams`);
  }
  // Only the rate is passed on, so the core cannot see a channel count of the type: mono is checked here.
  const channels = /;\s*channels\s*=\s*"?([^";\s]*)/i.exec(type)?.[1];
  if (channels !== undefined && channels !== "1") {
    await upstream.body?.cancel();
    throw new Error(`The speech server answered audio with ${channels} channels: voice mode plays mono`);
  }
  // Voice mode checks that it is a rate it plays.
  const rate = upstream.headers.get("x-sample-rate") ?? /;\s*rate\s*=\s*"?([^";\s]*)/i.exec(type)?.[1] ?? String(s.rawSampleRate ?? RAW_RATE_DEFAULT);
  return new Response(upstream.body, { headers: { "content-type": "audio/pcm", "x-sample-rate": rate } });
}

export const provider: VoiceProvider = { label: "Voice servers", state, transcribe, speak };
