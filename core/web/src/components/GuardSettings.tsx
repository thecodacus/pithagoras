import { useEffect, useRef, useState, type ReactNode } from "react";
import { LuRefreshCw } from "react-icons/lu";
import { useSearchParams } from "react-router-dom";
import { api, type GuardState } from "../api";
import { formatDateTime, msg, t, tp, tx } from "../i18n";
import type { Tab } from "../settings-tabs";
import { useUnsavedDraft } from "./Modal";
import { DetailsGroup, Empty, LoadFailed, Section, SwitchRow, WarnBanner, btnCls, codeAreaCls, ghostCls, primaryCls } from "./SettingsUi";

/** What each rule after a suspected injection holds back, by its name, as the page says it. */
const RULE_TEXT: Record<string, string> = {
  "pipe-to-shell": msg("Running something downloaded, or piped in, without anyone reading it first"),
  "write-to-path": msg("Writing a file onto PATH, where it runs later without anyone asking for it"),
  upload: msg("Sending data out of the box: a body to a web address, a copy to another machine or a bucket, mail"),
  "read-credentials": msg("Reading where keys and tokens are kept"),
  publish: msg("Pushing to a git remote, which cannot be undone from here"),
  persist: msg("Scheduling work, or changing what the agent loads as its own instructions, tools or code"),
  delegate: msg("Starting a subagent or a routine, which work in a conversation of their own"),
};

/** What holds whatever is set here, and why it is no switch. */
const ALWAYS: { title: string; why: string }[] = [
  {
    title: msg("Outside content is marked"),
    why: msg("Mail, web pages, MCP output and the browser reach the agent marked as somebody else's words, with a marker a page cannot fake. Marking refuses nothing."),
  },
  {
    title: msg("A suspected injection is flagged"),
    why: msg("Wording that tries to instruct the agent flags the result it is in. That is what makes the rules above hold, until you trust the result or remove its turn."),
  },
  {
    title: msg("The rules hold in chats, channels and heartbeats"),
    why: msg("Only a routine can be exempt from one: everywhere else somebody is on the other end, or the agent looks around on its own."),
  },
  {
    title: msg("Secrets stay with the primary user"),
    why: msg("Nobody but the primary user, and no heartbeat, has the agent read where keys and tokens are kept or the primary user's private notes."),
  },
  {
    title: msg("The agent's own instructions stay the primary user's"),
    why: msg("Nobody else changes what the agent loads as its own instructions, tools or code, and neither does a heartbeat."),
  },
  {
    title: msg("Subagents and routines are the primary user's"),
    why: msg("Only the primary user starts a subagent or makes, changes or runs a routine: each runs with the primary user's rights."),
  },
  {
    title: msg("A tool switched off is off every way"),
    why: msg("Through the mcp tool, a script or the tools gateway as well as by its name."),
  },
];

/** A line of the guard's state: what it is, how it stands, and the tab where it is set. On a narrow screen how it stands goes under what it is. */
function StatusRow({ label, value, warn, tab, onOpen }: { label: string; value: string; warn?: boolean; tab: Tab; onOpen: (tab: Tab) => void }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-raised/40 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 basis-40 text-fg-muted">{label}</span>
      <span className={`min-w-0 [overflow-wrap:anywhere] ${warn ? "text-warn" : "text-fg"}`}>{value}</span>
      <button type="button" className={ghostCls} aria-label={t("Open {label}", { label })} onClick={() => onOpen(tab)}>
        {t("Open")}
      </button>
    </li>
  );
}

/**
 * Settings → Guard: what the guard holds the agent to, and the little of it that is a switch. A routine may be let
 * do what a rule after a suspected injection holds back, one rule at a time; an MCP server may be counted as the
 * person's own; the sites the agent's tools may reach are a list; what was allowed once, an approval not yet
 * spent or a flagged result that was trusted, may be taken back. The rest is shown with its reason. Each switch is
 * shown at once and saved, as the tool switches are; changes made while another saves are saved too, and one the
 * server refuses is put back by itself. The list is saved with its button.
 */
