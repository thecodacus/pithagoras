import { useEffect, useState, type FormEvent } from "react";
import { LuCheck, LuChevronLeft, LuChevronRight, LuLayers, LuPlus, LuRefreshCw, LuTrash2 } from "react-icons/lu";
import { api, ApiError, type CustomMode } from "../api";
import { t } from "../i18n";
import { useCached } from "../settings-cache";
import { useFlash } from "../use-flash";
import { confirmDialog } from "./ConfirmDialog";
import { useUnsavedDraft } from "./Modal";
import { ModelChoice } from "./ModelChoice";
import { EffortPicker, Empty, Field, LoadFailed, Section, SwitchRow, btnCls, gridCls, inputCls, primaryCls } from "./SettingsUi";
import { ToolSwitches } from "./ToolSwitches";

/**
 * Settings → Modes: the person's own ways a chat can work, offered above the message box of a chat that has said
 * nothing yet, after Standard and Code mode. A list, and a page each: what the mode is called and says of itself,
 * what is said to the agent in its chats, what they start on, and their tools.
 */
export function ModesPanel({ onError }: { onError: (e: string) => void }) {
  const [modes, setModes] = useState<CustomMode[] | null>(null);
  // Why the first read failed: "No modes of your own yet" would say that there are none.
  const [failed, setFailed] = useState<string | null>(null);
  // A portal whose chats cannot be put in modes says so, in place of the list (as ToolSwitches does).
  const [refusal, setRefusal] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    try {
      const r = await api.customModes();
      setFailed(null);
      setModes(r.modes);
    } catch (e) {
      if (e instanceof ApiError && e.body.code === "tools-unsupported") setRefusal(e.message);
      // A refresh of what is shown goes to the banner; with nothing read yet the page says it itself.
      else if (modes) onError((e as Error).message);
      else setFailed((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (refusal) return <p className="text-xs text-fg-subtle">{refusal}</p>;
  if (!modes && failed) return <LoadFailed error={failed} onRetry={load} />;
  if (!modes) {
    return (
      <p className="flex items-center gap-2 text-sm text-fg-subtle">
        <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Loading…")}
      </p>
    );
  }

  const open = modes.find((mode) => mode.id === openId);
  if (open) {
    return (
      <ModeEditor
        key={open.id}
        mode={open}
        onBack={() => {
          setOpenId(null);
          // In the order of their names, which may have changed.
          void load();
        }}
        onSaved={(next) => setModes(modes.map((mode) => (mode.id === next.id ? next : mode)))}
        onDeleted={() => {
          setOpenId(null);
          void load();
        }}
        onError={onError}
      />
    );
  }

  return (
    <Section
      title={t("Modes")}
      hint={t("Modes you make are offered above the message box of a new chat, after Standard and Code mode. A chat keeps its mode once it has started.")}
      action={
        !adding && (
          <button type="button" onClick={() => setAdding(true)} className={primaryCls}>
            <LuPlus className="h-4 w-4" /> {t("New mode")}
          </button>
        )
      }
    >
      {adding && (
        <NewMode
          onMade={(made) => {
            setAdding(false);
            setModes([...modes, made]);
            setOpenId(made.id);
          }}
          onCancel={() => setAdding(false)}
          onError={onError}
        />
      )}
      {modes.length === 0
        ? !adding && <Empty>{t("No modes of your own yet.")}</Empty>
        : (
          <ul className={gridCls}>
            {modes.map((mode) => (
              <li key={mode.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => setOpenId(mode.id)}
                  className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-raised/40 px-3 py-2 text-left transition hover:bg-fg/5"
                >
                  <LuLayers className="h-4 w-4 shrink-0 text-fg-faint" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">{mode.label}</span>
                    {mode.description && <span className="block truncate text-xs text-fg-subtle">{mode.description}</span>}
                  </span>
                  <LuChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
                </button>
              </li>
            ))}
          </ul>
        )}
    </Section>
  );
}

/** Making a mode: its name and its line, then its own page for the rest. */
function NewMode({ onMade, onCancel, onError }: { onMade: (mode: CustomMode) => void; onCancel: () => void; onError: (e: string) => void }) {
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  useUnsavedDraft(Boolean(label || description));

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onMade(await api.createMode({ label, description }));
    } catch (err) {
      onError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={create} className="mb-3 space-y-3 rounded-xl border border-line bg-raised/40 p-3">
      <Field label={t("Name")}>
        <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} className={inputCls} />
      </Field>
      <Field label={t("Description")}>
        <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} />
      </Field>
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !label.trim()} className={primaryCls}>
          {t("Create")}
        </button>
        <button type="button" onClick={onCancel} className={btnCls}>
          {t("Cancel")}
        </button>
      </div>
    </form>
  );
}

/**
 * A mode's page. Its texts are saved with Save; the rest as it is changed. What it starts its chats on is written into
 * a chat as it is put in the mode; its tools and its instructions reach the chats in it at once.
 */
