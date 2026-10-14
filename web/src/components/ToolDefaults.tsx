import { useEffect, useState } from "react";
import { LuCheck, LuPencil, LuX } from "react-icons/lu";
import { api, ApiError } from "../api";
import { LoadFailed, Section } from "./SettingsUi";
import { Select } from "./Select";
import { ToolGroupList } from "./ToolGroupList";
import { displayName, nextOff, sourceName, sourceOf } from "../tool-groups";
import { isEnter, isEscape } from "../shortcuts";
import { t, tp } from "../i18n";

/** What ask_question may wait for, in minutes; 0 is until it is answered. The server holds the same list. */
const QUESTION_WAITS = [0, 5, 15, 30, 60];

/** How a single tool is marked lazy next to the sets; the server keys it the same way (lazyToolEntry). */
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
  const [tools, setTools] = useState<{ name: string; source: string; inline?: true; lazy?: true; mcp?: string; noLazy?: true }[]>([]);
  const [off, setOff] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  /** Why there is nothing to switch here, where the deployment cannot do it. */
  const [refusal, setRefusal] = useState("");
  /** Any other failure of the read: no statement about the deployment, so it is not shown as one. */
  const [failed, setFailed] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  /** What is marked lazy: sets as the list keys them, and single tools as `<tool>name`. */
  const [lazy, setLazy] = useState<string[]>([]);
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
        setLazy(r.lazy ?? []);
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
   * Make a set or a single tool lazy, or ordinary again. Lazy touches no switch: the tool stays on or
   * off as it was, and only the model's list changes.
   */
  const flipLazy = async (entry: string) => {
    const wanted = lazy.includes(entry) ? lazy.filter((s) => s !== entry) : [...lazy, entry];
    setBusy(true);
    try {
      const r = await api.setLazyToolSets(wanted);
      setLazy(r.lazy);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Make an MCP server's tools lazy, or register them one by one. It is the server's own setting, "Register tools
   * directly", turned off for lazy: the one switch, not a mark of the portal's. It is read when a chat starts.
   */
  const flipMcp = async (server: string, lazyNow: boolean) => {
    setBusy(true);
    try {
      await api.setMcpDirect(server, lazyNow);
      setTools((all) => all.map((tool) => (tool.mcp === server ? { ...tool, lazy: lazyNow ? undefined : (true as const) } : tool)));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
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
            tools={tools.map((tool) => ({
              ...tool,
              enabled: !off.includes(tool.name),
              // Marked as a set or on its own: found through the `tools` tool, which the list says beside it. An MCP server's tool is the server's to say.
              lazy: tool.mcp !== undefined ? tool.lazy : !tool.noLazy && (lazy.includes(sourceOf(tool)) || lazy.includes(lazyEntry(tool.name))) ? (true as const) : undefined,
            }))}
            onLazy={(tool) => flipLazy(lazyEntry(tool.name))}
            lazyFixed={(tool) => tool.mcp !== undefined || lazy.includes(sourceOf(tool))}
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
                {/* Not for pi's own tools: those are always offered. An MCP server's group has the server's setting. */}
                {group.tools.some((tool) => !tool.noLazy) && (() => {
                  const server = group.tools.find((tool) => tool.mcp !== undefined)?.mcp;
                  const pressed = server !== undefined ? group.tools.every((tool) => tool.lazy) : lazy.includes(group.source);
                  // Nothing in the set is offered while every tool is off, so there is nothing for a mark to change.
                  const idle = group.allOff;
                  return (
                    <button
                      type="button"
                      disabled={busy || idle}
                      aria-pressed={pressed}
                      onClick={() => (server !== undefined ? flipMcp(server, pressed) : flipLazy(group.source))}
                      title={
                        idle
                          ? t("All of its tools are off by default, so none is offered to the model, lazy or not, except where an agent, project, routine or chat switches them on. Switch one on here to change the lazy mark.")
                          : server !== undefined
                          ? t("Lazy: the server's tools are not in the model's list one by one; the model finds and calls them through the `mcp` tool. It is the server's \"Register tools directly\", turned off, and it applies to chats that start from now on. They stay on or off as they are.")
                          : t("Lazy: its tools are not in the model's list one by one; the model finds and calls them through the `tools` tool, so nothing in the set is lost to it. They stay on or off as they are; an off tool is not reachable that way. Tools that turn up later start lazy too.")
                      }
                      aria-label={t("Lazy {name}", { name: displayName(group.source, names) })}
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] transition hover:bg-fg/5 disabled:cursor-not-allowed disabled:opacity-50 ${
                        pressed ? "bg-accent/15 text-accent" : "text-fg-subtle hover:text-fg"
                      }`}
                    >
                      {t("lazy")}
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
