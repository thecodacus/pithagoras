import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api, type VoiceConfig } from "../api";
import { confirmDialog } from "./ConfirmDialog";
import { Select } from "./Select";
import { translate } from "../extensions/strings";
import { t } from "../i18n";

/**
 * The voice an agent speaks with in voice mode: one of the voices voice mode's
 * source offers, or "" for the source's own choice. A voice it no longer offers
 * is shown as it is, not changed. Voices are added on the source's own page in
 * Settings, which the link under the menu opens in place of this page, and
 * which closes back to it; the menu reads the voices as it is drawn. Nothing at
 * all while voice mode has no source, or one that only listens.
 *
 * `unsaved` is what the dialog it is in has changed and not saved, which the
 * link asks about first, as closing the dialog does.
 */
export function VoicePicker({ value, onChange, unsaved }: { value: string; onChange: (voice: string) => void; unsaved: boolean }) {
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const navigate = useNavigate();
  const { pathname, search } = useLocation();

  useEffect(() => {
    void api.voice().then(setConfig, () => {});
  }, []);

  if (!config?.enabled || config.speech === false) return null;

  const source = config.label ? translate(config.provider, config.label) : config.provider;
  const sourcePage = `/settings/x/${encodeURIComponent(config.provider)}`;
  // Where Settings goes back to as it closes.
  const back = { from: pathname + search };

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
        <Link
          to={sourcePage}
          state={back}
          className="mt-1.5 inline-block text-xs text-accent hover:underline"
          onClick={(e) => {
            if (!unsaved) return;
            e.preventDefault();
            void confirmDialog({ title: t("Discard your changes?"), message: t("What you changed here has not been saved."), confirmLabel: t("Discard"), danger: true }).then(
              (discard) => discard && navigate(sourcePage, { state: back }),
            );
          }}
        >
          {t("Add a voice in {source}", { source })}
        </Link>
      )}
    </div>
  );
}
