import { useEffect, useRef, useState } from "react";
import {
  LuCheck,
  LuChevronLeft,
  LuChevronRight,
  LuCircleUser,
  LuPlus,
  LuRefreshCw,
  LuTrash2,
  LuTriangleAlert,
} from "react-icons/lu";
import { api, type Person, type Role, type ToolRule } from "../api";
import { LoadFailed, Segments, gridCls, inputCls, primaryCls } from "./SettingsUi";
import { labelOf, msg, t, tp, tx } from "../i18n";
import { useFlash } from "../use-flash";
import { confirmDialog } from "./ConfirmDialog";
import { useUnsavedDraft } from "./Modal";


const ROLES: { id: Role; label: string; hint: string }[] = [
  { id: "primary", label: msg("Primary"), hint: msg("You. Everything.") },
  {
    id: "colleague",
    label: msg("Colleague"),
    hint: msg("Reads, searches, explains. Anything else needs your say-so."),
  },
  { id: "guest", label: msg("Guest"), hint: msg("Answers what they ask and volunteers nothing.") },
  { id: "unknown", label: msg("Blocked"), hint: msg("Turned away before reaching the agent.") },
];

const roleLabel = (id: string) => {
  const role = ROLES.find((r) => r.id === id);
  return role ? t(role.label) : id;
};

/** Who a rule for a whole role reaches, said of them all. */
const EVERYONE: Record<string, string> = {
  primary: msg("the primary user"),
  colleague: msg("all colleagues"),
  guest: msg("all guests"),
  unknown: msg("everyone blocked"),
  heartbeat: msg("every agent's heartbeat"),
};

const ROLE_STYLE: Record<string, string> = {
  primary: "text-accent",
  colleague: "text-fg-muted",
  guest: "text-fg-subtle",
  unknown: "text-warn",
};

/**
 * Everyone who has spoken to the agent.
 *
 * A list of names, and a page each. The roster is read far more often than it
 * is changed — usually to see whether somebody got through — so the settings
 * live one click in rather than in every row.
 *
 * Strangers appear here having already been refused: the list is how you let
 * somebody in, not a log of who got through.
 */
