import { useEffect, useState } from "react";
import { LuCheck, LuPencil, LuX } from "react-icons/lu";
import { api, ApiError } from "../api";
import { LoadFailed, Section } from "./SettingsUi";
import { Select } from "./Select";
import { ToolGroupList } from "./ToolGroupList";
import { displayName, nextOff, sourceName } from "../tool-groups";
import { isEnter, isEscape } from "../shortcuts";
import { t, tp } from "../i18n";

/** What ask_question may wait for, in minutes; 0 is until it is answered. The server holds the same list. */
const QUESTION_WAITS = [0, 5, 15, 30, 60];

/**
 * Which tools every conversation starts with.
 *
 * The switch in the composer is per chat, which is right for "not this time"
 * and wrong for "hardly ever" — nobody wants to turn the same tool off at the
 * start of every conversation. This is the other half: the default, which a
 * chat may still disagree with.
 *
 * The list is what the portal has seen a session register, not what is loaded
 * right now. pi builds its registry when a conversation starts, and needing to
 * start one before you can say "this should be off everywhere" would be the
 * wrong way round.
 */
export function ToolDefaults({ onError }: { onError: (e: string) => void }) {
  const [tools, setTools] = useState<{ name: string; source: string; inline?: true }[]>([]);
  const [off, setOff] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  /** Why there is nothing to switch here, where the deployment cannot do it. */
  const [refusal, setRefusal] = useState("");
  /** Any other failure of the read: no statement about the deployment, so it is not shown as one. */
  const [failed, setFailed] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const [questionWait, setQuestionWait] = useState(0);
  /** The group being renamed, and what has been typed so far. */
  const [renaming, setRenaming] = useState<{ source: string; value: string } | null>(null);

  useEffect(() => {
    api
      .toolDefaults()
      .then((r) => {
        setFailed(null);
        setTools(r.tools);
        setOff(r.off);
        setNames(r.names ?? {});
        setQuestionWait(r.questionWaitMinutes ?? 0);
      })
      // A deployment where this cannot work says so in place of the list — the
      // same as the switches beside the composer, and for the same reason. Only
      // that answer: a portal that could not be reached is tried again.
      .catch((e) => (e instanceof ApiError && e.body.code === "tools-unsupported" ? setRefusal(e.message) : setFailed((e as Error).message)))
      .finally(() => setLoading(false));
  }, [tries]);

  const flip = async (names: string[], enabled: boolean) => {
    const wanted = nextOff(off, names, enabled);
    const before = off;
    setOff(wanted);
    setBusy(true);
    try {
      const r = await api.setToolDefaults(wanted);
      setOff(r.off);
    } catch (e) {
      setOff(before);
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changeQuestionWait = async (minutes: number) => {
    const before = questionWait;
    setQuestionWait(minutes);
    try {
      setQuestionWait((await api.setQuestionWait(minutes)).waitMinutes);
    } catch (e) {
      setQuestionWait(before);
      onError((e as Error).message);
    }
  };

  /**
   * Store a name, or take one away.
   *
   * Blank means "call it what it calls itself" rather than an empty heading,
   * so the entry is removed and the derived name comes back.
   */
  const rename = async (source: string, label: string) => {
    const next = { ...names };
    if (label.trim()) next[source] = label.trim();
    else delete next[source];
    const before = names;
    setNames(next);
    setRenaming(null);
    try {
      const r = await api.setToolNames(next);
      setNames(r.names);
    } catch (e) {
      setNames(before);
      onError((e as Error).message);
    }
  };

  if (loading) return null;
  if (failed) {
    return (
      <LoadFailed
        error={failed}
        onRetry={() => {
          setLoading(true);
          setTries((n) => n + 1);
        }}
      />
    );
  }
  if (refusal) {
    return (
      <p className="rounded-xl border border-line bg-raised/40 px-3 py-2 text-xs text-fg-subtle">
        {refusal}
      </p>
    );
  }

  return (
    <>
      <section className="mb-6 rounded-xl border border-line bg-raised/40 p-3">
        <p className="text-xs text-fg-subtle">
          {t("What a conversation starts with. A tool switched off here is not offered to the model in any chat — the extension stays installed and its slash commands still work. One chat can switch any of them the other way for itself, from the blocks icon beside the composer, and a change here reaches every chat that has not.")}
        </p>
      </section>

      <Section
        title={t("Questions from the agent")}
        hint={t("How long the agent's ask_question tool waits for your answer before it carries on without one. By default it waits until you answer; Stop in the message box ends the wait at any time. The setting is read each time a question is asked.")}
      >
        <Select
          aria-label={t("Wait for an answer")}
          className="w-48"
          value={questionWait}
          onChange={changeQuestionWait}
          options={QUESTION_WAITS.map((m) => ({ value: m, label: m ? tp(m, "{n} minute", "{n} minutes") : t("Until answered") }))}
        />
      </Section>

      {!tools.length ? (
        <p className="rounded-xl border border-line bg-raised/40 px-3 py-2 text-xs text-fg-subtle">
          {t("Nothing listed yet. Tools appear once a conversation has run — that is when pi builds the list of what its extensions registered.")}
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          {/* Read from the switches rather than from what was loaded: the list
              is what exists, `off` is what has been decided about it, and only
              the second changes while this is open. */}
          <ToolGroupList
            roomy
            tools={tools.map((tool) => ({ ...tool, enabled: !off.includes(tool.name) }))}
            names={names}
            busy={busy}
            onFlip={flip}
            naming={(group) =>
              renaming?.source === group.source ? (
                <>
                  <input
                    autoFocus
                    value={renaming.value}
                    onChange={(e) => setRenaming({ source: group.source, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (isEnter(e)) rename(group.source, renaming.value);
                      // Cancels the rename only: Settings closes on Escape too, and would take the whole dialog with it.
                      if (isEscape(e)) {
                        e.stopPropagation();
                        setRenaming(null);
                      }
                    }}
                    placeholder={displayName(group.source)}
                    aria-label={t("Name for {source}", { source: sourceName(group.source) })}
                    className="min-w-0 flex-1 rounded border border-line bg-canvas px-1.5 py-0.5 text-xs text-fg outline-none focus:border-accent/60"
                  />
                  <button
                    type="button"
                    onClick={() => rename(group.source, renaming.value)}
                    title={t("Save")}
                    aria-label={t("Save")}
                    className="shrink-0 rounded p-1 text-fg-subtle transition hover:bg-fg/5 hover:text-fg"
                  >
                    <LuCheck className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenaming(null)}
                    title={t("Cancel")}
                    aria-label={t("Cancel")}
                    className="shrink-0 rounded p-1 text-fg-subtle transition hover:bg-fg/5 hover:text-fg"
                  >
                    <LuX className="h-3 w-3" />
                  </button>
                </>
              ) : undefined
            }
            // Only here, not in the chat popover: naming a thing is a settings decision, and the popover is for one chat.
            beside={(group) => (
              <button
                type="button"
                onClick={() => setRenaming({ source: group.source, value: names[group.source] ?? "" })}
                title={t("Rename — it is {source}", { source: sourceName(group.source) })}
                aria-label={t("Rename {name}", { name: sourceName(group.source) })}
                className="shrink-0 rounded p-1 text-fg-subtle transition hover:bg-fg/5 hover:text-fg"
              >
                <LuPencil className="h-3 w-3" />
              </button>
            )}
          />
        </div>
      )}
    </>
  );
}
