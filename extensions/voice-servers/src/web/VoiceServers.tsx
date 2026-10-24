import { useCallback, useEffect, useState } from "react";
import { api, type LibraryVoice, type ServerSettings, type ServerVoice, type ShownSettings, type SpeechServer } from "./api";
import { VoiceLibrary } from "./VoiceLibrary";
import { Select, msg, portal, t } from "../portal";

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

/** The speech engines a server can run, as the page names them: one with fixed voices, Breeze or Chatterbox. */
type Engine = "fixed" | "breeze" | "chatterbox";
const ENGINES: { value: Engine; label: string }[] = [
  { value: "fixed", label: msg("Fixed voices, such as Kokoro") },
  { value: "breeze", label: msg("Breeze-TTS-2") },
  { value: "chatterbox", label: msg("Chatterbox") },
];
/** How a server of each engine that takes voices of your own is reached, the first as it is chosen, and what the page says of it (server/requests.ts). */
const SERVERS: Record<Exclude<Engine, "fixed">, { value: SpeechServer; label: string; note: string }[]> = {
  breeze: [
    { value: "breeze-audiocpp", label: msg("audio.cpp"), note: msg("Sent as the voice service sends Breeze-TTS-2 in audio.cpp: designed voices and clones, streamed as they are spoken. Load Breeze with mode streaming.") },
    { value: "breeze-tts", label: msg("Breeze-TTS's own server"), note: msg("Sent as Breeze-TTS's own server takes it: the description, and a clone's recording with its words, with each phrase, streamed as it is spoken.") },
  ],
  chatterbox: [
    { value: "chatterbox-audiocpp", label: msg("audio.cpp: the recording with each phrase"), note: msg("Sent as the voice service sends Chatterbox in audio.cpp: the clone's recording goes with each phrase, spoken in the input language above, which Chatterbox needs.") },
    { value: "chatterbox-tts-server", label: msg("Chatterbox-TTS-Server: voices stored on it"), note: msg("Each clone is stored on Chatterbox-TTS-Server once, as a reference file, and each phrase names it. The server needs a speech synthesis model in each request: any name, such as chatterbox.") },
  ],
};

/** What the speech server is, as saved: one with fixed voices while custom voices are off. */
const serverOf = (saved: ShownSettings): SpeechServer => (saved.customVoices && saved.speechServer) || "fixed";
const engineOf = (server: SpeechServer): Engine => (server === "fixed" ? "fixed" : server.startsWith("breeze") ? "breeze" : "chatterbox");