export function PeoplePanel({ onError }: { onError: (e: string) => void }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [rules, setRules] = useState<ToolRule[]>([]);
  const [loading, setLoading] = useState(true);
  // Why the first read failed: "Nobody yet" would say that nobody has written.
  const [failed, setFailed] = useState<string | null>(null);
  const had = useRef(false);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const load = async () => {
    try {
      const [p, r] = await Promise.all([api.people(), api.toolRules()]);
      had.current = true;
      setFailed(null);
      setPeople(p.people);
      setRules(r.rules);
    } catch (e) {
      // A refresh of what is shown goes to the banner; with nothing read yet the page says it itself.
      if (had.current) onError((e as Error).message);
      else setFailed((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-fg-subtle">
        <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Loading…")}
      </p>
    );
  }

  if (failed && !had.current) return <LoadFailed error={failed} onRetry={load} />;

  const open = people.find((p) => p.key === openKey);
  if (open) {
    return (
      <PersonDetail
        person={open}
        // The last primary user: without one the agent lets everybody in (see the people route).
        onlyPrimary={open.role === "primary" && !people.some((p) => p.role === "primary" && p.key !== open.key)}
        rules={rules.filter((r) => r.person_key === open.key)}
        onBack={() => setOpenKey(null)}
        onChanged={load}
        onError={onError}
      />
    );
  }

  const waiting = people.filter((p) => p.role === "unknown");
  const roleWide = rules.filter((r) => !r.person_key);

  return (
    <>
      {waiting.length > 0 && (
        <section className="mb-4 flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/10 p-3">
          <LuTriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
          <p className="text-xs text-fg-muted">
            {tp(waiting.length, "Someone has messaged the agent and been turned away. Open them to let them through.", "{n} people have messaged the agent and been turned away. Open them to let them through.")}
          </p>
        </section>
      )}

      <p className="mb-3 text-xs text-fg-faint">
        {t("The agent only talks to people listed here. Identities come from the platform's own id, so renaming themselves changes nothing.")}
      </p>

      {people.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-fg-faint">
          {t("Nobody yet. People appear here the first time they message a channel.")}
        </p>
      ) : (
        <ul className={gridCls}>
          {people.map((p) => (
            <li key={p.key} className="min-w-0">
              <button
                onClick={() => setOpenKey(p.key)}
                className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-raised/40 px-3 py-2 text-left transition hover:bg-fg/5"
              >
                <LuCircleUser className="h-4 w-4 shrink-0 text-fg-faint" />
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{p.name}</span>
                <span className={`shrink-0 text-xs ${ROLE_STYLE[p.role] ?? "text-fg-subtle"}`}>
                  {roleLabel(p.role)}
                </span>
                <LuChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {roleWide.length > 0 && (
        <section className="mt-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            {t("Allowed for a whole role")}
          </h3>
          <ul className="mt-2 space-y-1">
            {roleWide.map((r) => (
              <RuleRow
                key={r.id}
                rule={r}
                scope={labelOf(EVERYONE, r.role, (role) => t("everyone with the role {role}", { role }))}
                onDelete={async () => {
                  try {
                    setRules((await api.deleteToolRule(r.id)).rules);
                  } catch (e) {
                    onError((e as Error).message);
                  }
                }}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function RuleRow({
  rule,
  scope,
  onDelete,
}: {
  rule: ToolRule;
  scope?: string;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center gap-2 rounded-lg border border-line bg-raised/40 py-1 pl-2.5 pr-1">
      {scope && (
        <span className="shrink-0 rounded bg-fg/5 px-1.5 py-0.5 text-[11px] text-fg-muted">
          {scope}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted">
        {rule.tool}: {rule.pattern}
      </span>
      <button
        onClick={onDelete}
        title={t("Revoke")}
        aria-label={t("Revoke")}
        className="shrink-0 rounded-lg p-1 text-fg-faint transition hover:bg-danger/10 hover:text-danger"
      >
        <LuTrash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

function PersonDetail({
  person,
  onlyPrimary,
  rules,
  onBack,
  onChanged,
  onError,
}: {
  person: Person;
  onlyPrimary: boolean;
  rules: ToolRule[];
  onBack: () => void;
  onChanged: () => Promise<void>;
  onError: (e: string) => void;
}) {
  const [name, setName] = useState(person.name);
  const [role, setRole] = useState<Role>(person.role);
  const [notes, setNotes] = useState(person.notes);
  const [tool, setTool] = useState("bash");
  const [pattern, setPattern] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, flashSaved] = useFlash();

  // The fields are filled from the person for another person, or when nothing typed
  // would be lost: when they still say what the person said before. This form's own
  // save sets them from what the server kept (it keeps the name and the notes trimmed,
  // so what was typed is not what is stored), which the reload that follows then finds
  // as they are: there is no change for an effect to wait for when the trimmed text
  // is what was stored before.
  const differs = (from: Person) => name !== from.name || role !== from.role || notes !== from.notes;
  const dirty = differs(person);
  const filled = useRef(person);
  useEffect(() => {
    const was = filled.current;
    if (person.key === was.key && differs(was) && dirty) return;
    filled.current = person;
    setName(person.name);
    setRole(person.role);
    setNotes(person.notes);
  }, [person.key, person.name, person.role, person.notes]);

  useUnsavedDraft(dirty);
  /** Said when this would leave nobody primary, which opens every channel to anybody. */
  const noPrimaryLeft = {
    message: t("This is the only primary user. With none, every channel lets anybody in with a primary user's rights, until you name another."),
    danger: true,
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1 text-xs text-fg-subtle transition hover:text-fg-muted"
        >
          <LuChevronLeft className="h-3.5 w-3.5" /> {t("People")}
        </button>
        <span className="ml-auto truncate font-mono text-[11px] text-fg-faint">{person.key}</span>
        <button
          disabled={busy}
          title={t("Forget — the next message from them arrives as a stranger again")}
          aria-label={t("Forget")}
          onClick={async () => {
            const ok = onlyPrimary
              ? await confirmDialog({ title: t("Forget the only primary user?"), confirmLabel: t("Forget"), ...noPrimaryLeft })
              : await confirmDialog({
                  title: t("Forget {name}?", { name: person.name }),
                  message: t("The next message from them arrives as a stranger again."),
                  confirmLabel: t("Forget"),
                  danger: true,
                  deletes: true,
                });
            if (!ok) return;
            act(async () => {
              await api.forgetPerson(person.key, onlyPrimary);
              onBack();
            });
          }}
          className="rounded-lg p-1 text-fg-faint transition hover:bg-danger/10 hover:text-danger"
        >
          <LuTrash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs text-fg-subtle">{t("Name")}</span>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <div>
          <span className="mb-1 block text-xs text-fg-subtle">{t("Role")}</span>
          <Segments label={t("Role")} size="cell" className="grid grid-cols-4 gap-1" value={role} options={ROLES} onChange={setRole} />
          {/* One line for the choice in front of you, rather than four
              descriptions competing for the same attention. */}
          <p className="mt-1 text-[11px] text-fg-faint">
            {t(ROLES.find((r) => r.id === role)?.hint ?? "")}
          </p>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs text-fg-subtle">{t("What the agent should know")}</span>
          <textarea
            className={inputCls}
            rows={2}
            value={notes}
            placeholder={t("Their role, what they work on — repeated to the agent every time they write.")}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        {dirty && (
          <button
            className={primaryCls}
            disabled={busy}
            onClick={async () => {
              const leaving = onlyPrimary && role !== "primary";
              if (leaving && !(await confirmDialog({ title: t("Take away the only primary user's role?"), confirmLabel: t("Save"), ...noPrimaryLeft }))) return;
              act(async () => {
                const { person: stored } = await api.updatePerson(person.key, { name, role, notes, force: leaving || undefined });
                // Not for a person the form has moved on from while this was on its way.
                if (filled.current.key === stored.key) {
                  setName(stored.name);
                  setRole(stored.role);
                  setNotes(stored.notes);
                }
                flashSaved();
              });
            }}
          >
            {busy ? (
              <LuRefreshCw className="h-4 w-4 animate-spin" />
            ) : saved ? (
              <LuCheck className="h-4 w-4" />
            ) : null}
            {t("Save")}
          </button>
        )}
      </div>

      <section className="mt-6">
        <div className="mb-1.5 flex items-baseline gap-2">
          <h3 className="text-sm font-medium text-fg">{t("Allowed anyway")}</h3>
          <span className="text-xs text-fg-faint">{rules.length}</span>
        </div>
        <p className="mb-2 text-[11px] text-fg-faint">
          {tx("What {name} may do despite their role — written by {allow}, revoked by deleting. {star} covers the parts that vary; a shell rule matches one command, never a pipeline.", { name: person.name, allow: <em>{t("Always allow")}</em>, star: <span className="font-mono">*</span> })}
        </p>

        {rules.length > 0 && (
          <ul className="mb-2 space-y-1">
            {rules.map((r) => (
              <RuleRow key={r.id} rule={r} onDelete={() => act(() => api.deleteToolRule(r.id))} />
            ))}
          </ul>
        )}

        <div className="flex gap-1">
          <input
            value={tool}
            onChange={(e) => setTool(e.target.value)}
            placeholder="bash"
            aria-label={t("Tool")}
            className="w-20 rounded-lg border border-line bg-raised/60 px-2 py-1.5 font-mono text-[11px] outline-none focus:border-accent/60"
          />
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="himalaya envelope list*"
            aria-label={t("Pattern")}
            className="min-w-0 flex-1 rounded-lg border border-line bg-raised/60 px-2 py-1.5 font-mono text-[11px] outline-none placeholder:text-fg-faint focus:border-accent/60"
          />
          <button
            disabled={busy || !pattern.trim()}
            onClick={() =>
              act(async () => {
                // "all", since a rule naming somebody applies to them whatever their role is.
                await api.addToolRule({ role: "all", tool, pattern, personKey: person.key });
                setPattern("");
              })
            }
            className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-accent/12 px-2.5 py-1.5 text-[11px] text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20 disabled:opacity-40"
          >
            <LuPlus className="h-3 w-3" /> {t("Allow")}
          </button>
        </div>
      </section>
    </>
  );
}