function ModeEditor({
  mode,
  onBack,
  onSaved,
  onDeleted,
  onError,
}: {
  mode: CustomMode;
  onBack: () => void;
  onSaved: (mode: CustomMode) => void;
  onDeleted: () => void;
  onError: (e: string) => void;
}) {
  const [label, setLabel] = useState(mode.label);
  const [description, setDescription] = useState(mode.description);
  const [instructions, setInstructions] = useState(mode.instructions);
  const [busy, setBusy] = useState(false);
  const [saved, flashSaved] = useFlash();
  // What a chat would have without the mode: the defaults for new chats.
  const settings = useCached("settings", api.settings);
  const models = useCached("models", api.allModels);

  const dirty = label !== mode.label || description !== mode.description || instructions !== mode.instructions;
  useUnsavedDraft(dirty);

  const save = async () => {
    setBusy(true);
    try {
      const next = await api.updateMode(mode.id, { label, description, instructions });
      onSaved(next);
      // As the server keeps them: on one line, trimmed.
      setLabel(next.label);
      setDescription(next.description);
      setInstructions(next.instructions);
      flashSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** A change saved as it is made. Drawn once the server has it: the tools below are read again after the code tool's. */
  const change = async (patch: Parameters<typeof api.updateMode>[1]) => {
    try {
      onSaved(await api.updateMode(mode.id, patch));
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: t("Delete {mode}?", { mode: mode.label }),
      message: t("Chats in it keep it, shown as not available, and work as in Standard mode from their next message."),
      confirmLabel: t("Delete"),
      danger: true,
      deletes: true,
    });
    if (!ok) return;
    try {
      await api.deleteMode(mode.id);
      onDeleted();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-xs text-fg-subtle transition hover:text-fg-muted">
          <LuChevronLeft className="h-3.5 w-3.5" /> {t("Modes")}
        </button>
        <button
          type="button"
          onClick={() => void remove()}
          title={t("Delete")}
          aria-label={t("Delete")}
          className="ml-auto rounded-lg p-1 text-fg-faint transition hover:bg-danger/10 hover:text-danger"
        >
          <LuTrash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <Section title={mode.label}>
        <div className="space-y-3">
          <Field label={t("Name")}>
            <input value={label} onChange={(e) => setLabel(e.target.value)} className={inputCls} />
          </Field>
          <Field label={t("Description")}>
            <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} />
          </Field>
          <Field label={t("Instructions")} hint={t("Said to the agent in this mode's chats, after the portal's own rules.")}>
            <textarea value={instructions} rows={6} onChange={(e) => setInstructions(e.target.value)} className={`${inputCls} resize-y`} />
          </Field>
          <button type="button" onClick={() => void save()} disabled={busy || !dirty || !label.trim()} className={btnCls}>
            {busy ? <LuRefreshCw className="h-4 w-4 animate-spin" /> : saved ? <LuCheck className="h-4 w-4" /> : null}
            {saved ? t("Saved") : t("Save")}
          </button>
        </div>
      </Section>

      <Section title={t("Model")}>
        <div className="space-y-3 rounded-xl border border-line bg-raised/40 p-3">
          <ModelChoice
            models={models.value ?? null}
            failed={!!models.failed}
            provider={mode.provider ?? ""}
            model={mode.model ?? ""}
            onChange={(next) => void change({ provider: next.provider || null, model: next.model || null })}
            labels={{ provider: t("Provider for this mode"), model: t("Model for this mode") }}
            inherit={{ provider: settings.value?.settings.provider, model: settings.value?.settings.model, label: () => t("As the chat would have it") }}
          />
          <div>
            <span className="text-xs text-fg-muted">{t("Effort")}</span>
            <div className="mt-1">
              <EffortPicker
                label={t("Effort for this mode")}
                value={mode.thinkingLevel ?? ""}
                inherited={settings.value?.settings.thinkingLevel}
                onChange={(level) => void change({ thinkingLevel: level || null })}
              />
            </div>
          </div>
          {mode.provider && !mode.model && <p className="text-[11px] text-warn">{t("Choose a model too: a provider alone is not written into a chat.")}</p>}
          <p className="text-[11px] text-fg-faint">{t("Written into a chat as it is put in this mode; the chat can still change it.")}</p>
        </div>
      </Section>

      <Section title={t("Tools")}>
        <div className="space-y-3">
          <SwitchRow
            title={t("Work through the code tool")}
            detail={t("The model writes a short script that calls the chat's tools, and is given only what it puts out; the tools are not offered one by one.")}
            on={mode.codemode}
            onChange={(on) => void change({ codemode: on })}
          />
          <div className="rounded-xl border border-line bg-raised/40">
            {/* Read again once the switch above is saved: the server switches the code tool in the mode's layer with it. */}
            <ToolSwitches key={`${mode.id}:${mode.codemode}`} mode={mode.id} />
          </div>
        </div>
      </Section>
    </>
  );
}
