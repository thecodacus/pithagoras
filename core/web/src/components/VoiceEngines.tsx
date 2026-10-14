import { useEffect } from "react";
import { Select } from "./Select";
import { ASR_MODELS, DEFAULT_CHOICE, TTS_ENGINES, asrDevice, asrDevices, asrOption, canonicalChoice, cpuSlow, fitOn, fitRam, ramNeeded, sameChoice, speechCpuSeconds, speechSlow, ttsDevice, ttsDevices, usesGpu, vramNeeded, type AsrDevice, type Device, type Fit, type TtsChoice, type VoiceChoice } from "../../../server/src/voice-engines";
import type { VoiceHardware } from "../api";
import { formatNumber, t } from "../i18n";
import { btnCls } from "./SettingsUi";

const gib = (mib: number) => formatNumber(mib / 1024, { maximumFractionDigits: 1 });
const asrKey = (c: Pick<VoiceChoice, "asr" | "asrModel">) => `${c.asr}:${c.asrModel}`;
const tone = (level: Fit) => level === "fits" ? "text-fg-faint" : level === "tight" ? "text-warn" : "text-danger";

/**
 * Which speech engine and which recognition model, on which device, the managed voice container is built for,
 * with what the GPU and the host can hold. `picked` is null while the choice is left to the install, which takes
 * what fits; once there is a container, the choice shown is the one it was built for.
 *
 * Without a GPU everything runs on the CPU: Kokoro for speech, or no speech at all, and the others say why.
 */
