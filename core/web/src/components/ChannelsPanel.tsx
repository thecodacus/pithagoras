import { useEffect, useRef, useState } from "react";
import {
  LuCheck,
  LuChevronLeft,
  LuChevronRight,
  LuCircleAlert,
  LuDownload,
  LuFolder,
  LuPackage,
  LuPlus,
  LuRadio,
  LuRefreshCw,
  LuTrash2,
  LuTriangleAlert,
} from "react-icons/lu";
import { api, type Agent, type BrokenChannelPackage, type Channel, type ChannelKind } from "../api";
import { Select } from "./Select";
import { QrCode } from "./QrCode";
import { LoadFailed, Switch, SwitchTrack, btnCls, gridCls, inputCls, primaryCls } from "./SettingsUi";
import { confirmDialog } from "./ConfirmDialog";
import { useUnsavedDraft } from "./Modal";
import { pollWhileVisible } from "../poll";
import { isEnter } from "../shortcuts";
import { formatTime, labelOf, msg, t, tp, tx } from "../i18n";
import { useFlash } from "../use-flash";

const STATE_STYLE: Record<string, string> = {
  running: "text-ok",
  starting: "text-warn",
  error: "text-danger",
  stopped: "text-fg-subtle",
};
const STATE_LABEL: Record<string, string> = {
  running: msg("running"),
  starting: msg("starting"),
  error: msg("error"),
  stopped: msg("stopped"),
};
const stateLabel = (state: string) => labelOf(STATE_LABEL, state);


/**
 * Channels are two-way links into an agent: each talks as one, the first
 * unless it is given another, and its conversations happen in that agent's
 * home. So this reads as "ways to reach the agents" rather than a list of
 * separate bots.
 */
