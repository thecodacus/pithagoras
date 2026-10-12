import { useEffect, useState } from "react";
import { LuPlus, LuTrash2 } from "react-icons/lu";
import { api, type SandboxAccess, type SandboxPolicy, type SandboxReport, type SandboxState } from "../api";
import { t, tx } from "../i18n";
import { Section, SwitchRow, btnCls, ghostCls, inputCls, primaryCls } from "./SettingsUi";

const ACCESS: { value: SandboxAccess; label: () => string }[] = [
  { value: "none", label: () => t("No access") },
  { value: "read", label: () => t("Read-only") },
  { value: "write", label: () => t("Read & write") },
];

/**
 * Settings → Sandbox: what the agent may read, change and run, put on the files
 * as permissions and held by the operating system. Saved and applied in one
 * go, as a policy that is half put on is worse than either.
 */
export function SandboxSettings({ onError }: { onError: (message: string) => void }) {
  const [state, setState] = useState<SandboxState | null>(null);
  const [draft, setDraft] = useState<SandboxPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<SandboxReport | null>(null);
  const [chats, setChats] = useState<{ reloaded: number; waiting: number } | null>(null);

  useEffect(() => {
    api.sandbox().then((s) => {
      setState(s);
      setDraft(s.policy);
      setReport(s.lastReport);
    }).catch((e) => onError((e as Error).message));
  }, []);

  if (!state || !draft) return null;
  const changed = JSON.stringify(draft) !== JSON.stringify(state.policy);
  const update = (patch: Partial<SandboxPolicy>) => setDraft({ ...draft, ...patch });

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.setSandbox(draft);
      setState({ ...state, policy: r.policy, lastReport: r.report });
      setDraft(r.policy);
      setReport(r.report);
      setChats(r.chats);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Section title={t("Sandbox")} hint={t("What the agent may read, change and run, held by the operating system rather than by what it asks for.")}>
        {!state.available && (
          <p role="status" className="mb-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">{state.reason}</p>
        )}
        <SwitchRow
          title={t("Run the agent in the sandbox")}
          detail={t("Its commands, and everything its file tools do, run as an unprivileged user of the agent's own, which cannot read another agent's home, with an environment that holds none of the portal's secrets. Whatever it tries, a script of its own or a symlink included, meets the permissions below.")}
          on={draft.enabled}
          disabled={!state.available}
          onChange={(enabled) => update({ enabled })}
        />
      </Section>

      <Section
        title={t("Paths")}
        hint={t("The most specific rule decides a path and everything under it. A path no rule names keeps the permissions it has, which for most of the system is readable and not changeable.")}
        action={<button type="button" className={ghostCls} onClick={() => update({ rules: state.defaults.rules })}>{t("Reset to defaults")}</button>}
      >
        <div className="space-y-2">
          {draft.rules.map((rule, i) => (
            <div key={i} className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1 basis-64">
                <input
                  aria-label={t("Path")}
                  className={`${inputCls} font-mono`}
                  value={rule.path}
                  onChange={(e) => update({ rules: draft.rules.map((r, j) => (j === i ? { ...r, path: e.target.value } : r)) })}
                />
                {rule.note && <p className="mt-0.5 text-[11px] text-fg-faint">{rule.note}</p>}
              </div>
              <select
                aria-label={t("Access")}
                className={`${inputCls} w-36`}
                value={rule.access}
                onChange={(e) => update({ rules: draft.rules.map((r, j) => (j === i ? { ...r, access: e.target.value as SandboxAccess } : r)) })}
              >
                {ACCESS.map((a) => <option key={a.value} value={a.value}>{a.label()}</option>)}
              </select>
              <button type="button" className={btnCls} aria-label={t("Remove this path")} onClick={() => update({ rules: draft.rules.filter((_, j) => j !== i) })}>
                <LuTrash2 />
              </button>
            </div>
          ))}
          <button type="button" className={ghostCls} onClick={() => update({ rules: [...draft.rules, { path: "/", access: "read" }] })}>
            <LuPlus className="mr-1 inline" /> {t("Add a path")}
          </button>
        </div>
      </Section>

      <Section
        title={t("Trusted commands")}
        hint={tx("Scripts in {trusted} that the agent can run but not change. They run as pi-tools, the only user that can read the keys in {secrets}, so a command can use a key the agent itself cannot read. Give the command's name; its script has the same name unless you say otherwise. A script already in /data/bin under that name is moved in.", {
          trusted: <span className="font-mono">{state.trustedDir}</span>,
          secrets: <span className="font-mono">{state.secretsDir}</span>,
        })}
      >
        <div className="space-y-2">
          {draft.trusted.map((cmd, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input aria-label={t("Command")} className={`${inputCls} w-48 font-mono`} value={cmd.name}
                onChange={(e) => update({ trusted: draft.trusted.map((c, j) => (j === i ? { ...c, name: e.target.value } : c)) })} />
              <input aria-label={t("Script")} className={`${inputCls} min-w-0 flex-1 font-mono`} value={cmd.script.replace(`${state.trustedDir}/`, "")}
                onChange={(e) => update({ trusted: draft.trusted.map((c, j) => (j === i ? { ...c, script: e.target.value } : c)) })} />
              <button type="button" className={btnCls} aria-label={t("Remove this command")} onClick={() => update({ trusted: draft.trusted.filter((_, j) => j !== i) })}>
                <LuTrash2 />
              </button>
            </div>
          ))}
          <button type="button" className={ghostCls} onClick={() => update({ trusted: [...draft.trusted, { name: "", script: "" }] })}>
            <LuPlus className="mr-1 inline" /> {t("Add a command")}
          </button>
        </div>
      </Section>

      <div className="mb-7 flex items-center gap-3">
        <button type="button" className={primaryCls} disabled={busy || !changed} onClick={save}>
          {busy ? t("Applying…") : t("Save and apply")}
        </button>
        <span className="text-xs text-fg-faint">{t("Applying sets owners and permissions on every file under a read or write rule, which can take a while in a big workspace.")}</span>
      </div>

      {report && (
        <Section title={t("Last applied")}>
          {report.warnings.length > 0 && (
            <ul className="mb-2 space-y-1 text-xs text-warn">{report.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          )}
          {chats && (chats.reloaded > 0 || chats.waiting > 0) && (
            <p className="mb-2 text-xs text-fg-muted">
              {tx("Open chats reloaded with the new tools: {reloaded}. Busy, and switched as soon as they finish: {waiting}.", { reloaded: chats.reloaded, waiting: chats.waiting })}
            </p>
          )}
          <details className="text-xs text-fg-muted">
            <summary className="cursor-pointer">{t("What was done")} ({report.done.length})</summary>
            <ul className="mt-1 space-y-0.5 font-mono text-[11px]">{report.done.map((d, i) => <li key={i}>{d}</li>)}</ul>
          </details>
        </Section>
      )}

      <Section title={t("Not covered yet")}>
        <p className="text-xs text-fg-muted">
          {t("Subagents, MCP servers that pi starts, an extension's own tools that start programs, and the Terminal panel (which is yours, not the agent's) still run as the portal's user. The container executor runs each chat in a container of its own instead, and is not affected by this page.")}
        </p>
      </Section>
    </div>
  );
}
