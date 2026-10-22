import { useEffect, useRef, useState } from "react";
import type { TtsChoice } from "../engines";
import { CHATTERBOX_LANGUAGES, INPUT_LANGUAGES } from "../languages";
import { NUMBER_PACK_LANGUAGES } from "../numbers";
import { Select, languageName, portal, t } from "../portal";
import type { Speech } from "../server/store";
import type { Voice } from "../server/voices";
import { api } from "./api";
import { VoiceLibrary, kokoroVoiceOptions, voicePresets } from "./VoiceLibrary";

/**
 * How the voice service speaks, for the speech engine its container is built for (`engine`): the voice it speaks with
 * where an agent has none of its own, from the library for Breeze and Chatterbox and Kokoro's own for Kokoro, each
 * engine's settings, and the language spoken to it, which recognition uses whatever the engine. Saved with one button,
 * after the descriptions edited in the library.
 */
export function YourVoice({ engine, onError }: { engine: TtsChoice; onError: (message: string) => void }) {
  const page = portal.locale.use();
  const [speech, setSpeech] = useState<Speech | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  // Something changed here that Save has not stored: in no other place, so closing Settings asks first.
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  portal.ui.useUnsavedDraft(edited && !busy);
  // A voice's description is stored on its own; Save stores the edited ones along with the settings.
  const pendingDescriptions = useRef<(() => Promise<void>) | null>(null);
  // Nothing of it can be drawn without the settings, so their failure is said where it would be.
  const [readFailed, setReadFailed] = useState<string | null>(null);
  const read = () => Promise.all([api.speech(), voicePresets()]).then(([speech, voices]) => { setReadFailed(null); setSpeech(speech); setVoices(voices); }, (e) => setReadFailed((e as Error).message));
  useEffect(() => { void read(); }, []);
  if (!speech) return readFailed ? <portal.ui.LoadFailed error={readFailed} onRetry={read} /> : null;
  const update = (patch: Partial<Speech>) => { setSpeech({ ...speech, ...patch }); setSaved(false); setEdited(true); };
  const speaks = engine !== "none";
  const breeze = engine === "breeze", chatterbox = engine === "chatterbox", kokoro = engine === "kokoro";
  // Chatterbox is told a language, and has no detection mode.
  const languages = chatterbox ? INPUT_LANGUAGES.filter(([code]) => CHATTERBOX_LANGUAGES.includes(code)) : INPUT_LANGUAGES;
  const save = async () => {
    setBusy(true);
    try {
      await pendingDescriptions.current?.();
      setSpeech(await api.setSpeech(speech));
      setEdited(false);
      setSaved(true);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <section className="mt-4 border-t border-line pt-4 space-y-4">
    <div><h3 className="text-sm font-medium">{t("Your voice")}</h3>{speaks && <p className="mt-1 text-xs text-fg-muted">{t("Choose how your assistant sounds.")}</p>}</div>
    {!speaks && <p role="status" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">{t("This installation has no speech synthesis: replies are not spoken. Dictation, which only listens, works.")}</p>}
    {kokoro && <>
      <div className="block text-xs text-fg-muted">{t("Speaking voice")}<Select aria-label={t("Speaking voice")} className="mt-1.5 w-full" value={speech.kokoroVoice} onChange={(kokoroVoice) => update({ kokoroVoice })} options={kokoroVoiceOptions(page)} /></div>
      <p className="text-xs text-fg-faint">{t("Kokoro speaks with its own voices and reads the text in the language of the voice. Your voice library is kept for the other engines.")}</p>
    </>}
    {(breeze || chatterbox) && <VoiceLibrary voices={voices} setVoices={setVoices} value={speech.voice} onChange={(voice) => update({ voice })} onError={onError} onPending={(save) => { pendingDescriptions.current = save; if (save) setSaved(false); }} />}
    {breeze && speech.voice === "design" && <label className="block text-xs text-fg-muted">{t("Describe the speaking voice")}<input className={`mt-1.5 ${portal.ui.classes.input}`} value={speech.instruction} onChange={(e) => update({ instruction: e.target.value })} /></label>}
    <div className="block text-xs text-fg-muted">{t("Input language")}<Select aria-label={t("Input language")} size="sm" className="mt-1.5 w-full" value={speech.language} onChange={(language) => update({ language })} options={languages.map(([value, label]) => ({ value, label: value === "auto" ? t("Auto-detect") : languageName(page, value, label) }))} /></div>
    <p className="text-xs text-fg-faint">{t("Choosing your language improves recognition on short turns.")}</p>
    {kokoro && <div className="block text-xs text-fg-muted">{t("Speaking speed")}<Select<number> aria-label={t("Speaking speed")} size="sm" className="mt-1.5 w-full" value={speech.speed} onChange={(speed) => update({ speed })} options={[{ value: 0.85, label: t("Slower") }, { value: 1, label: t("Normal") }, { value: 1.15, label: t("Faster") }]} /></div>}
    {chatterbox && <div className="block text-xs text-fg-muted">{t("Speech delivery")}<Select<number> aria-label={t("Speech delivery")} size="sm" className="mt-1.5 w-full" value={speech.exaggeration} onChange={(exaggeration) => update({ exaggeration })} options={[{ value: 0.3, label: t("Calm"), hint: t("Flatter delivery") }, { value: 0.5, label: t("Natural"), hint: t("As recorded") }, { value: 0.8, label: t("Expressive"), hint: t("Stronger emotion") }]} /></div>}
    {breeze && <div className="block text-xs text-fg-muted">{t("Speech generation")}<Select<number> aria-label={t("Speech generation")} size="sm" className="mt-1.5 w-full" value={speech.cfgScale} onChange={(cfgScale) => update({ cfgScale })} options={[{ value: 1, label: t("Fast"), hint: t("Lighter voice guidance") }, { value: 4, label: t("Expressive"), hint: t("Stronger voice guidance") }]} /></div>}
    {chatterbox && <p className="text-xs text-fg-faint">{t("Chatterbox speaks your input language and clones the selected reference voice; it has no designed voice.")} {NUMBER_PACK_LANGUAGES.includes(speech.language) ? t("Numbers are written out before synthesis so they are spoken correctly.") : t("Numbers stay as digits in this language, which Chatterbox reads unreliably.")}</p>}
    {chatterbox && voices.find((voice) => voice.id === speech.voice)?.kind !== "clone" && <p role="alert" className="text-xs text-danger">{t("Choose a voice with a recording above: Chatterbox cannot speak with a designed voice.")}</p>}
    <div className="flex justify-end">
      <button disabled={busy} className="rounded-lg bg-accent px-4 py-2 text-xs font-medium text-black disabled:opacity-40" onClick={() => void save()}>{busy ? t("Saving…") : saved ? t("Saved") : t("Save voice settings")}</button>
    </div>
  </section>;
}
