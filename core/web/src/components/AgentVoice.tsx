import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type VoiceConfig } from "../api";
import { Select } from "./Select";
import { translate } from "../extensions/strings";
import { t } from "../i18n";

/**
 * The voice an agent speaks with in voice mode: one of the voices voice mode's
 * source offers, or "" for the source's own choice. A voice it no longer offers
 * is shown as it is, not changed. Voices are added on the source's own page,
 * which the link under the menu opens. Nothing at all while voice mode has no
 * source, or one that only listens.
 */
export function VoicePicker({ value, onChange }: { value: string; onChange: (voice: string) => void }) {
  const [config, setConfig] = useState<VoiceConfig | null>(null);

  // Read again as Settings closes, so that a voice added there is listed.
  useEffect(() => {
    const read = () => void api.voice().then(setConfig, () => {});
    read();
    window.addEventListener("voice-config-changed", read);
    return () => window.removeEventListener("voice-config-changed", read);
  }, []);

  if (!config?.enabled || config.speech === false) return null;

  const source = config.label ? translate(config.provider, config.label) : config.provider;

  return (
    <div className="mt-4">
      <div className="text-xs text-fg-muted">
        {t("Voice")}
        <Select
          className="mt-1 w-full"
          aria-label={t("Voice")}
          value={value}
          onChange={onChange}
          options={[
            { value: "", label: t("As {source} chooses", { source }) },
            // Only the source's own voices are named in its translations: one the person named is shown as they named it.
            ...config.voices.map((v) => ({ value: v.id, label: v.builtIn ? translate(config.provider, v.name) : v.name, text: v.name })),
            ...(value && !config.voices.some((v) => v.id === value) ? [{ value, label: value, hint: t("Not offered now") }] : []),
          ]}
        />
      </div>
      {/* Its page is there while its server half runs. */}
      {config.label && (
        <Link to={`/settings/x/${encodeURIComponent(config.provider)}`} className="mt-1.5 inline-block text-xs text-accent hover:underline">
          {t("Add a voice in {source}", { source })}
        </Link>
      )}
    </div>
  );
}
