import { useCallback, useEffect, useState } from "react";
import { api, type ServerSettings, type ServerVoice } from "./api";
import { Select, portal, t } from "../portal";

/** The page's copy of the settings, as typed, before they are saved. */
interface Form {
  sttUrl: string;
  sttModel: string;
  language: string;
  dictationUrl: string;
  dictationModel: string;
  ttsUrl: string;
  ttsModel: string;
  /** One voice per line: its id, or `id = Name`. */
  voices: string;
  voice: string;
}

/** A voice as a line of the list: its id alone where its name is the same. */
const lineOf = (voice: ServerVoice) => (voice.name === voice.id ? voice.id : `${voice.id} = ${voice.name}`);

/** The voices as typed: one a line, empty lines left out, and a name left out being the id. */
function voicesOf(typed: string): ServerVoice[] {
  return typed.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const at = line.indexOf("=");
    const id = (at < 0 ? line : line.slice(0, at)).trim();
    return { id, name: (at < 0 ? "" : line.slice(at + 1).trim()) || id };
  });
}

const formOf = (saved: ServerSettings): Form => ({
  sttUrl: saved.sttUrl ?? "",
  sttModel: saved.sttModel ?? "",
  language: saved.language ?? "",
  dictationUrl: saved.dictationUrl ?? "",
  dictationModel: saved.dictationModel ?? "",
  ttsUrl: saved.ttsUrl ?? "",
  ttsModel: saved.ttsModel ?? "",
  voices: (saved.voices ?? []).map(lineOf).join("\n"),
  voice: saved.voice ?? "",
});

/**
 * Voice servers' page in Settings: the addresses of the person's own speech recognition and speech synthesis servers,
 * the models each is sent, the language spoken, the voices the speech server speaks with, and whether voice mode
 * listens and speaks through them. The addresses belong together, so they are saved together, with one Save.
 */
