import { useEffect, useRef, useState } from "react";
import { LuCheck, LuPencil, LuX } from "react-icons/lu";
import { api, ApiError, type LazyLimits, type ToolMark } from "../api";
import { LoadFailed, Section, WarnBanner, ghostCls, inputSmCls } from "./SettingsUi";
import { Select } from "./Select";
import { ToolGroupList } from "./ToolGroupList";
import { MARK_TITLE, displayName, markCls, markName, markNote, nextMark, nextOff, sourceName, sourceOf } from "../tool-groups";
import { isEnter, isEscape } from "../shortcuts";
import { formatNumber, t, tp } from "../i18n";

/** What ask_question may wait for, in minutes; 0 is until it is answered. The server holds the same list. */
const QUESTION_WAITS = [0, 5, 15, 30, 60];

/** How a single tool is marked next to the sets; the server keys it the same way (lazyToolEntry). */
const lazyEntry = (name: string): string => `<tool>${name}`;

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
  const [tools, setTools] = useState<{ name: string; source: string; inline?: true; lazy?: true; noLazy?: true }[]>([]);
  const [off, setOff] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  /** Why there is nothing to switch here, where the deployment cannot do it. */
  const [refusal, setRefusal] = useState("");
  /** Any other failure of the read: no statement about the deployment, so it is not shown as one. */
  const [failed, setFailed] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  /** What is marked, on sets as the list keys them and on single tools as `<tool>name`: lazy or direct. What has none is auto. */
  const [marks, setMarks] = useState<Record<string, ToolMark>>({});
  /** The sets the threshold made lazy, and whether it could not make the list fit. */
  const [resolved, setResolved] = useState<{ lazy: string[]; over: boolean }>({ lazy: [], over: false });
  /** What the model's list holds now, with what is lazy taken out of it. */
  const [listed, setListed] = useState<{ tokens: number; tools: number } | null>(null);
  const [limits, setLimits] = useState<LazyLimits>({ tokens: 3000, tools: 20 });
  const [defaultLimits, setDefaultLimits] = useState<LazyLimits>({ tokens: 3000, tools: 20 });
  /** What is typed in the two limit fields, which is saved when one is left. */
  const [typed, setTyped] = useState<{ tokens: string; tools: string }>({ tokens: "3000", tools: "20" });
  /** The sets the threshold made lazy since the person last looked. */
  const [notice, setNotice] = useState<string[]>([]);
  /** Whether the limit fields have been filled in: a list read again after a save must not take from under a field being typed in. */
  const typedFrom = useRef(false);
  /** The last save of the limits, its own or the way back to the defaults: the answer to one before it says nothing any more. */
  const limitSave = useRef(0);
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
        setMarks(r.marks ?? {});
        setResolved(r.resolved ?? { lazy: [], over: false });
        setListed(r.listed ?? null);
        if (r.limits) {
          setLimits(r.limits);
          if (!typedFrom.current) setTyped({ tokens: String(r.limits.tokens), tools: String(r.limits.tools) });
          typedFrom.current = true;
        }
        if (r.defaultLimits) setDefaultLimits(r.defaultLimits);
        setNotice(r.lazyNotice ?? []);
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
      // A tool that is off is not counted in the model's list: what the threshold makes lazy, and whether the list is
      // over the limits, may have changed with it.
      setTries((n) => n + 1);
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
   * Set what a set or a single tool is marked: lazy, direct, or nothing (auto: the threshold decides). A mark touches no
   * switch: the tool stays on or off as it was, and only the model's list changes. What the threshold made lazy may
   * change with it, so the list is read again.
   */
  const setMark = async (entry: string, next: ToolMark | undefined) => {
    const wanted = { ...marks };
    if (next) wanted[entry] = next;
    else delete wanted[entry];
    setBusy(true);
    try {
      const r = await api.setToolMarks(wanted);
      setMarks(r.marks);
      setResolved(r.resolved);
      setTries((n) => n + 1);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Save the limits of the threshold, when a field is left: anything that is not a whole number goes back to what was saved. */
  const saveLimits = async () => {
    const whole = (text: string) => (/^\d{1,8}$/.test(text.trim()) ? Number(text.trim()) : undefined);
    const next = { tokens: whole(typed.tokens), tools: whole(typed.tools) };
    if (next.tokens === undefined || next.tools === undefined) {
      setTyped({ tokens: String(limits.tokens), tools: String(limits.tools) });
      return;
    }
    if (next.tokens === limits.tokens && next.tools === limits.tools) return;
    // What is saved is what is typed from now on: a field left again before the answer comes is judged against it.
    const before = limits;
    setLimits({ tokens: next.tokens, tools: next.tools });
    const save = ++limitSave.current;
    try {
      const r = await api.setLazyLimits({ tokens: next.tokens, tools: next.tools });
      if (save !== limitSave.current) return;
      setLimits(r.limits);
      setResolved(r.resolved);
      setTries((n) => n + 1);
    } catch (e) {
      // A later save has the last word: this one failing puts nothing back over it.
      if (save !== limitSave.current) return;
      setLimits(before);
      setTyped({ tokens: String(before.tokens), tools: String(before.tools) });
      onError((e as Error).message);
    }
  };

  const dismissNotice = async () => {
    setNotice([]);
    try {
      await api.dismissLazyNotice();
    } catch (e) {
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

      <Section
        title={t("Lazy above")}
        hint={t("When the model's list of tools gets long, whole groups that have no mark of their own are taken out of it and found through tool_search instead, the largest first, until the list has fewer tokens and tools than this. A group marked direct stays in the list. 0 turns a limit off. It reaches the chats that start from now on.")}
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-fg-muted">
            {t("Tokens of tool declarations")}
            <input
              inputMode="numeric"
              value={typed.tokens}
              onChange={(e) => setTyped({ ...typed, tokens: e.target.value })}
              onBlur={saveLimits}
              onKeyDown={(e) => isEnter(e) && (e.target as HTMLInputElement).blur()}
              className={`${inputSmCls} mt-1 !w-32`}
              aria-label={t("Tokens of tool declarations")}
            />
          </label>
          <label className="text-xs text-fg-muted">
            {t("Number of tools")}
            <input
              inputMode="numeric"
              value={typed.tools}
              onChange={(e) => setTyped({ ...typed, tools: e.target.value })}
              onBlur={saveLimits}
              onKeyDown={(e) => isEnter(e) && (e.target as HTMLInputElement).blur()}
              className={`${inputSmCls} mt-1 !w-32`}
              aria-label={t("Number of tools")}
            />
          </label>
          {(limits.tokens !== defaultLimits.tokens || limits.tools !== defaultLimits.tools) && (
            <button
              type="button"
              className={ghostCls}
              onClick={() => {
                setTyped({ tokens: String(defaultLimits.tokens), tools: String(defaultLimits.tools) });
                const save = ++limitSave.current;
                void api
                  .setLazyLimits(defaultLimits)
                  .then((r) => {
                    if (save !== limitSave.current) return;
                    setLimits(r.limits);
                    setResolved(r.resolved);
                    setTries((n) => n + 1);
                  })
                  .catch((e) => onError((e as Error).message));
              }}
            >
              {t("Back to {tokens} tokens or {tools} tools", { tokens: formatNumber(defaultLimits.tokens), tools: String(defaultLimits.tools) })}
            </button>
          )}
        </div>
        {listed && (
          <p className="mt-2 text-xs text-fg-subtle">
            {t("The model's list holds {tokens} tokens in {tools} tools.", { tokens: formatNumber(listed.tokens), tools: String(listed.tools) })}
            {resolved.over && " " + t("That is over the limits, and nothing more can be taken out of it: what is left is pi's own tools, the portal's own small ones and what is marked direct.")}
          </p>
        )}
      </Section>

      {notice.length > 0 && (
        <WarnBanner onClose={dismissNotice} className="mb-4">
          {t("The list of tools got long, so the model now finds {groups} through tool_search instead of having them in its list. Mark a group direct to keep it there.", {
            groups: notice.map((source) => displayName(source, names)).join(", "),
          })}
        </WarnBanner>
      )}

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
            tools={tools.map((tool) => {
              // Lazy by the mark on the tool or on its set, else by the threshold: an MCP server is a set like any other.
              const mark = tool.noLazy ? undefined : marks[lazyEntry(tool.name)] ?? marks[sourceOf(tool)];
              const isLazy = tool.noLazy ? undefined : mark ? mark === "lazy" : resolved.lazy.includes(sourceOf(tool));
              return {
                ...tool,
                enabled: !off.includes(tool.name),
                ...(mark ? { mark } : !tool.noLazy ? { auto: true as const } : {}),
                lazy: isLazy ? (true as const) : undefined,
              };
            })}
            onMark={(tool) => {
              // The tool's own mark goes round, not the one it shows from its set: from a set's direct the round would end
              // at no mark, which is direct again. A mark that is the set's own is passed over, as it would change nothing.
              const inherited = marks[sourceOf(tool)];
              let next = nextMark(marks[lazyEntry(tool.name)]);
              if (next !== undefined && next === inherited) next = nextMark(next);
              setMark(lazyEntry(tool.name), next);
            }}
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
              <>
                {/* Not for pi's own tools: those are always offered. */}
                {group.tools.some((tool) => !tool.noLazy) && (() => {
                  const own = marks[group.source];
                  const lazyNow = own ? own === "lazy" : resolved.lazy.includes(group.source);
                  const state = { mark: own, lazy: lazyNow ? (true as const) : undefined };
                  return (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setMark(group.source, nextMark(own))}
                      title={`${markNote(state)} ${t(MARK_TITLE)}`}
                      aria-label={t("Lazy or direct {name}: {mark}", { name: displayName(group.source, names), mark: markName(state) })}
                      className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] transition disabled:cursor-not-allowed disabled:opacity-50 ${markCls(state)}`}
                    >
                      {markName(state)}
                    </button>
                  );
                })()}
                <button
                  type="button"
                  onClick={() => setRenaming({ source: group.source, value: names[group.source] ?? "" })}
                  title={t("Rename — it is {source}", { source: sourceName(group.source) })}
                  aria-label={t("Rename {name}", { name: sourceName(group.source) })}
                  className="shrink-0 rounded p-1 text-fg-subtle transition hover:bg-fg/5 hover:text-fg"
                >
                  <LuPencil className="h-3 w-3" />
                </button>
              </>
            )}
          />
        </div>
      )}
    </>
  );
}