/** The voices of the library the engine speaks with: none for fixed voices, the clones for Chatterbox, all of them for Breeze. */
function offeredOf(engine: Engine, library: LibraryVoice[]): LibraryVoice[] {
  if (engine === "fixed") return [];
  return engine === "chatterbox" ? library.filter((voice) => voice.kind === "clone") : library;
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
 * listens and speaks through them. The addresses belong together, so they are saved together, with one Save. Custom
 * voices, off until they are switched on, are below: their switch, what the speech server is and the voice library each
 * change at once. With them on and a server that is Breeze or Chatterbox, the Voice menu has the library's voices that
 * engine speaks with in place of the ids listed for a server with fixed voices, which are kept and not shown.
 */
export function VoiceServers() {
  portal.locale.use();
  const { ui } = portal;
  const { input: inputCls, codeArea, ghost, primary } = ui.classes;
  const [saved, setSaved] = useState<ShownSettings | null>(null);
  // Read with the settings where custom voices are on, so the Voice menu has their voices before it is drawn.
  const [library, setLibrary] = useState<LibraryVoice[]>([]);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [draft, setDraft] = useState<Form | null>(null);
  const [busy, setBusy] = useState<"saving" | "reading" | "choosing" | "custom" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  // What is typed here and not saved is in no other place.
  ui.useUnsavedDraft(!!draft);
  const load = useCallback(() => {
    setLoadFailed(null);
    api
      .settings()
      .then(async (shown) => {
        if (shown.customVoices) setLibrary(await api.voices());
        setSaved(shown);
      })
      .catch((e) => setLoadFailed((e as Error).message));
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
  const server = serverOf(saved);
  const engine = engineOf(server);
  const added = offeredOf(engine, library);
  // A voice taken out of the list, or no longer offered, is no longer the one chosen.
  const voice = (engine === "fixed" ? voices : added).some((v) => v.id === form.voice) ? form.voice : "";
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
  // Custom voices and their form, each stored at once; the voices are read as they are switched on.
  const custom = (change: () => Promise<ShownSettings>) =>
    run("custom", async () => {
      const shown = await change();
      if (shown.customVoices && !saved.customVoices) setLibrary(await api.voices());
      setSaved(shown);
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
            options={[
              { value: "", label: t("The server's own") },
              ...(engine === "fixed" ? voices.map((v) => ({ value: v.id, label: v.name })) : added.map((v) => ({ value: v.id, label: v.name, text: v.name, hint: v.kind === "clone" ? t("Reference clone") : t("Designed voice") }))),
            ]}
          />
        </div>
        {engine === "fixed" && (
          <label className="text-xs text-fg-muted sm:col-span-2">
            {t("Voices")}
            <textarea rows={4} value={form.voices} onChange={(e) => edit({ voices: e.target.value })} spellCheck={false} className={`${codeArea} mt-1`} />
            <span className="mt-1 block text-xs text-fg-faint">{t("One voice per line: its id, or id = Name.")}</span>
          </label>
        )}
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          {engine === "fixed" && (
            <button type="button" disabled={!form.ttsUrl.trim()} className={ghost} onClick={() => void readVoices()}>
              {t("Read voices from the server")}
            </button>
          )}
          <button type="button" disabled={!draft} className={primary} onClick={() => void save()}>
            {busy === "saving" ? t("Saving…") : t("Save")}
          </button>
          {justSaved && <span role="status" className="text-xs text-fg-muted">{t("Saved")}</span>}
        </div>
      </fieldset>
      <section className="space-y-3 border-t border-line pt-4">
        <ui.SwitchRow
          title={t("Custom voices")}
          detail={t("Voices of your own, cloned from a recording or designed from a description, for a speech server that takes them.")}
          on={!!saved.customVoices}
          onChange={(on) => void custom(() => api.setCustomVoices(on))}
          disabled={!!busy}
        />
        {saved.customVoices && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="text-xs text-fg-muted">
                {t("Speech engine")}
                <Select<Engine>
                  aria-label={t("Speech engine")}
                  size="sm"
                  className="mt-1 w-full"
                  disabled={!!busy}
                  value={engine}
                  onChange={(chosen) => void custom(() => api.setSpeechServer(chosen === "fixed" ? "fixed" : SERVERS[chosen][0].value))}
                  options={ENGINES.map(({ value, label }) => ({ value, label: t(label) }))}
                />
              </div>
              {engine !== "fixed" && (
                <div className="text-xs text-fg-muted">
                  {t("Reached through")}
                  <Select<SpeechServer>
                    aria-label={t("Reached through")}
                    size="sm"
                    className="mt-1 w-full"
                    disabled={!!busy}
                    value={server}
                    onChange={(chosen) => void custom(() => api.setSpeechServer(chosen))}
                    options={SERVERS[engine].map(({ value, label }) => ({ value, label: t(label) }))}
                  />
                </div>
              )}
            </div>
            <p className="text-xs text-fg-faint">
              {engine === "fixed" ? t("A server with fixed voices, such as Kokoro, speaks with its own voice ids, listed under Voices above: custom voices are not offered for it.") : t(SERVERS[engine].find((f) => f.value === server)!.note)}
            </p>
            {engine !== "fixed" && (
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-fg-muted">{t("Your voices")}</h3>
                <VoiceLibrary voices={library} setVoices={setLibrary} engine={engine} stores={server === "chatterbox-tts-server"} ttsUrl={saved.ttsUrl} onError={setFailure} />
                <p className="text-xs text-fg-faint">{t("Your voices are kept in this portal and sent only to the speech synthesis URL's server, with each phrase spoken in them or to be stored there.")}</p>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
