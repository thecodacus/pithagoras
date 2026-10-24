import type { ProvidedVoice } from "@pithagoras/extension-api/server";
import type { Settings, SpeechServer } from "./store";
import { findVoice, listVoices, voiceAudio, type Voice } from "./voices";

/**
 * What the speech server is, and so how a phrase is sent to it. While custom voices are off it is a server with fixed
 * voices, whatever is saved, and each phrase is sent as it was before custom voices were.
 *
 *   fixed                  a server with voices of its own, such as Kokoro: OpenAI's speech request,
 *                          `{ model, input, voice, response_format: "wav" }`, with a voice id of `voices`; the library
 *                          is not offered
 *   breeze-audiocpp        Breeze-TTS-2 in audio.cpp, sent what the voice service sends it
 *                          (extensions/voice/src/server/speech.ts, audio.cpp v0.9.0, 795c45fb): JSON, streamed 24 kHz
 *                          PCM, a voice's description as `options.instruction`, a clone's recording as `voice_ref` with
 *                          its words as `reference_text`
 *   breeze-tts             Breeze-TTS's own service (`python -m breeze_infer.api`, github.com/breezeblue-ai/breeze-tts):
 *                          a form of `text`, `instruction`, `cfg_scale` and `seed`, a clone's recording as the file
 *                          `ref_audio` with its words as `ref_text`, answered with streamed 24 kHz PCM
 *   chatterbox-audiocpp    Chatterbox in audio.cpp, sent what the voice service sends it: a WAV in the input language,
 *                          cloned from the recording sent as `voice_ref` with each phrase
 *   chatterbox-tts-server  Chatterbox-TTS-Server (github.com/devnen/Chatterbox-TTS-Server): a clone's recording stored
 *                          on the server once (server-store.ts), and then OpenAI's request naming it as `voice`
 *
 * Breeze speaks with every voice of the library, Chatterbox with its clones; neither is offered the server's ids, which
 * are for a server with fixed voices. The voice service's own settings go with Breeze and Chatterbox as they start:
 * guidance 4 (Expressive) and exaggeration 0.5 (Natural), and a fixed seed, so that a voice made of a description is the
 * same voice from phrase to phrase.
 */

/** What the speech server is now: one with fixed voices while custom voices are off. */
export const serverOf = (s: Pick<Settings, "customVoices" | "speechServer">): SpeechServer => (s.customVoices && s.speechServer) || "fixed";

/** The engine the speech server runs, of the three a page can choose. */
export const engineOf = (s: Pick<Settings, "customVoices" | "speechServer">): "fixed" | "breeze" | "chatterbox" => {
  const server = serverOf(s);
  return server === "fixed" ? "fixed" : server.startsWith("breeze") ? "breeze" : "chatterbox";
};

/** What an agent's voice is chosen from: the ids listed on the page for fixed voices, else the library's voices the engine speaks with. */
export function offered(s: Pick<Settings, "voices" | "customVoices" | "speechServer">): ProvidedVoice[] {
  const engine = engineOf(s);
  if (engine === "fixed") return [...(s.voices ?? [])];
  return listVoices()
    .filter((voice) => engine === "breeze" || voice.kind === "clone")
    .map(({ id, name }) => ({ id, name }));
}

/** A request for one phrase: a JSON body or a form, and whether it is answered with raw 24 kHz PCM as it speaks rather than a WAV. */
export type SpeechRequest = { json: Record<string, unknown>; pcm: boolean } | { form: FormData; pcm: boolean };

/** A clone's recording, as audio.cpp takes it inline. */
const voiceRef = (id: string) => ({ type: "base64", data: voiceAudio(id).toString("base64") });

/** The name a clone is stored under on Chatterbox-TTS-Server, which names a reference by its file. */
export const storedName = (voice: Pick<Voice, "id">) => `${voice.id}.wav`;

/**
 * What the speech server is sent for one phrase in `voice`, an id of `offered` (the caller's to make sure of), or none
 * for the server's own. A clone for Chatterbox-TTS-Server is sent by the name it is stored under, which the caller
 * stores it under first.
 */
export function speechRequest(s: Settings, text: string, voice: string | undefined): SpeechRequest {
  const server = serverOf(s);
  const model = s.ttsModel;
  if (server === "fixed") return { json: { model, input: text, voice, response_format: "wav" }, pcm: false };
  const added = voice === undefined ? undefined : findVoice(voice);
  if (server === "breeze-audiocpp") {
    const json: Record<string, unknown> = {
      model,
      input: text,
      stream: true,
      stream_format: "audio",
      response_format: "pcm",
      options: { instruction: added?.instruction, guidance_scale: "4", seed: "42", stream_frames_per_event: "8", stream_lookahead_margin: "4" },
    };
    if (added?.kind === "clone") Object.assign(json, { voice_ref: voiceRef(added.id), reference_text: added.transcript });
    return { json, pcm: true };
  }
  if (server === "breeze-tts") {
    const form = new FormData();
    form.set("text", text);
    if (added) form.set("instruction", added.instruction);
    form.set("cfg_scale", "4");
    form.set("seed", "42");
    if (added?.kind === "clone") {
      form.set("ref_audio", new Blob([new Uint8Array(voiceAudio(added.id))], { type: "audio/wav" }), "reference.wav");
      form.set("ref_text", added.transcript);
    }
    return { form, pcm: true };
  }
  if (server === "chatterbox-audiocpp") {
    const json: Record<string, unknown> = { model, input: text, language: s.language, response_format: "wav", options: { exaggeration: "0.5", seed: "42" } };
    if (added) json.voice_ref = voiceRef(added.id);
    return { json, pcm: false };
  }
  return { json: { model, input: text, voice: added && storedName(added), language: s.language, response_format: "wav" }, pcm: false };
}
