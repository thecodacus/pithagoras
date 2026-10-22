import type { VoiceProvider } from "@pithagoras/extension-api/server";
import { settings } from "./store";

/**
 * The person's own servers as voice mode is offered them (`portal.voice.provide`): what they offer, read from the
 * settings alone, and each recording and phrase sent as OpenAI's audio API takes it, with no key.
 */

/** Recognition while there is an address for it; speech too while there is one for that. No server is asked. */
export function state() {
  const { sttUrl, ttsUrl, voices } = settings();
  return sttUrl ? { speaks: !!ttsUrl, voices: voices ?? [] } : undefined;
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
 * One phrase, as the speech server says it in `voice` where it is one of the voices listed, else in the voice chosen
 * on the page, else in its own. It is asked for WAV, which says its own rate, and its answer is labelled so whatever
 * the server calls it: voice mode reads it whole and plays it where it is mono 24 kHz 16-bit, and refuses it otherwise.
 */
async function speak(text: string, { voice, signal }: { voice?: string; signal: AbortSignal }): Promise<globalThis.Response> {
  const { ttsUrl, ttsModel, voices, voice: own } = settings();
  if (!ttsUrl) throw new Error("No speech synthesis address is set");
  const body = { model: ttsModel, input: text, voice: voices?.some((v) => v.id === voice) ? voice : own, response_format: "wav" };
  const upstream = await fetch(ttsUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal });
  if (!upstream.ok) throw new Error(`The speech server answered HTTP ${upstream.status}`);
  return new Response(upstream.body, { headers: { "content-type": "audio/wav" } });
}

export const provider: VoiceProvider = { label: "Voice servers", state, transcribe, speak };