export function ChannelsPanel({ onError }: { onError: (e: string) => void }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [kinds, setKinds] = useState<ChannelKind[]>([]);
  const [broken, setBroken] = useState<BrokenChannelPackage[]>([]);
  const [home, setHome] = useState("");
  const [spec, setSpec] = useState("");
  const [installing, setInstalling] = useState(false);
  // The same, readable by a second Enter that comes before the draw.
  const installingNow = useRef(false);
  const [loading, setLoading] = useState(true);
  // Why the first read failed: "No channels yet" would say that none were set up.
  const [failed, setFailed] = useState<string | null>(null);
  const had = useRef(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api.channels();
      had.current = true;
      setFailed(null);
      setChannels(r.channels);
      setKinds(r.kinds);
      setBroken(r.broken ?? []);
      setHome(r.agentHome);
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
    // Channels start, fail and log on their own schedule, so the page follows.
    return pollWhileVisible(load, 4000);
  }, []);

  const kindOf = (id: string) => kinds.find((k) => k.id === id);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const install = async () => {
    // Enter in the field gets here without the disabled button's say.
    if (installingNow.current) return;
    installingNow.current = true;
    setInstalling(true);
    try {
      await api.installChannelPackage(spec.trim());
      setSpec("");
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      installingNow.current = false;
      setInstalling(false);
    }
  };

  const open = channels.find((c) => c.id === openId);
  if (openId && open) {
    return (
      <ChannelDetail
        channel={open}
        kind={kindOf(open.kind)}
        onBack={() => setOpenId(null)}
        onError={onError}
        onChanged={load}
      />
    );
  }

  return (
    <>
      <section className="mb-6 rounded-xl border border-line bg-raised/40 p-3">
        <div className="flex items-center gap-2">
          <LuFolder className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
          <p className="text-xs text-fg-subtle">{t("Agent home")}</p>
          <p className="ml-auto truncate pl-3 font-mono text-xs text-fg-muted">{home || "…"}</p>
        </div>
        <p className="mt-1.5 text-xs text-fg-faint">
          {t("Every channel below is a door into one long-lived session running here. They share the agent's memory rather than each starting a conversation of their own.")}
        </p>
      </section>

      <section className="mb-6">
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            {t("Channels")}{channels.length ? ` (${channels.length})` : ""}
          </h3>
          <button onClick={load} className="text-[11px] text-fg-subtle hover:text-fg-muted">
            {t("Refresh")}
          </button>
        </div>

        {loading ? (
          <p className="mt-2 text-sm text-fg-subtle">{t("Loading…")}</p>
        ) : failed && !had.current ? (
          <div className="mt-2">
            <LoadFailed error={failed} onRetry={load} />
          </div>
        ) : channels.length === 0 ? (
          <div className="mt-2 rounded-xl border border-dashed border-line px-3 py-6 text-center text-sm text-fg-subtle">
            {t("No channels yet.")}
            <p className="mt-1 text-xs text-fg-faint">
              {t("Add one below to reach the agent from outside the portal.")}
            </p>
          </div>
        ) : (
          <ul className={`mt-2 ${gridCls}`}>
            {channels.map((ch) => (
              <ChannelRow
                key={ch.id}
                channel={ch}
                kind={kindOf(ch.kind)}
                onOpen={() => setOpenId(ch.id)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="mb-6">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">{t("Add channel")}</h3>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {kinds.map((k) => (
            <button
              key={k.id}
              aria-pressed={adding === k.id}
              onClick={() => setAdding(adding === k.id ? null : k.id)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm transition ${
                adding === k.id
                  ? "bg-accent/12 text-accent ring-1 ring-inset ring-accent/25"
                  : "bg-fg/5 text-fg-muted hover:bg-fg/10"
              }`}
            >
              <LuPlus className="h-3.5 w-3.5" />
              {k.label}
            </button>
          ))}
        </div>

        {adding && kindOf(adding) && (
          <NewChannelForm
            kind={kindOf(adding)!}
            onCancel={() => setAdding(null)}
            onError={onError}
            onCreated={async (created) => {
              setAdding(null);
              await load();
              setOpenId(created.id);
            }}
          />
        )}
      </section>

      <section className="mb-6">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">{t("Packages")}</h3>
        <p className="mt-0.5 text-xs text-fg-subtle">
          {t("Channel types come from packages. Point at a GitHub repo following the convention and it becomes available above.")}
        </p>

        <div className="mt-2 flex gap-2">
          <input
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            onKeyDown={(e) => isEnter(e) && spec.trim() && install()}
            placeholder="user/repo"
            aria-label={t("GitHub repo of a channel package")}
            className={`${inputCls} font-mono text-xs`}
          />
          <button
            disabled={!spec.trim() || installing}
            onClick={install}
            className={primaryCls}
          >
            {installing ? (
              <LuRefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <LuDownload className="h-4 w-4" />
            )}
            {installing ? t("Installing…") : t("Install")}
          </button>
        </div>
        <p className="mt-1 text-[11px] text-fg-faint">
          {tx("Anything npm understands: {short}, {long}, a git URL, or an npm package name.", { short: <code>user/repo</code>, long: <code>github:user/repo#v2</code> })}
        </p>

        <ul className="mt-3 space-y-1">
          {kinds.map((k) => (
            <li
              key={k.packageName}
              className="flex items-center gap-2 rounded-lg border border-line bg-raised/40 px-3 py-2"
            >
              <LuPackage className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-fg-muted">
                  {k.label}{" "}
                  <span className="font-mono text-[10px] text-fg-faint">{k.packageName}</span>
                </p>
                {!k.runnable && (
                  <p className="text-[10px] text-warn/90">{t("no start() — cannot run")}</p>
                )}
              </div>
              {k.version && (
                <span className="shrink-0 font-mono text-[10px] text-fg-faint">v{k.version}</span>
              )}
              {k.builtin ? (
                <span className="shrink-0 rounded bg-fg/5 px-1.5 py-0.5 text-[10px] text-fg-subtle">
                  {t("builtin")}
                </span>
              ) : (
                <button
                  onClick={async () => {
                    if (
                      await confirmDialog({
                        title: t("Uninstall {name}?", { name: k.packageName }),
                        message: t("Configured channels are kept."),
                        confirmLabel: t("Uninstall"),
                        danger: true,
                        deletes: true,
                      })
                    ) {
                      act(() => api.removeChannelPackage(k.packageName));
                    }
                  }}
                  className="shrink-0 rounded p-1 text-fg-subtle hover:text-danger"
                  title={t("Uninstall")}
                  aria-label={t("Uninstall")}
                >
                  <LuTrash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>

        {broken.length > 0 && (
          <ul className="mt-2 space-y-1">
            {broken.map((b) => (
              <li
                key={b.packageName}
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
              >
                <LuCircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div className="min-w-0">
                  <p className="truncate font-mono text-[11px]">{b.packageName}</p>
                  <p className="text-[11px] text-danger/80">{b.error}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex items-start gap-2 rounded-xl border border-line bg-raised/40 px-3 py-2 text-xs text-fg-subtle">
        <LuTriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-faint" />
        <p>
          {t("An enabled channel is started as soon as you save it, and again when the portal restarts. Each conversation it sees becomes its own session on the Agents page, with the agent it talks as.")}
        </p>
      </div>
    </>
  );
}

function Toggle({
  on,
  onChange,
  label,
  hint,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left transition hover:bg-fg/5"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm text-fg">{label}</p>
        <p className="text-[11px] text-fg-subtle">{hint}</p>
      </div>
      <SwitchTrack on={on} />
    </button>
  );
}

/** A row in the list. Clicking it opens the channel's own page. */
function ChannelRow({
  channel: ch,
  kind,
  onOpen,
}: {
  channel: Channel;
  kind?: ChannelKind;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        onClick={onOpen}
        className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-raised/40 px-3 py-2.5 text-left transition hover:bg-fg/5"
      >
        <LuRadio
          className={`h-4 w-4 shrink-0 ${
            ch.state === "running"
              ? "text-ok"
              : ch.state === "error"
                ? "text-danger"
                : "text-fg-faint"
          }`}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-fg">{ch.name}</p>
          <p className="truncate text-[11px] text-fg-faint">
            <span className={STATE_STYLE[ch.state] ?? ""}>{stateLabel(ch.state)}</span> ·{" "}
            {kind?.label ?? ch.kind} · {ch.slug}
            {ch.sessionCount ? ` · ${tp(ch.sessionCount, "{n} chat", "{n} chats")}` : ""}
            {ch.instructions ? ` · ${t("instructions")}` : ""}
          </p>
        </div>
        {!ch.enabled && (
          <span className="shrink-0 rounded bg-fg/5 px-1.5 py-0.5 text-[10px] text-fg-subtle">
            {t("disabled")}
          </span>
        )}
        <LuChevronRight className="h-4 w-4 shrink-0 text-fg-faint" />
      </button>
    </li>
  );
}

/**
 * One channel's own page inside the modal. The list only has room for a name
 * and a toggle; everything that needs explaining — credentials, and the
 * instructions appended for messages arriving here — lives here instead.
 */
function ChannelDetail({
  channel: ch,
  kind,
  onBack,
  onError,
  onChanged,
}: {
  channel: Channel;
  kind?: ChannelKind;
  onBack: () => void;
  onError: (e: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState(ch.name);
  const [values, setValues] = useState<Record<string, string>>({ ...ch.config });
  const [instructions, setInstructions] = useState(ch.instructions ?? "");
  const [slug, setSlug] = useState(ch.slug);
  const [relayProgress, setRelayProgress] = useState(ch.relayProgress);
  const [relayTools, setRelayTools] = useState(ch.relayTools);
  const [agentId, setAgentId] = useState(ch.agentId);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, flashSaved] = useFlash();

  // Whether the fields say something other than `from` does: a draft, against what they were filled from.
  const differs = (from: Channel) =>
    name !== from.name ||
    slug !== from.slug ||
    relayProgress !== from.relayProgress ||
    relayTools !== from.relayTools ||
    agentId !== from.agentId ||
    instructions !== (from.instructions ?? "") ||
    kind?.fields.some((f) => (values[f.key] ?? "") !== (from.config[f.key] ?? ""));
  const dirty = differs(ch);
  useUnsavedDraft(!!dirty);

  const fill = (from: Channel) => {
    setName(from.name);
    setValues({ ...from.config });
    setInstructions(from.instructions ?? "");
    setSlug(from.slug);
    setRelayProgress(from.relayProgress);
    setRelayTools(from.relayTools);
    setAgentId(from.agentId);
  };
  // The fields as they are now, for a save that finishes after more was typed.
  const live = useRef({ name, values, instructions, slug, relayProgress, relayTools, agentId });
  live.current = { name, values, instructions, slug, relayProgress, relayTools, agentId };

  // What the form was last filled from: the fields are filled again from the channel
  // for another channel, after this form's own save (see `save`), or when nothing typed
  // would be lost, that is, when they still say what the channel said before. A change
  // of `updated_at` that is no save of this form (the enable switch saves at once, and
  // another admin or tab can change a channel) must not take a draft away, and must not
  // be missed by a form that has none.
  const filled = useRef({ id: ch.id, from: ch });
  useEffect(() => {
    const was = filled.current;
    if (ch.id === was.id && differs(was.from) && dirty) return;
    filled.current = { id: ch.id, from: ch };
    fill(ch);
  }, [ch.id, ch.updated_at]);

  useEffect(() => {
    api.agents().then((r) => setAgents(r.agents), () => setAgents([]));
  }, []);

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

  const save = () =>
    act(async () => {
      const sent = JSON.stringify(live.current);
      const stored = await api.updateChannel(ch.id, {
        name,
        slug,
        config: values,
        instructions,
        relayProgress,
        relayTools,
        ...(agentId !== ch.agentId ? { agentId } : {}),
      });
      // What the server kept is what the form is filled from now, as the channel's
      // own poll may have brought it before this answer, and the reload that follows
      // may then have nothing new in it for the effect to see. Not for a channel the
      // form has moved on from while this was on its way. The server trims, so unless
      // more was typed since, the fields show what it kept.
      if (filled.current.id === stored.id) {
        filled.current = { id: stored.id, from: stored };
        if (JSON.stringify(live.current) === sent) fill(stored);
      }
      flashSaved();
    });

  return (
    <>
      <button
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-fg-subtle transition hover:text-fg-muted"
      >
        <LuChevronLeft className="h-3.5 w-3.5" /> {t("Channels")}
      </button>

      <div className="mb-5 flex items-start gap-3">
        <div
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
            ch.state === "running"
              ? "bg-ok/10 text-ok"
              : ch.state === "error"
                ? "bg-danger/10 text-danger"
                : "bg-fg/5 text-fg-subtle"
          }`}
        >
          <LuRadio className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label={t("Channel name")}
            className="w-full rounded bg-transparent text-sm font-medium text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          <p className="truncate text-xs text-fg-subtle">
            {kind?.label ?? ch.kind} ·{" "}
            <span className={STATE_STYLE[ch.state] ?? ""}>{stateLabel(ch.state)}</span>
            {ch.since && ch.state === "running" ? ` ${t("since {time}", { time: formatTime(ch.since) })}` : ""}
          </p>
        </div>
        <Switch
          on={ch.enabled}
          onChange={() => act(() => api.updateChannel(ch.id, { enabled: !ch.enabled }))}
          disabled={busy}
          label={ch.name}
          title={ch.enabled ? t("Disable") : t("Enable")}
          className="mt-1"
        />
      </div>

      {ch.error && (
        <div role="alert" className="mb-5 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          <LuCircleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p className="min-w-0">{ch.error}</p>
        </div>
      )}

      {ch.pairing && (
        <section className="mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">{t("Scan to connect")}</h3>
          {/* The package's own words: it knows which app, and which menu in it. */}
          {ch.pairing.hint && <p className="mt-0.5 text-xs text-fg-subtle">{ch.pairing.hint}</p>}
          <QrCode text={ch.pairing.code} label={t("Code to scan")} className="mt-2 aspect-square w-56 max-w-full" />
          <p className="mt-2 break-all font-mono text-[11px] text-fg-faint">{ch.pairing.code}</p>
        </section>
      )}

      <section className="mb-6">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">{t("Identity")}</h3>
        <p className="mt-0.5 text-xs text-fg-subtle">
          {t("The agent's conversations hang off this slug, not off the channel itself. Delete this channel and recreate it under the same slug and its conversations come back; change the slug and it starts fresh.")}
        </p>
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          aria-label={t("Slug")}
          className={`${inputCls} mt-2 font-mono text-xs`}
        />
        <p className="mt-1 text-[11px] text-fg-faint">
          {ch.sessionCount > 0
            ? tp(ch.sessionCount, "{n} conversation keyed to \"{slug}\".", "{n} conversations keyed to \"{slug}\".", { slug: ch.slug })
            : t("No conversations yet.")}
        </p>
      </section>

      <section className="mb-6">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
          {t("Talks as")}
        </h3>
        <p className="mt-0.5 text-xs text-fg-subtle">
          {t("The agent that answers here, with its own character and memory. Moved to another, it starts new conversations; moved back, it picks up the ones it had.")}
        </p>
        <Select
          className="mt-2 w-full"
          aria-label={t("Talks as")}
          value={agentId}
          onChange={setAgentId}
          placeholder={t("Loading…")}
          options={(agents ?? []).map((a) => ({ value: a.id, label: a.name, text: a.name, hint: a.home }))}
        />
      </section>

      <section className="mb-6">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
          {t("While it works")}
        </h3>
        <p className="mt-0.5 text-xs text-fg-subtle">
          {t("A real task takes minutes. These decide whether the chat shows that, or stays quiet until there is an answer.")}
        </p>
        <div className="mt-2 space-y-1">
          <Toggle
            on={relayProgress}
            onChange={setRelayProgress}
            label={t("Progress")}
            hint={t("What the agent says between tool calls, as it says it")}
          />
          <Toggle
            on={relayTools}
            onChange={setRelayTools}
            label={t("Tool activity")}
            hint={t("The name of each tool as it runs — ⚙ bash · npm test")}
          />
        </div>
      </section>

      <section className="mb-6">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
          {t("Instructions")}
        </h3>
        <p className="mt-0.5 text-xs text-fg-subtle">
          {t("Added to every message that arrives through this channel. Use it for standing guidance that only applies here — the shape of the reply, who is on the other end, what to leave out.")}
        </p>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          aria-label={t("Instructions")}
          rows={6}
          placeholder={t("You are answering over {channel}. Keep replies short — they are read on a phone. Never paste secrets or full file contents.", { channel: kind?.label ?? t("this channel") })}
          className={`${inputCls} mt-2 resize-y text-xs leading-relaxed`}
        />
        <p className="mt-1 text-[11px] text-fg-faint">
          {t("Leave empty for none. The agent's own memory is shared across channels; this is not.")}
        </p>
      </section>

      {kind && kind.fields.length > 0 && (
        <section className="mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            {t("Connection")}
          </h3>
          <div className="mt-2 space-y-3">
            {kind.fields.map((f) => (
              <div key={f.key}>
                <div className="flex items-baseline gap-2">
                  <label className="font-mono text-xs text-fg-muted">{f.label}</label>
                  {f.secret &&
                    (ch.secretsSet.includes(f.key) ? (
                      <span className="text-[10px] text-ok/80">{t("stored")}</span>
                    ) : (
                      <span className="text-[10px] text-fg-faint">{t("not set")}</span>
                    ))}
                </div>
                <input
                  type={f.secret ? "password" : "text"}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  aria-label={f.label}
                  placeholder={
                    f.secret && ch.secretsSet.includes(f.key)
                      ? t("leave blank to keep the stored value")
                      : f.placeholder
                  }
                  className={`${inputCls} mt-1 font-mono text-xs`}
                />
                {f.hint && <p className="mt-1 text-[11px] text-fg-faint">{f.hint}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {!kind && (
        <div role="alert" className="mb-6 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          <LuCircleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            {t("No installed package provides “{kind}”. Reinstall it to edit this channel, or delete the channel below.", { kind: ch.kind })}
          </p>
        </div>
      )}

      {ch.log.length > 0 && (
        <section className="mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">{t("Activity")}</h3>
          <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto rounded-xl border border-line bg-raised/60 p-2">
            {[...ch.log].reverse().map((entry, i) => (
              <li key={i} className="flex gap-2 font-mono text-[11px]">
                <span className="shrink-0 text-fg-faint">
                  {formatTime(entry.at)}
                </span>
                <span className="min-w-0 text-fg-muted">{entry.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex items-center gap-2">
        <button onClick={save} disabled={busy || !dirty} className={primaryCls}>
          {busy ? (
            <LuRefreshCw className="h-4 w-4 animate-spin" />
          ) : saved ? (
            <>
              <LuCheck className="h-4 w-4" /> {t("Saved")}
            </>
          ) : (
            t("Save")
          )}
        </button>
        <button
          onClick={async () => {
            // Say what happens to the conversations rather than leaving someone
            // to discover later that the agent forgot them.
            const fate =
              ch.sessionCount > 0
                ? tp(ch.sessionCount, "Its conversation is kept, and comes back if you recreate a channel with the slug \"{slug}\".", "Its {n} conversations are kept, and come back if you recreate a channel with the slug \"{slug}\".", { slug: ch.slug })
                : "";
            if (
              await confirmDialog({
                title: t("Remove \"{name}\"?", { name: ch.name }),
                message: fate || undefined,
                confirmLabel: t("Remove"),
                danger: true,
                deletes: true,
              })
            ) {
              act(async () => {
                await api.deleteChannel(ch.id);
                onBack();
              });
            }
          }}
          disabled={busy}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-fg-subtle transition hover:bg-danger/10 hover:text-danger disabled:opacity-40"
        >
          <LuTrash2 className="h-3.5 w-3.5" /> {t("Remove channel")}
        </button>
      </div>
    </>
  );
}

function NewChannelForm({
  kind,
  onCancel,
  onCreated,
  onError,
}: {
  kind: ChannelKind;
  onCancel: () => void;
  onCreated: (created: Channel) => Promise<void>;
  onError: (e: string) => void;
}) {
  const [name, setName] = useState(kind.label);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useUnsavedDraft(!busy && (name !== kind.label || Object.values(values).some((v) => v.trim() !== "")));

  useEffect(() => {
    setName(kind.label);
    setValues({});
  }, [kind.id]);

  const create = async () => {
    setBusy(true);
    try {
      const created = await api.createChannel(kind.id, name, values);
      await onCreated(created);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-line bg-raised/40 p-3">
      <p className="text-xs text-fg-subtle">{kind.blurb}</p>

      <div>
        <label className="text-xs text-fg-muted">{t("Name")}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label={t("Name")}
          className={`${inputCls} mt-1`}
        />
      </div>

      {kind.fields.map((f) => (
        <div key={f.key}>
          <div className="flex items-baseline gap-2">
            <label className="font-mono text-xs text-fg-muted">{f.label}</label>
            {f.required && <span className="text-[10px] text-fg-faint">{t("required")}</span>}
          </div>
          <input
            type={f.secret ? "password" : "text"}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            aria-label={f.label}
            placeholder={f.placeholder}
            className={`${inputCls} mt-1 font-mono text-xs`}
          />
          {f.hint && <p className="mt-1 text-[11px] text-fg-faint">{f.hint}</p>}
        </div>
      ))}

      <div className="flex items-center gap-2">
        <button onClick={create} disabled={busy} className={primaryCls}>
          {busy ? <LuRefreshCw className="h-4 w-4 animate-spin" /> : t("Add channel")}
        </button>
        <button onClick={onCancel} className={btnCls}>
          {t("Cancel")}
        </button>
      </div>
    </div>
  );
}
