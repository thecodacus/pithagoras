import { storedName } from "./requests";
import { markStored, voiceAudio, type Voice } from "./voices";

/**
 * A clone stored on the speech server, for Chatterbox-TTS-Server (github.com/devnen/Chatterbox-TTS-Server), which keeps
 * reference recordings of its own and speaks with one named by its file as `voice`. A clone is stored there as a form
 * with its WAV as `files`, named `<id>.wav`, at `/upload_reference`, the server's own route beside
 * `/v1/audio/speech`: when it is added, when the page asks, and before a phrase where it is not stored at the speech
 * synthesis URL in use, or no longer there (the server answers 404 for a voice it does not have). The server keeps a
 * file of a name it has already, and lists it as uploaded all the same; it has no way to delete one.
 */

/** Where the server takes a recording, beside a speech synthesis URL that ends in /v1/audio/speech. */
export function uploadUrl(ttsUrl: string | undefined): string {
  const at = ttsUrl?.replace(/\/v1\/audio\/speech$/, "/upload_reference");
  if (!ttsUrl || at === ttsUrl) throw new Error("Chatterbox-TTS-Server takes a recording at /upload_reference beside a speech synthesis URL that ends in /v1/audio/speech");
  return at!;
}

/** Whether the clone is stored on the server at `ttsUrl`, as far as Voice servers knows. */
export function storedAt(voice: Voice, ttsUrl: string | undefined): boolean {
  try {
    return voice.stored?.url === uploadUrl(ttsUrl);
  } catch {
    return false;
  }
}

/** Stores a clone's recording on the server at `ttsUrl`, under the name a phrase names it by, and keeps when. */
export async function storeOnServer(voice: Voice, ttsUrl: string | undefined, signal: AbortSignal): Promise<Voice> {
  if (voice.kind !== "clone") throw new Error("Only a clone has a recording to store on the speech server");
  const at = uploadUrl(ttsUrl);
  const form = new FormData();
  form.set("files", new Blob([new Uint8Array(voiceAudio(voice.id))], { type: "audio/wav" }), storedName(voice));
  const answer = await fetch(at, { method: "POST", body: form, redirect: "error", signal });
  const said = (await answer.json().catch(() => undefined)) as { uploaded_files?: unknown; errors?: { error?: unknown }[] } | undefined;
  const listed = Array.isArray(said?.uploaded_files) && said.uploaded_files.includes(storedName(voice));
  if (!answer.ok || !listed) {
    const error = said?.errors?.find((e) => typeof e?.error === "string")?.error;
    throw new Error(`The speech server did not store “${voice.name}”: ${typeof error === "string" ? error : answer.ok ? "it did not list it as stored" : `HTTP ${answer.status}`}`);
  }
  return markStored(voice.id, at);
}
