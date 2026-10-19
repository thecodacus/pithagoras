import { useEffect, useRef, useState, type ReactNode } from "react";
import { LuRefreshCw } from "react-icons/lu";
import { api, type GuardState } from "../api";
import { formatDateTime, msg, t, tp } from "../i18n";
import type { Tab } from "../settings-tabs";
import { DetailsGroup, Empty, LoadFailed, Section, SwitchRow, WarnBanner, btnCls, ghostCls } from "./SettingsUi";

/** What each rule after a suspected injection holds back, by its name, as the page says it. */
const RULE_TEXT: Record<string, string> = {
  "pipe-to-shell": msg("Running something downloaded, or piped in, without anyone reading it first"),
  "write-to-path": msg("Writing a file onto PATH, where it runs later without anyone asking for it"),
  upload: msg("Sending data out of the box: a body to a web address, a copy to another machine or a bucket, mail"),
  "read-credentials": msg("Reading where keys and tokens are kept"),
  publish: msg("Pushing to a git remote, which cannot be undone from here"),
  persist: msg("Scheduling work, or changing what the agent loads as its own instructions, tools or code"),
  delegate: msg("Starting a subagent or a routine, which work without this conversation's rules"),
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

/** A line of the guard's state: what it is, how it stands, and the tab where it is set. */
function StatusRow({ label, value, warn, tab, onOpen }: { label: string; value: string; warn?: boolean; tab: Tab; onOpen: (tab: Tab) => void }) {
  return (
    <li className="flex items-center gap-3 rounded-xl border border-line bg-raised/40 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 text-fg-muted">{label}</span>
      <span className={warn ? "text-warn" : "text-fg"}>{value}</span>
      <button type="button" className={ghostCls} onClick={() => onOpen(tab)}>
        {t("Open")}
      </button>
    </li>
  );
}

/**
 * Settings → Guard: what the guard holds the agent to, and the little of it that is a switch. A routine may be let
 * do what a rule after a suspected injection holds back, one rule at a time; an MCP server may be counted as the
 * person's own; what was allowed once, an approval not yet spent or a flagged result that was trusted, may be taken
 * back. The rest is shown with its reason. Each change is saved at once, as the tool switches are.
 */
export function GuardSettings({ onError, onOpen }: { onError: (message: string) => void; onOpen: (tab: Tab) => void }) {
  const [state, setState] = useState<GuardState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const had = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);

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

  if (failed && !had.current) return <LoadFailed error={failed} onRetry={load} />;
  if (!state) {
    return (
      <p className="flex items-center gap-2 text-sm text-fg-subtle">
        <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Loading…")}
      </p>
    );
  }

  /** A change, shown at once and saved; the page is read again if the server says no, so that it shows what holds. */
  const change = async (key: string, next: GuardState, save: () => Promise<unknown>) => {
    const before = state;
    setState(next);
    setBusy(key);
    try {
      await save();
    } catch (e) {
      setState(before);
      onError((e as Error).message);
      void load();
    } finally {
      setBusy(null);
    }
  };

  const ruleText = (name: string) => (RULE_TEXT[name] ? t(RULE_TEXT[name]) : state.rules.find((rule) => rule.name === name)?.why ?? name);
  const sandbox = state.sandbox === "on" ? t("On") : state.sandbox === "off" ? t("Off") : t("Not available here");

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
        hint={t("Once a result the agent read looks like it tries to instruct it, these are refused in that conversation until you trust the result or remove its turn.")}
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
              <DetailsGroup
                key={routine.id}
                title={routine.name}
                summary={
                  routine.exempt.length === 0
                    ? t("Every rule holds")
                    : routine.exempt.length === state.rules.length
                      ? t("Every rule is off")
                      : t("Off: {rules}", { rules: routine.exempt.join(", ") })
                }
              >
                {state.rules.map((rule) => {
                  const holds = !routine.exempt.includes(rule.name);
                  return (
                    <SwitchRow
                      key={rule.name}
                      title={rule.name}
                      detail={ruleText(rule.name)}
                      on={holds}
                      disabled={busy !== null}
                      onChange={(on) => {
                        const exempt = on ? routine.exempt.filter((name) => name !== rule.name) : [...routine.exempt, rule.name];
                        const next = { ...state, routines: state.routines.map((one) => (one.id === routine.id ? { ...one, exempt } : one)) };
                        void change(`routine:${routine.id}`, next, () => api.setGuardRoutine(routine.id, exempt));
                      }}
                    />
                  );
                })}
              </DetailsGroup>
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
            {state.servers.map((server) => (
              <SwitchRow
                key={server.name}
                title={server.name}
                detail={
                  server.browser
                    ? t("The browser's pages are anybody's words: always outside content.")
                    : server.trusted
                      ? t("Counted as your own: what it says is neither marked nor checked.")
                      : t("Outside content: what it says is marked and checked.")
                }
                on={server.trusted}
                disabled={server.browser || busy !== null}
                onChange={(trusted) => {
                  const next = { ...state, servers: state.servers.map((one) => (one.name === server.name ? { ...one, trusted } : one)) };
                  void change(`server:${server.name}`, next, () => api.setGuardServer(server.name, trusted));
                }}
              />
            ))}
          </div>
        )}
      </Section>

      <Section
        title={t("Allowed once")}
        hint={t("Approvals the primary user gave for one go that are not spent yet. Each runs out after 15 minutes; take one back before then if it should not run.")}
      >
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
                    <span className="font-mono">{approval.tool}</span>: <span className="font-mono break-all">{approval.subject}</span>
                    <span className="block">{t("Runs out at {time}", { time: formatDateTime(approval.expiresAt, { timeStyle: "short" }) })}</span>
                  </>
                }
                action={t("Revoke")}
                busy={busy === `approval:${approval.id}`}
                onAction={() => {
                  const next = { ...state, approvals: state.approvals.filter((one) => one.id !== approval.id) };
                  void change(`approval:${approval.id}`, next, () => api.revokeApproval(approval.id));
                }}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={t("Trusted results")}
        hint={t("Results flagged as a suspected injection that you looked at and trusted, so that they no longer hold their chat back. Take the trust back and the chat is held again.")}
      >
        {state.trusted.length === 0 ? (
          <Empty>{t("Nothing flagged has been trusted.")}</Empty>
        ) : (
          <ul className="space-y-1.5">
            {state.trusted.flatMap((chat) =>
              chat.results.map((result) => (
                <Item
                  key={`${chat.sessionId}:${result.id}`}
                  title={chat.chat ?? t("A chat that was deleted")}
                  detail={
                    <>
                      {result.tool && <span className="font-mono">{result.tool}</span>}
                      {result.signals?.length ? <span>{` · ${tp(result.signals.length, "{n} sign", "{n} signs", { n: result.signals.length })}: ${result.signals.join(", ")}`}</span> : null}
                      {result.excerpt && <span className="block truncate">{result.excerpt}</span>}
                    </>
                  }
                  action={t("Un-trust")}
                  busy={busy === `trusted:${result.id}`}
                  onAction={() => {
                    const next = {
                      ...state,
                      trusted: state.trusted
                        .map((one) => (one.sessionId === chat.sessionId ? { ...one, results: one.results.filter((r) => r.id !== result.id) } : one))
                        .filter((one) => one.results.length),
                    };
                    void change(`trusted:${result.id}`, next, () => api.untrustResult(chat.sessionId, result.id));
                  }}
                />
              )),
            )}
          </ul>
        )}
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

/** One thing allowed once, with the button that takes it back. */
function Item({ title, detail, action, busy, onAction }: { title: string; detail: ReactNode; action: string; busy: boolean; onAction: () => void }) {
  return (
    <li className="flex items-start gap-3 rounded-xl border border-line bg-raised/40 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <span className="text-fg">{title}</span>
        <span className="mt-0.5 block text-xs text-fg-faint">{detail}</span>
      </div>
      <button type="button" className={btnCls} disabled={busy} onClick={onAction}>
        {action}
      </button>
    </li>
  );
}