export function VoiceServers() {
  portal.locale.use();
  const { ui } = portal;
  const { input: inputCls, codeArea, ghost, primary } = ui.classes;
  const [saved, setSaved] = useState<(ServerSettings & { chosen: boolean }) | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [draft, setDraft] = useState<Form | null>(null);
  const [busy, setBusy] = useState<"saving" | "reading" | "choosing" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  // What is typed here and not saved is in no other place.
  ui.useUnsavedDraft(!!draft);
  const load = useCallback(() => {
    setLoadFailed(null);
    api.settings().then(setSaved, (e) => setLoadFailed((e as Error).message));
  }, []);
  useEffect(load, [load]);

  if (loadFailed) return <ui.LoadFailed error={loadFailed} onRetry={load} />;
  if (!saved) return <ui.RowsSkeleton rows={4} label={t("Loading…")} />;

  const form = draft ?? formOf(saved);
  const edit = (patch: Partial<Form>) => {
    setDraft({ ...form, ...patch });
    setJustSaved(false);
  };
  const voices = voicesOf(form.voices);
  // A voice taken out of the list is no longer the one chosen.
  const voice = voices.some((v) => v.id === form.voice) ? form.voice : "";
  const run = async (what: NonNullable<typeof busy>, work: () => Promise<void>) => {
    setBusy(what);
    try {
      await work();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const save = () =>
    run("saving", async () => {
      setSaved(await api.save({ ...form, voices, voice }));
      setDraft(null);
      setJustSaved(true);
    });
  // Into the list, for the person to look over and save.
  const readVoices = () =>
    run("reading", async () => {
      const listed = await api.serverVoices(form.ttsUrl);
      edit({ voices: listed.voices.map(lineOf).join("\n") });
    });
  const choose = (chosen: boolean) =>
    run("choosing", async () => {
      const answer = await api.setChosen(chosen);
      setSaved((current) => current && { ...current, chosen: answer.chosen });
    });

  const field = (key: keyof Form, label: string, placeholder?: string, hint?: string, wide?: boolean) => (
    <label className={`text-xs text-fg-muted${wide ? " sm:col-span-2" : ""}`}>
      {label}
      <input value={form[key]} onChange={(e) => edit({ [key]: e.target.value })} placeholder={placeholder} spellCheck={false} autoComplete="off" className={`${inputCls} mt-1 font-mono text-xs`} />
      {hint && <span className="mt-1 block text-xs text-fg-faint">{hint}</span>}
    </label>
  );

  return (
    <div className="space-y-4">
      {failure && <ui.ErrorBanner onClose={() => setFailure(null)}>{failure}</ui.ErrorBanner>}
      {/* The page's head, drawn by Settings, has the extension's name and mark already. */}
      <p className="text-xs text-fg-faint">{t("Speech recognition and speech synthesis on servers you run, spoken to as OpenAI's audio API is. The speech server has to answer 24 kHz mono WAV.")}</p>
      <div className="flex flex-wrap items-center gap-2">
        {saved.chosen ? (
          <>
            <p role="status" className="text-xs text-accent">{t("In use for voice mode")}</p>
            <button type="button" disabled={!!busy} className="rounded-lg border border-line px-3 py-1.5 text-xs disabled:opacity-40" onClick={() => void choose(false)}>
              {t("Stop using")}
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={!!busy || !saved.sttUrl} className="rounded-lg bg-accent/12 px-3 py-1.5 text-xs text-accent disabled:opacity-40" onClick={() => void choose(true)}>
              {t("Use for voice mode")}
            </button>
            {!saved.sttUrl && <p className="text-xs text-fg-faint">{t("Set a speech recognition address first")}</p>}
          </>
        )}
      </div>
      <fieldset disabled={!!busy} className="grid gap-3 sm:grid-cols-2">
        {field("sttUrl", t("Speech recognition URL"), "http://127.0.0.1:8178/inference", undefined, true)}
        {field("sttModel", t("Speech recognition model"), "whisper-1")}
        {field("language", t("Input language"), t("Empty: the server detects it"))}
        {field("dictationUrl", t("Dictation endpoint"), t("Empty uses the speech recognition URL above"), t("The address the microphone button of the message box sends its recordings to. Voice mode keeps using the one above, so dictation can run on another service."), true)}
        {field("dictationModel", t("Dictation model"), t("Empty uses the speech recognition model above"), t("The model the microphone button of the message box transcribes with. Voice mode keeps using the one above, so a conversation can have the quick model and dictation the accurate one."), true)}
        {field("ttsUrl", t("Speech synthesis URL"), "http://127.0.0.1:8880/v1/audio/speech", undefined, true)}
        {field("ttsModel", t("Speech synthesis model"), "kokoro")}
        <div className="text-xs text-fg-muted">
          {t("Voice")}
          <Select<string>
            aria-label={t("Voice")}
            size="sm"
            className="mt-1 w-full"
            value={voice}
            onChange={(chosen) => edit({ voice: chosen })}
            options={[{ value: "", label: t("the server's own") }, ...voices.map((v) => ({ value: v.id, label: v.name }))]}
          />
        </div>
        <label className="text-xs text-fg-muted sm:col-span-2">
          {t("Voices")}
          <textarea rows={4} value={form.voices} onChange={(e) => edit({ voices: e.target.value })} spellCheck={false} className={`${codeArea} mt-1`} />
          <span className="mt-1 block text-xs text-fg-faint">{t("One voice per line: its id, or id = Name.")}</span>
        </label>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <button type="button" disabled={!form.ttsUrl.trim()} className={ghost} onClick={() => void readVoices()}>
            {t("Read voices from the server")}
          </button>
          <button type="button" disabled={!draft} className={primary} onClick={() => void save()}>
            {busy === "saving" ? t("Saving…") : t("Save")}
          </button>
          {justSaved && <span role="status" className="text-xs text-fg-muted">{t("Saved")}</span>}
        </div>
      </fieldset>
    </div>
  );
}
