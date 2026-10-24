import { useState } from "react";
import { LuPlus, LuTrash2, LuUpload } from "react-icons/lu";
import { api, type LibraryVoice } from "./api";
import { reference } from "./audio";
import { Select, portal, t } from "../portal";

/** Where Chatterbox-TTS-Server takes a recording, beside its speech synthesis URL (server/server-store.ts): none where the URL does not end so. */
export function uploadUrlOf(ttsUrl: string | undefined): string | undefined {
  const at = ttsUrl?.replace(/\/v1\/audio\/speech$/, "/upload_reference");
  return at && at !== ttsUrl ? at : undefined;
}

/**
 * The voice library, with custom voices on, for the speech engine the server runs: Breeze speaks with voices designed
 * from a description and with clones of a recording, Chatterbox with clones alone, from the recording, and no
 * description. Each voice is opened in the list to rename it, change its description (for Breeze), play a clone's
 * recording or delete it; each change is stored at once, on its own, not with the page's Save. Where the server keeps
 * voices of its own (`stores`, Chatterbox-TTS-Server at `ttsUrl`), each clone says whether it is stored there, and is
 * stored again on demand. The voices are the page's (`voices`), as its Voice menu lists them too.
 */
export function VoiceLibrary({ voices, setVoices, engine, stores, ttsUrl, onError }: { voices: LibraryVoice[]; setVoices: (update: (voices: LibraryVoice[]) => LibraryVoice[]) => void; engine: "breeze" | "chatterbox"; stores: boolean; ttsUrl?: string; onError: (message: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const sorted = (list: LibraryVoice[]) => [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const replace = (row: LibraryVoice) => setVoices((list) => sorted(list.map((v) => (v.id === row.id ? row : v))));
  // Chatterbox clones: its designed voices are kept, for Breeze, and not shown.
  const shown = engine === "breeze" ? voices : voices.filter((voice) => voice.kind === "clone");
  const kept = voices.length - shown.length;
  return (
    <div className="space-y-2">
      {shown.length === 0 && !adding && <p className="text-xs text-fg-faint">{t("No voices yet.")}</p>}
      {shown.length > 0 && (
        <ul className="space-y-1">
          {shown.map((voice) => (
            <li key={voice.id} className="rounded-lg border border-line">
              <button type="button" aria-expanded={open === voice.id} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs" onClick={() => setOpen((current) => (current === voice.id ? null : voice.id))}>
                <span className="truncate text-fg">{voice.name}</span>
                <span className="shrink-0 text-fg-faint">{voice.kind === "clone" ? t("Reference clone") : t("Designed voice")}</span>
              </button>
              {open === voice.id && (
                <VoiceEditor
                  voice={voice}
                  describes={engine === "breeze"}
                  stores={stores}
                  ttsUrl={ttsUrl}
                  onSaved={replace}
                  onDeleted={() => {
                    setVoices((list) => list.filter((v) => v.id !== voice.id));
                    setOpen(null);
                  }}
                  onError={onError}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {kept > 0 && <p className="text-xs text-fg-faint">{t("Designed voices are kept for Breeze, and not offered to Chatterbox, which clones.")}</p>}
      <button type="button" className="inline-flex items-center gap-1.5 rounded-lg bg-accent/12 px-3 py-1.5 text-xs text-accent" onClick={() => setAdding((v) => !v)}>
        <LuPlus />
        {adding ? t("Close new voice") : t("Add voice")}
      </button>
      {adding && (
        <div className="space-y-3 rounded-lg border border-line bg-surface p-3">
          <AddVoiceForm
            designs={engine === "breeze"}
            onAdded={({ storeError, ...row }) => {
              setVoices((list) => sorted([...list, row]));
              setAdding(false);
              setOpen(row.id);
              if (storeError) onError(storeError);
            }}
            onError={onError}
          />
        </div>
      )}
    </div>
  );
}

/**
 * A voice opened in the list: its name, and its description where the engine reads one, saved together; a clone's
 * recording and its words, and where the server keeps voices, whether it is stored there; Delete.
 */
function VoiceEditor({ voice, describes, stores, ttsUrl, onSaved, onDeleted, onError }: { voice: LibraryVoice; describes: boolean; stores: boolean; ttsUrl?: string; onSaved: (voice: LibraryVoice) => void; onDeleted: () => void; onError: (message: string) => void }) {
  const page = portal.locale.use();
  const [name, setName] = useState(voice.name);
  const [instruction, setInstruction] = useState(voice.instruction);
  const [busy, setBusy] = useState(false);
  const changed = name.trim() !== voice.name || (describes && instruction.trim() !== voice.instruction);
  // Typed here and not saved is in no other place: closing Settings asks first.
  portal.ui.useUnsavedDraft(changed && !busy);
  const field = `mt-1 ${portal.ui.classes.inputSmall}`;
  const storing = stores && voice.kind === "clone";
  const storedHere = !!voice.stored && voice.stored.url === uploadUrlOf(ttsUrl);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      const row = await api.updateVoice(voice.id, { ...(name.trim() !== voice.name ? { name } : {}), ...(describes && instruction.trim() !== voice.instruction ? { instruction } : {}) });
      setName(row.name);
      setInstruction(row.instruction);
      onSaved(row);
    });
  const store = () => run(async () => onSaved(await api.storeVoice(voice.id)));
  const remove = () =>
    run(async () => {
      // Chatterbox-TTS-Server has no way to delete a voice it stored.
      const message = voice.stored ? t("The speech server keeps its copy, {file}: Chatterbox-TTS-Server cannot delete one. Remove it from the server's reference audio folder.", { file: `${voice.id}.wav` }) : undefined;
      if (!(await portal.ui.confirm({ title: t("Delete voice “{name}”?", { name: voice.name }), message, confirmLabel: t("Delete"), danger: true, deletes: true }))) return;
      await api.deleteVoice(voice.id);
      onDeleted();
    });
  return (
    <div className="space-y-2 border-t border-line p-3">
      <label className="block text-xs text-fg-muted">
        {t("Voice name")}
        <input className={field} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </label>
      {describes ? (
        <label className="block text-xs text-fg-muted">
          {t("Voice description")}
          <textarea className={field} value={instruction} maxLength={1000} onChange={(e) => setInstruction(e.target.value)} />
        </label>
      ) : (
        <p className="text-xs text-fg-faint">{t("Chatterbox speaks from the recording alone: it takes no description.")}</p>
      )}
      {voice.kind === "clone" && (
        <>
          <audio aria-label={t("Voice reference preview")} controls preload="none" className="h-9 w-full" src={api.voiceAudio(voice.id)} />
          <p className="text-xs text-fg-faint">{voice.transcript}</p>
        </>
      )}
      {storing && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className={`text-xs ${storedHere ? "text-fg-muted" : "text-warn"}`}>
            {storedHere ? t("Stored on the speech server {when}", { when: new Date(voice.stored!.at).toLocaleString(page) }) : t("Not stored on this speech server yet: it is stored before the first phrase in it.")}
          </p>
          <button type="button" disabled={busy} className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs disabled:opacity-40" onClick={() => void store()}>
            <LuUpload />
            {storedHere ? t("Store again") : t("Store on the speech server")}
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" disabled={busy || !changed || !name.trim() || (describes && !instruction.trim())} className="rounded-lg bg-accent/12 px-3 py-1.5 text-xs text-accent disabled:opacity-40" onClick={() => void save()}>
          {busy ? t("Saving voice…") : t("Save voice")}
        </button>
        <button type="button" disabled={busy} className="inline-flex items-center gap-1 text-xs text-danger" onClick={() => void remove()}>
          <LuTrash2 />
          {t("Delete voice")}
        </button>
      </div>
    </div>
  );
}

const FIRST_INSTRUCTION = "Speak clearly and naturally.";

/**
 * A new voice for the library: a clone from a recording, or, where the engine designs voices (`designs`, Breeze), one
 * designed from a description. A clone for Chatterbox is given no description: it keeps the first one, for Breeze.
 */
function AddVoiceForm({ designs, onAdded, onError }: { designs: boolean; onAdded: (voice: LibraryVoice & { storeError?: string }) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [chosen, setKind] = useState<"design" | "clone">("clone");
  const kind = designs ? chosen : "clone";
  const [instruction, setInstruction] = useState(FIRST_INSTRUCTION);
  const [transcript, setTranscript] = useState("");
  const [file, setFile] = useState<File | null>(null);
  // The words of a recording, a name and a chosen file are in no other place: Settings asks before it closes over them.
  portal.ui.useUnsavedDraft(!busy && (!!name.trim() || !!transcript.trim() || !!file || instruction !== FIRST_INSTRUCTION));
  const field = `mt-1 ${portal.ui.classes.inputSmall}`;
  const add = async () => {
    setBusy(true);
    try {
      const audio = kind === "clone" ? await reference(file!) : undefined;
      const row = await api.addVoice({ name, kind, instruction: designs ? instruction : FIRST_INSTRUCTION, ...(kind === "clone" ? { transcript, audio } : {}) });
      setName("");
      setTranscript("");
      setFile(null);
      onAdded(row);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <label className="block text-xs">
        {t("Voice name")}
        <input className={field} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </label>
      {designs && (
        <div className="block text-xs">
          {t("Voice type")}
          <Select<"design" | "clone">
            aria-label={t("Voice type")}
            className="mt-1.5 w-full"
            value={kind}
            onChange={setKind}
            options={[
              { value: "clone", label: t("Clone from a recording") },
              { value: "design", label: t("Design from a description") },
            ]}
          />
        </div>
      )}
      {designs && (
        <label className="block text-xs">
          {t("Voice description")}
          <textarea className={field} value={instruction} maxLength={1000} onChange={(e) => setInstruction(e.target.value)} />
        </label>
      )}
      {kind === "clone" && (
        <>
          <label className="block text-xs">
            {t("Reference recording")}
            <input type="file" accept="audio/*" className={field} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <p className="text-xs text-fg-faint">{t("Use a clean 1–30 second clip with one speaker and no background music. Browser-supported audio formats are converted automatically.")}</p>
          <label className="block text-xs">
            {t("Exact words in the recording")}
            <textarea className={field} value={transcript} maxLength={4000} onChange={(e) => setTranscript(e.target.value)} />
          </label>
        </>
      )}
      {!designs && <p className="text-xs text-fg-faint">{t("Chatterbox speaks from the recording alone: it takes no description.")}</p>}
      <button type="button" disabled={busy || !name.trim() || !instruction.trim() || (kind === "clone" && (!file || !transcript.trim()))} className="rounded-lg bg-accent/12 px-3 py-1.5 text-xs text-accent disabled:opacity-40" onClick={() => void add()}>
        {busy ? t("Saving voice…") : t("Save new voice")}
      </button>
    </div>
  );
}