export function GuardSettings({ onError, onOpen }: { onError: (message: string) => void; onOpen: (tab: Tab) => void }) {
  const [state, setState] = useState<GuardState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const had = useRef(false);
  /** The routine a page asked to be shown (`?routine=`): its group is open, and scrolled to. */
  const [params] = useSearchParams();
  const wanted = params.get("routine");
  const wantedRef = useRef<HTMLDivElement>(null);
  /** Where focus goes when the thing that had it is taken away: the list it was in. */
  const approvalsRef = useRef<HTMLDivElement>(null);
  const trustedRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const next = await api.guard();
      had.current = true;
      setFailed(null);
      setState(next);
    } catch (e) {
      // A refresh of what is shown goes to the banner; with nothing read yet the page says it itself.
      if (had.current) onError((e as Error).message);
      else setFailed((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (state && wanted) wantedRef.current?.scrollIntoView({ block: "center" });
  }, [state !== null, wanted]);

  if (failed && !had.current) return <LoadFailed error={failed} onRetry={load} />;
  if (!state) {
    return (
      <p className="flex items-center gap-2 text-sm text-fg-subtle">
        <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Loading…")}
      </p>
    );
  }

  /**
   * A change: shown at once by `apply`, saved, and taken back by `undo` if the server says no, on what the page shows
   * by then, so that a change made meanwhile stays. The page is read again then, to show what holds.
   */
  const change = async (apply: (s: GuardState) => GuardState, undo: (s: GuardState) => GuardState, save: () => Promise<unknown>) => {
    setState((s) => (s ? apply(s) : s));
    try {
      await save();
    } catch (e) {
      setState((s) => (s ? undo(s) : s));
      onError((e as Error).message);
      void load();
    }
  };

  /** After a thing is taken out of a list, focus goes to the next one there, or to the list. */
  const refocus = (list: HTMLDivElement | null) =>
    requestAnimationFrame(() => (list?.querySelector<HTMLElement>("button") ?? list)?.focus());

  const ruleText = (name: string) => (RULE_TEXT[name] ? t(RULE_TEXT[name]) : state.rules.find((rule) => rule.name === name)?.why ?? name);
  const sandbox = state.sandbox === "on" ? t("On") : state.sandbox === "off" ? t("Off") : t("Not available here");
  const setExempt = (id: string, exempt: string[]) => (s: GuardState) => ({ ...s, routines: s.routines.map((one) => (one.id === id ? { ...one, exempt } : one)) });
  const setTrusted = (name: string, trusted: boolean) => (s: GuardState) => ({ ...s, servers: s.servers.map((one) => (one.name === name ? { ...one, trusted } : one)) });

  return (
    <div>
      <Section title={t("Guard")} hint={t("What the guard holds the agent to, whatever a page, a mail or a stranger asks of it, and the little of it that you can change.")}>
        {!state.running && (
          <WarnBanner className="mb-3">
            {t("The guard is not running here: this portal runs pi in a container, without the portal's extensions, so nothing on this page holds there.")}
          </WarnBanner>
        )}
        <ul className="space-y-1.5">
          <StatusRow label={t("Sandbox")} value={sandbox} warn={state.sandbox !== "on"} tab="sandbox" onOpen={onOpen} />
          <StatusRow label={t("Primary user")} value={state.primary ? t("Named") : t("Nobody is named, so the agent lets everybody in")} warn={!state.primary} tab="people" onOpen={onOpen} />
          <StatusRow
            label={t("Where approvals are asked for")}
            value={state.approvalsTo ? t("The chat routines report to") : t("Nowhere is set, so somebody else can only be told no")}
            warn={!state.approvalsTo}
            tab="general"
            onOpen={onOpen}
          />
        </ul>
      </Section>

      <Section
        title={t("After a suspected injection")}
        hint={t("Once a result the agent read looks like it tries to instruct it, these are held in that conversation until you trust the result or remove its turn. In a chat where you are there to answer, you are asked about each call, and a yes lets that one call run; everywhere else it is refused.")}
      >
        <ul className="space-y-1.5">
          {state.rules.map((rule) => (
            <li key={rule.name} className="rounded-xl border border-line bg-raised/40 px-3 py-2 text-sm">
              <span className="font-mono text-xs text-fg">{rule.name}</span>
              <span className="mt-0.5 block text-xs text-fg-faint">{ruleText(rule.name)}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title={t("Routines")}
        hint={t("A routine that reads something untrusted and then has to act on it, as one that reads logs and pushes a fix does, can be let do one of these anyway. Exempt only what it needs: nobody watches while it runs, and what an exemption let through is recorded in Audit.")}
      >
        {state.routines.length === 0 ? (
          <Empty>{t("No routines yet.")}</Empty>
        ) : (
          <div className="space-y-2">
            {state.routines.map((routine) => (
              <div key={routine.id} ref={routine.id === wanted ? wantedRef : undefined}>
                <DetailsGroup
                  title={routine.name}
                  defaultOpen={routine.id === wanted}
                  summary={
                    routine.exempt.length === 0
                      ? t("Every rule holds")
                      : routine.exempt.length === state.rules.length
                        ? t("Every rule is off")
                        : t("Off: {rules}", { rules: routine.exempt.join(", ") })
                  }
                >
                  {state.rules.map((rule) => (
                    <SwitchRow
                      key={rule.name}
                      title={rule.name}
                      label={t("{rule} holds for {routine}", { rule: rule.name, routine: routine.name })}
                      detail={ruleText(rule.name)}
                      on={!routine.exempt.includes(rule.name)}
                      onChange={(on) => {
                        const before = routine.exempt;
                        const exempt = on ? before.filter((name) => name !== rule.name) : [...before, rule.name];
                        void change(setExempt(routine.id, exempt), setExempt(routine.id, before), () => api.setGuardRoutine(routine.id, exempt));
                      }}
                    />
                  ))}
                </DetailsGroup>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title={t("Outside content")}
        hint={t("What an MCP server hands back is somebody else's words, an issue comment or a mail body, and is marked and checked as a web page is. A server you run yourself can be counted as your own: what it says is then neither marked nor checked.")}
      >
        {state.servers.length === 0 ? (
          <Empty>
            {t("No MCP servers are set up.")}{" "}
            <button type="button" className="text-accent hover:underline" onClick={() => onOpen("mcp")}>
              {t("Add one")}
            </button>
          </Empty>
        ) : (
          <div className="space-y-1.5">
            {state.servers.map((server) =>
              server.browser ? (
                // Not a switch that is off: it never is one.
                <div key={server.name} className="rounded-xl border border-line bg-raised/40 p-3 text-sm text-fg [overflow-wrap:anywhere]">
                  {server.name}
                  <span className="mt-0.5 block text-xs text-fg-muted">{t("The browser's pages are anybody's words: always outside content.")}</span>
                </div>
              ) : (
                <SwitchRow
                  key={server.name}
                  title={server.name}
                  label={t("Count {server} as your own", { server: server.name })}
                  detail={server.trusted ? t("Counted as your own: what it says is neither marked nor checked.") : t("Outside content: what it says is marked and checked.")}
                  on={server.trusted}
                  onChange={(trusted) => void change(setTrusted(server.name, trusted), setTrusted(server.name, !trusted), () => api.setGuardServer(server.name, trusted))}
                />
              ),
            )}
          </div>
        )}
      </Section>

      <Section title={t("Sites the agent's tools may reach")} hint={t("One list for every tool that says where it goes, and for the browser tools an MCP server brings.")}>
        <AllowlistEditor initial={state.allowlist} onSaved={(allowlist) => setState((s) => (s ? { ...s, allowlist } : s))} onError={onError} />
      </Section>

      <Section
        title={t("Allowed once")}
        hint={t("Approvals the primary user gave for one go that are not spent yet. Each runs out after 15 minutes; take one back before then if it should not run.")}
      >
        <div ref={approvalsRef} tabIndex={-1} className="outline-none">
          {state.approvals.length === 0 ? (
            <Empty>{t("No approval is waiting to be spent.")}</Empty>
          ) : (
            <ul className="space-y-1.5">
              {state.approvals.map((approval) => (
                <Item
                  key={approval.id}
                  title={approval.chat ?? t("A chat that was deleted")}
                  detail={
                    <>
                      <span className="font-mono">{approval.tool}</span>: <span className="font-mono">{approval.subject}</span>
                      <span className="block">{t("Runs out at {time}", { time: formatDateTime(approval.expiresAt, { timeStyle: "short" }) })}</span>
                    </>
                  }
                  action={t("Revoke")}
                  label={t("Revoke {tool}: {subject}", { tool: approval.tool, subject: approval.subject })}
                  onAction={() => {
                    const without = (s: GuardState) => ({ ...s, approvals: s.approvals.filter((one) => one.id !== approval.id) });
                    refocus(approvalsRef.current);
                    void change(without, (s) => ({ ...s, approvals: [approval, ...s.approvals] }), () => api.revokeApproval(approval.id));
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section
        title={t("Trusted results")}
        hint={t("Results flagged as a suspected injection that you looked at and trusted, so that they no longer hold their chat back. Take the trust back and the chat is held again.")}
      >
        <div ref={trustedRef} tabIndex={-1} className="outline-none">
          {state.trusted.length === 0 ? (
            <Empty>{t("Nothing flagged has been trusted.")}</Empty>
          ) : (
            <ul className="space-y-1.5">
              {state.trusted.flatMap((chat) =>
                chat.results.map((result) => {
                  const where = chat.chat ?? t("A chat that was deleted");
                  return (
                    <Item
                      key={`${chat.sessionId}:${result.id}`}
                      title={where}
                      detail={
                        <>
                          {result.tool && <span className="font-mono">{result.tool}</span>}
                          {result.signals?.length ? <span>{` · ${tp(result.signals.length, "{n} sign", "{n} signs", { n: result.signals.length })}: ${result.signals.join(", ")}`}</span> : null}
                          {result.excerpt && <span className="block truncate">{result.excerpt}</span>}
                        </>
                      }
                      action={t("Un-trust")}
                      label={t("Un-trust a result in {chat}", { chat: where })}
                      onAction={() => {
                        const keep = (s: GuardState, put: boolean) => ({
                          ...s,
                          trusted: put
                            ? s.trusted.some((one) => one.sessionId === chat.sessionId)
                              ? s.trusted.map((one) => (one.sessionId === chat.sessionId ? { ...one, results: [...one.results, result] } : one))
                              : [...s.trusted, { ...chat, results: [result] }]
                            : s.trusted
                                .map((one) => (one.sessionId === chat.sessionId ? { ...one, results: one.results.filter((r) => r.id !== result.id) } : one))
                                .filter((one) => one.results.length),
                        });
                        refocus(trustedRef.current);
                        void change((s) => keep(s, false), (s) => keep(s, true), () => api.untrustResult(chat.sessionId, result.id));
                      }}
                    />
                  );
                }),
              )}
            </ul>
          )}
        </div>
      </Section>

      <Section title={t("Always on")} hint={t("These are not switches. Each is here with the reason it is not one.")}>
        <ul className="space-y-1.5">
          {ALWAYS.map((item) => (
            <li key={item.title} className="rounded-xl border border-line bg-raised/40 px-3 py-2 text-sm">
              <span className="text-fg">{t(item.title)}</span>
              <span className="mt-0.5 block text-xs text-fg-faint">{t(item.why)}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

/**
 * The domains the agent's tools may be pointed at, one to a line, saved with its button. What was typed and not saved
 * is asked about before Settings closes, and is not replaced when the page is read again.
 */
function AllowlistEditor({ initial, onSaved, onError }: { initial: string; onSaved: (allowlist: string) => void; onError: (message: string) => void }) {
  const [text, setText] = useState(initial);
  /** What `text` started from: it is changed once it is not that. */
  const [from, setFrom] = useState(initial);
  const [saving, setSaving] = useState(false);
  useUnsavedDraft(!saving && text !== from);

  useEffect(() => {
    if (text === from) setText(initial);
    setFrom(initial);
  }, [initial]);

  const save = async () => {
    const sent = text;
    setSaving(true);
    try {
      const { allowlist } = await api.setGuardAllowlist(sent);
      // As the server keeps it, unless more was typed while it was saved: that stays, to be saved next.
      setText((now) => (now === sent ? allowlist : now));
      setFrom(allowlist);
      onSaved(allowlist);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <p className="mb-2 text-xs text-fg-faint">
        {tx("One domain per line; {pattern} covers its subdomains. An empty list means any site: a list nobody filled in should not quietly block everything.", { pattern: <span className="font-mono">*.example.com</span> })}
      </p>
      <textarea
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"*.google.com\ngithub.com"}
        aria-label={t("Sites the agent's tools may reach")}
        spellCheck={false}
        className={codeAreaCls}
      />
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <button type="button" className={primaryCls} disabled={saving || text === from} onClick={() => void save()}>
          {t("Save")}
        </button>
        <p className="min-w-0 flex-1 basis-60 text-xs text-fg-faint">
          {t("Checked when a tool is asked to go to an address, and every address allowed is recorded in Audit. Where an address redirects to is not covered — that needs a filtering proxy, which is not built yet.")}
        </p>
      </div>
    </div>
  );
}

/** One thing allowed once, with the button that takes it back. */
function Item({ title, detail, action, label, onAction }: { title: string; detail: ReactNode; action: string; label: string; onAction: () => void }) {
  return (
    <li className="flex items-start gap-3 rounded-xl border border-line bg-raised/40 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <span className="text-fg">{title}</span>
        <span className="mt-0.5 block text-xs text-fg-faint">{detail}</span>
      </div>
      <button type="button" className={`${btnCls} shrink-0`} aria-label={label} onClick={onAction}>
        {action}
      </button>
    </li>
  );
}