export function VoiceEngines({ installed, fresh, busy, hardware, picked: pickedNow, onPick, onGpu }: {
  installed: VoiceChoice | undefined; fresh: boolean; busy: boolean; hardware: VoiceHardware | null;
  picked: VoiceChoice | null; onPick: (choice: VoiceChoice | null) => void;
  /** The GPU chosen by UUID, or "" to leave it to the portal. Not part of the engines picked: it takes effect at once. */
  onGpu: (uuid: string) => void;
}) {
  const gpu = hardware?.gpus.find((g) => g.index === hardware.selected);
  const cpuOnly = hardware?.cpuOnly === true;
  // No GPU, and nothing installed that uses one: only what runs on the CPU can be chosen.
  const gpuOff = cpuOnly && (!installed || !usesGpu(installed));
  // A choice moved off the GPU: a speech engine that runs on the CPU too goes there, any other is none, and recognition follows.
  const offGpu = (c: VoiceChoice): VoiceChoice => canonicalChoice(ttsDevices(c.tts).includes("cpu") ? { ...c, ttsDevice: "cpu" } : { ...c, tts: "none" });
  // A pick made before the check answered may put something on a GPU that the host has none of.
  const stale = gpuOff && pickedNow !== null && usesGpu(pickedNow);
  const picked = stale ? offGpu(pickedNow!) : pickedNow;
  useEffect(() => { if (stale) onPick(installed && sameChoice(picked!, installed) ? null : picked); }, [stale]);
  const host = hardware?.host;
  const shown = picked ?? installed ?? hardware?.suggestion ?? DEFAULT_CHOICE;
  const auto = fresh && picked === null;
  // The installed choice is running there: the memory it holds is what the card and the host show as taken, so a verdict on it would blame the service itself.
  const kept = !!installed && picked === null;
  const fit = fitOn(shown, gpu, hardware?.reserveMiB ?? 0);
  const ramFit = fitRam(shown, host);
  const suggestion = hardware?.suggestion;
  // Only a card with a UUID can be chosen: that is what names it for good.
  const choosable = hardware?.gpus.filter((g) => g.uuid) ?? [];
  const device = asrDevice(shown);
  const deviceChoices = asrDevices(shown);
  const speechDevice = ttsDevice(shown);
  const speechDevices = gpuOff ? ttsDevices(shown.tts).filter((d) => d === "cpu") : ttsDevices(shown.tts);
  const threads = host?.threads;
  const pick = (patch: Partial<VoiceChoice>) => {
    // Without a GPU everything is on the CPU, whatever the choice was.
    const merged = canonicalChoice({ ...shown, ...patch });
    const next = gpuOff ? offGpu(merged) : merged;
    // Back to what is installed is no change at all.
    onPick(installed && sameChoice(next, installed) ? null : next);
  };
  const noSpeech = { value: "none" as const, label: t("No speech synthesis"), hint: t("Dictation only: replies are not spoken") };
  const kokoroCpu = { value: "kokoro" as const, label: TTS_ENGINES.kokoro.label, hint: t("Built-in voices in eight languages, runs on the CPU") };
  // With no GPU, Kokoro on the CPU and recognition alone can always be chosen, also where a speech engine is installed that has lost its GPU;
  // and an installation of recognition alone keeps being shown as what it is, also when a GPU has turned up and speech could be added.
  const ttsOptions: { value: TtsChoice; label: string; hint: string }[] = gpuOff
    ? [kokoroCpu, noSpeech]
    : [
      { value: "breeze", label: TTS_ENGINES.breeze.label, hint: t("English and Chinese, streams while it speaks") },
      { value: "chatterbox", label: TTS_ENGINES.chatterbox.label, hint: t("Nineteen languages, clones a reference voice") },
      { value: "kokoro", label: TTS_ENGINES.kokoro.label, hint: t("Built-in voices in eight languages, the least GPU memory") },
      ...(cpuOnly || installed?.tts === "none" ? [noSpeech] : []),
    ];
  const suggest = suggestion && !sameChoice(suggestion, shown) && <> <button type="button" className={btnCls} onClick={() => onPick(installed && sameChoice(suggestion, installed) ? null : suggestion)}>{t("Use the suggestion")}</button></>;
  return <div className="space-y-3 rounded-lg border border-line p-3">
    <div><p className="text-xs font-medium">{t("Speech engines")}</p><p className="mt-1 text-xs text-fg-faint">{t("Pick how the voice speaks and listens. Pithagoras checks your GPU and tells you what fits.")}</p></div>
    {cpuOnly && <p role="alert" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">{hardware?.unusable?.length
      ? t("GPU detected: {name}, but Docker cannot use it. Install the NVIDIA Container Toolkit and restart Docker. Until then everything runs on the CPU: Kokoro can speak, the other speech engines need the GPU.", { name: hardware.unusable[0] })
      : t("No GPU detected. Everything runs on the CPU: Kokoro can speak, the other speech engines need a GPU.")}</p>}
    {fresh && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={auto} disabled={busy} onChange={(e) => onPick(e.target.checked ? null : shown)} />{t("Choose for me, based on my GPU")}</label>}
    <div className="block text-xs text-fg-muted">{t("Speech synthesis engine")}
      <Select<TtsChoice> aria-label={t("Speech synthesis engine")} size="sm" className="mt-1.5 w-full" disabled={auto || busy} value={shown.tts}
        onChange={(tts) => pick({ tts })} options={ttsOptions} /></div>
    {gpuOff && <p className="text-xs text-fg-faint">{t("Breeze and Chatterbox need a GPU: on a CPU, Breeze takes about {breeze} seconds to compute each second of speech and Chatterbox about {chatterbox}, too slow for conversation. Kokoro takes about {kokoro}, measured on 8 threads of a desktop CPU like the others.", { breeze: formatNumber(TTS_ENGINES.breeze.cpuSecondsPerSecond), chatterbox: formatNumber(TTS_ENGINES.chatterbox.cpuSecondsPerSecond), kokoro: formatNumber(TTS_ENGINES.kokoro.cpuSecondsPerSecond) })}</p>}
    {speechDevice && <div className="block text-xs text-fg-muted">{t("Speech synthesis runs on")}
      <Select<Device> aria-label={t("Speech synthesis runs on")} size="sm" className="mt-1.5 w-full" disabled={auto || busy || speechDevices.length < 2} value={speechDevice}
        onChange={(next) => pick({ ttsDevice: next })}
        options={[
          { value: "cpu", label: t("CPU"), hint: ttsDevices(shown.tts).includes("cpu") ? t("No GPU memory, uses CPU threads and about {ram} GiB of memory", { ram: gib(TTS_ENGINES[shown.tts as keyof typeof TTS_ENGINES].ramMiB ?? 0) }) : t("{engine} runs on the GPU only", { engine: TTS_ENGINES[shown.tts as keyof typeof TTS_ENGINES].label }), disabled: !speechDevices.includes("cpu") },
          { value: "gpu", label: t("GPU"), hint: t("Faster, uses GPU memory"), disabled: !speechDevices.includes("gpu") },
        ]} /></div>}
    <div className="block text-xs text-fg-muted">{t("Speech recognition engine")}
      <Select aria-label={t("Speech recognition engine")} size="sm" className="mt-1.5 w-full" disabled={auto || busy} value={asrKey(shown)}
        onChange={(key) => { const o = ASR_MODELS.find((m) => asrKey({ asr: m.asr, asrModel: m.model }) === key)!; pick({ asr: o.asr, asrModel: o.model }); }}
        options={ASR_MODELS.map((o) => ({ value: asrKey({ asr: o.asr, asrModel: o.model }), label: o.label,
          hint: o.asr === "whisper" ? t("CPU only, about {ram} GiB of memory", { ram: gib(o.ramMiB) })
            : t("About {ram} GiB of memory on the CPU, or {vram} GiB on the GPU", { ram: gib(o.ramMiB), vram: gib(o.vramMiB) }) }))} /></div>
    <div className="block text-xs text-fg-muted">{t("Speech recognition runs on")}
      <Select<AsrDevice> aria-label={t("Speech recognition runs on")} size="sm" className="mt-1.5 w-full" disabled={auto || busy || deviceChoices.length < 2} value={device}
        onChange={(next) => pick({ asrDevice: next })}
        options={[
          { value: "cpu", label: t("CPU"), hint: shown.asr === "whisper" ? t("Whisper always runs on the CPU") : t("Saves GPU memory, uses CPU threads") },
          { value: "gpu", label: t("GPU"), hint: t("Faster, uses GPU memory"), disabled: !deviceChoices.includes("gpu") },
        ]} /></div>
    {choosable.length > 1 && usesGpu(shown) && <div className="block text-xs text-fg-muted">{t("GPU")}
      <Select aria-label={t("GPU")} size="sm" className="mt-1.5 w-full" disabled={busy} value={hardware!.chosen} onChange={onGpu}
        options={[{ value: "", label: t("Automatic"), hint: t("VOICE_GPU if set, else the most free memory when installing or rebuilding; a restart keeps the card") },
          ...choosable.map((g) => ({ value: g.uuid!, label: `GPU ${g.index} · ${g.name}`,
            hint: g.totalMiB === null || g.freeMiB === null ? undefined : t("{free} of {total} GiB free", { free: gib(g.freeMiB), total: gib(g.totalMiB) }) }))]} />
      {installed && <p className="mt-1.5 text-fg-faint">{t("Changing the GPU restarts voice and keeps your models.")}</p>}
    </div>}
    {hardware && (gpu
      ? <p className="text-xs text-fg-faint">{gpu.totalMiB === null ? t("GPU detected: {name}", { name: gpu.name }) : t("GPU detected: {name}, {total} GiB, {free} GiB free", { name: gpu.name, total: gib(gpu.totalMiB), free: gib(gpu.freeMiB ?? 0) })}</p>
      : !cpuOnly && fresh && <p className="text-xs text-fg-faint">{t("GPU not checked yet. It is checked while installing, and you are told if your choice does not fit.")}</p>)}
    {host?.totalMiB != null && (cpuOnly || (shown.asr === "qwen3-asr" && device === "cpu") || speechDevice === "cpu") && <p className="text-xs text-fg-faint">{t("This host: {threads} CPU threads, {total} GiB of memory, {free} GiB free", { threads: host.threads, total: gib(host.totalMiB), free: gib(host.freeMiB ?? 0) })}</p>}
    {auto
      ? <p className="text-xs text-fg-faint">{(gpu || cpuOnly) && suggestion
        ? t("Suggested for this host: {tts} with {asr}.", { tts: suggestion.tts === "none" ? t("no speech synthesis") : `${TTS_ENGINES[suggestion.tts].label}${ttsDevice(suggestion) === "cpu" ? ` ${t("on the CPU")}` : ""}`, asr: `${asrOption(suggestion)?.label ?? suggestion.asrModel}${suggestion.asr === "qwen3-asr" && asrDevice(suggestion) === "cpu" && ttsDevice(suggestion) !== "cpu" ? ` ${t("on the CPU")}` : ""}` })
        : t("The install picks what fits your GPU.")}</p>
      : !kept && <>
        {usesGpu(shown) && gpu && <p role={fit === "too-large" ? "alert" : "status"} className={`text-xs ${tone(fit)}`}>
          {fit === "too-large" ? t("Needs about {gib} GiB of GPU memory, more than this GPU has.", { gib: gib(vramNeeded(shown)) })
            : fit === "tight" ? t("Needs about {gib} GiB of GPU memory. The card is big enough, but other programs use part of it right now.", { gib: gib(vramNeeded(shown)) })
              : t("Needs about {gib} GiB of GPU memory. Fits.", { gib: gib(vramNeeded(shown)) })}
          {fit === "too-large" && suggest}
        </p>}
        {ramNeeded(shown) > 0 && host && ramFit !== "unknown" && (cpuOnly || shown.asr === "qwen3-asr" || speechDevice === "cpu") && <p role={ramFit === "too-large" ? "alert" : "status"} className={`text-xs ${tone(ramFit)}`}>
          {ramFit === "too-large" ? t("Needs about {gib} GiB of memory on the CPU, more than this host has.", { gib: gib(ramNeeded(shown)) })
            : ramFit === "tight" ? t("Needs about {gib} GiB of memory on the CPU. The host has less free right now.", { gib: gib(ramNeeded(shown)) })
              : t("Needs about {gib} GiB of memory on the CPU. Fits.", { gib: gib(ramNeeded(shown)) })}
          {ramFit === "too-large" && suggest}
        </p>}
        {host && cpuSlow(shown, host.threads) && <p role="status" className="text-xs text-warn">{t("This host has {threads} CPU threads: recognition on the CPU may be slower than the speaker.", { threads: host.threads })}</p>}
        {threads !== undefined && speechDevice === "cpu" && <p role="status" className={`text-xs ${speechSlow(shown, threads) ? "text-warn" : "text-fg-faint"}`}>{speechSlow(shown, threads)
          ? t("This host has {threads} CPU threads: speech on the CPU may take longer to make than to say.", { threads })
          : t("On this host's {threads} CPU threads, each second of speech takes about {seconds} seconds to make.", { threads, seconds: formatNumber(speechCpuSeconds(shown, threads)!, { maximumFractionDigits: 2 }) })}</p>}
      </>}
    {installed && picked && <p className="text-xs text-fg-faint">{t("Switching engines recreates the voice container. Downloaded models are kept.")}</p>}
  </div>;
}
