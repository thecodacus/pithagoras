import { useEffect, useRef, useState } from "react";
import { confirmDialog } from "./ConfirmDialog";
import { useUnsavedDraft } from "./Modal";
import {
  LuChevronLeft,
  LuChevronRight,
  LuCircleAlert,
  LuClipboardPaste,
  LuDownload,
  LuFileJson,
  LuGlobe,
  LuPlus,
  LuRefreshCw,
  LuTerminal,
  LuTrash2,
} from "react-icons/lu";
import { api, type McpConfigView, type McpServerEntry, type McpServerState, type McpServerView, type ToolMark } from "../api";
import { Field, LoadFailed, Segments, btnCls, codeAreaCls, gridCls, inputCls, primaryCls } from "./SettingsUi";
import { formatNumber, msg, t, tp, tx } from "../i18n";
import { McpMigrationSection } from "./McpMigrationReport";


type Transport = "stdio" | "http";

const TRANSPORTS: { id: Transport; label: string }[] = [
  { id: "stdio", label: msg("Local process") },
  { id: "http", label: "HTTP" },
];

/** Lines in, list out — blank lines dropped. Used for args, filters and pairs. */
const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

function pairsToText(obj: Record<string, string> | undefined, sep: string): string {
  if (!obj) return "";
  return Object.entries(obj)
    .map(([k, v]) => `${k}${sep}${v}`)
    .join("\n");
}

function textToPairs(text: string, sep: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of lines(text)) {
    const at = line.indexOf(sep);
    if (at < 1) continue;
    out[line.slice(0, at).trim()] = line.slice(at + sep.length).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

type Exposure = ToolMark | "auto";

const EXPOSURES: { id: Exposure; label: string }[] = [
  { id: "auto", label: msg("Auto") },
  { id: "lazy", label: msg("Lazy") },
  { id: "direct", label: msg("Direct") },
];

/** What a chat that starts now does with a server's tools, in words: the mark, or what the threshold made of an auto server. */
function exposureText(state: McpServerState): string {
  if (state.by === "mark") return state.lazy ? t("lazy: found through tool_search") : t("direct: always in the model's list");
  if (state.by === "threshold") return t("auto, lazy now: the model's list is over the limits");
  if (state.by === "unknown") return t("auto, lazy until it has run once: its size is not known yet");
  if (state.by === "resources") return t("auto, lazy: it offers only resources, no tools");
  return t("auto, in the model's list: small enough to stay there");
}

/** What is remembered of a server's tools: how many and how much of the model's list they take. */
function toolsText(state: McpServerState): string {
  if (!state.tools) return t("never connected, so its tools are not known yet");
  if (state.tools.count === 0 && state.tools.resources) return t("no tools of its own, only resources");
  const known = tp(state.tools.count, "{n} tool, about {tokens} tokens", "{n} tools, about {tokens} tokens", { tokens: formatNumber(state.tools.tokens) });
  return state.tools.stale ? t("{tools} (as of before its entry was changed)", { tools: known }) : known;
}

/** MCP servers, as pi's own MCP support reads them: the file is pi's, and the panel edits it. */
export function McpPanel({ onError }: { onError: (e: string) => void }) {
  const [view, setView] = useState<McpConfigView | null>(null);
  /** What the portal says of each server beyond its file; nothing where it cannot say, and the page is as the file shows it. */
  const [states, setStates] = useState<Record<string, McpServerState>>({});
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ name: string | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);

  const load = async () => {
    try {
      const [next, status] = await Promise.all([api.mcp(), api.mcpStatus().then((r) => r.servers, () => ({}) as Record<string, McpServerState>)]);
      setView(next);
      setStates(status);
      setFailed(null);
    } catch (e) {
      // With nothing read yet, the page says so itself, with a way to try again; the banner is for a refresh.
      if (view) onError((e as Error).message);
      else setFailed((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  /** True when it went through. */
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    }
  };

  if (!view && failed) return <LoadFailed error={failed} onRetry={load} />;
  if (loading || !view) {
    return (
      <p className="flex items-center gap-2 text-sm text-fg-subtle">
        <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Reading configuration…")}
      </p>
    );
  }

  if (editing) {
    const existing = editing.name ? view.servers.find((s) => s.name === editing.name) : undefined;
    return (
      <ServerForm
        server={existing}
        state={existing ? states[existing.name] : undefined}
        taken={view.servers.filter((s) => s.name !== existing?.name).map((s) => s.name)}
        onBack={() => setEditing(null)}
        onSave={async (name, entry, settings) => {
          await api.saveMcpServer(name, entry, existing?.name, settings.approve);
          // What the portal keeps by the server's name follows a rename only by being said again under the new one.
          const moved = existing !== undefined && existing.name !== name;
          if (settings.exposure !== (states[existing?.name ?? ""]?.mark ?? "auto") || (moved && settings.exposure !== "auto")) await api.setMcpMark(name, settings.exposure);
          if (settings.approve.join("\n") !== (states[existing?.name ?? ""]?.approve ?? []).join("\n") || (moved && settings.approve.length)) await api.setMcpApprove(name, settings.approve);
          setEditing(null);
          await load();
        }}
        onError={onError}
      />
    );
  }

  return (
    <>
      {view.parseError && (
        <section role="alert" className="mb-6 rounded-xl border border-danger/30 bg-danger/10 p-3">
          <div className="flex items-start gap-2">
            <LuCircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <div className="min-w-0">
              <p className="text-sm text-danger">{t("This file does not parse")}</p>
              <p className="mt-1 font-mono text-xs text-fg-muted">{view.parseError}</p>
              <p className="mt-1 text-xs text-fg-faint">
                {t("Nothing is listed and nothing will be written until it is fixed — edit it below.")}
              </p>
            </div>
          </div>
        </section>
      )}

      <McpMigrationSection onImported={() => void load()} />

      <section className="mb-6 rounded-xl border border-line bg-raised/40 p-3">
        <div className="flex items-center gap-2">
          <LuFileJson className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
          <p className="text-xs text-fg-subtle">{t("Config file")}</p>
          <p className="ml-auto truncate pl-3 font-mono text-xs text-fg-muted">{view.path}</p>
        </div>
        <p className="mt-1.5 text-xs text-fg-faint">
          {t("Applies to every session in this portal. Open chats are loaded again to pick up a change.")}
        </p>
      </section>

      <section className="mb-6">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-sm font-medium text-fg">{t("Servers")}</h3>
          <span className="text-xs text-fg-faint">{view.servers.length}</span>
          <div className="ml-auto flex gap-2">
            <button className={btnCls} onClick={() => setImporting((v) => !v)}>
              <LuClipboardPaste className="h-4 w-4" /> {t("Paste JSON")}
            </button>
            <button className={primaryCls} onClick={() => setEditing({ name: null })}>
              <LuPlus className="h-4 w-4" /> {t("Add server")}
            </button>
          </div>
        </div>

        {importing && (
          <ImportBox
            onCancel={() => setImporting(false)}
            onDone={async () => {
              setImporting(false);
              await load();
            }}
            onError={onError}
          />
        )}

        {view.servers.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-fg-faint">
            {t("No servers yet. Most MCP projects publish a JSON snippet in their README — paste it straight in.")}
          </p>
        ) : (
          <ul className={gridCls}>
            {view.servers.map((s) => (
              <ServerRow
                key={s.name}
                server={s}
                state={states[s.name]}
                onOpen={() => setEditing({ name: s.name })}
                onToggle={() =>
                  act(() => {
                    // `disabled` is how the old adapter said it; pi's own key is `enabled`.
                    const { disabled: _old, enabled: _on, ...rest } = s.entry;
                    return api.saveMcpServer(s.name, s.disabled ? rest : { ...rest, enabled: false }, s.name);
                  })
                }
                onDelete={async () => {
                  // It holds the server's environment, headers and anything written by hand, and a tap beside the On box is easy to make.
                  if (!(await confirmDialog({ title: t("Remove {name}?", { name: s.name }), message: t("Its entry is deleted from the MCP file, with its environment, headers and anything added by hand. There is no undo."), confirmLabel: t("Remove"), danger: true, deletes: true }))) return;
                  await act(() => api.deleteMcpServer(s.name));
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6">
        <button
          className="flex w-full items-center gap-2 text-left text-sm text-fg-muted transition hover:text-fg"
          onClick={() => setRawOpen((v) => !v)}
        >
          <LuChevronRight
            className={`h-3.5 w-3.5 transition-transform ${rawOpen ? "rotate-90" : ""}`}
          />
          {t("Edit the file directly")}
        </button>
        {rawOpen && (
          <RawEditor initial={view.raw} onSaved={load} onError={onError} />
        )}
      </section>
    </>
  );
}

function ServerRow({
  server,
  state,
  onOpen,
  onToggle,
  onDelete,
}: {
  server: McpServerView;
  state?: McpServerState;
  onOpen: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const e = server.entry;
  const summary =
    server.transport === "stdio"
      ? [e.command, ...(e.args ?? [])].join(" ")
      : server.transport === "http"
        ? e.url
        : t("No transport configured");

  return (
    <li className="group flex items-center gap-3 rounded-xl border border-line bg-raised/40 px-3 py-2.5">
      {server.transport === "http" ? (
        <LuGlobe className="h-4 w-4 shrink-0 text-fg-faint" />
      ) : (
        <LuTerminal className="h-4 w-4 shrink-0 text-fg-faint" />
      )}
      <button className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <p className={`truncate text-sm ${server.disabled ? "text-fg-subtle" : "text-fg"}`}>
          {server.name}
          {server.disabled && <span className="ml-2 text-xs text-fg-faint">{t("disabled")}</span>}
        </p>
        <p className="truncate font-mono text-xs text-fg-faint">{summary}</p>
        {/* What pi would skip it for, and the values it would run as a command: both are said where the server is. */}
        {server.problem && <p className="truncate text-xs text-danger">{server.problem}</p>}
        {/* What a chat does with its tools, and what is known of them: the state the threshold left it in is said here, where the server is. */}
        {state && !server.disabled && (
          <p className="truncate text-xs text-fg-faint" title={`${exposureText(state)}. ${toolsText(state)}`}>
            {exposureText(state)} · {toolsText(state)}
            {state.approve.length > 0 && ` · ${t("asks first: {tools}", { tools: state.approve.join(", ") })}`}
          </p>
        )}
        {server.commands.length > 0 && (
          <p className="truncate text-xs text-warn">{t("Runs a command for {names}", { names: server.commands.join(", ") })}</p>
        )}
      </button>
      <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-fg-subtle">
        <input
          type="checkbox"
          className="accent-accent"
          checked={!server.disabled}
          onChange={onToggle}
        />
        {t("On")}
      </label>
      <button
        className="shrink-0 rounded-lg p-1.5 text-fg-faint opacity-0 transition hover:bg-danger/10 hover:text-danger focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        title={t("Remove")}
        aria-label={t("Remove {name}", { name: server.name })}
        onClick={onDelete}
      >
        <LuTrash2 className="h-4 w-4" />
      </button>
      <button className="shrink-0 text-fg-faint" onClick={onOpen} title={t("Edit")} aria-label={t("Edit {name}", { name: server.name })}>
        <LuChevronRight className="h-4 w-4" />
      </button>
    </li>
  );
}

function ImportBox({
  onCancel,
  onDone,
  onError,
}: {
  onCancel: () => void;
  onDone: () => void;
  onError: (e: string) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ added: string[]; skipped: { name: string; reason: string }[] } | null>(null);
  // The text is cleared once something was added; what stays after an import (every server skipped) is the person's to go on with.
  useUnsavedDraft(!busy && text.trim() !== "");

  return (
    <div className="mb-3 rounded-xl border border-line bg-raised/40 p-3">
      <p className="mb-2 text-xs text-fg-muted">
        {tx("Accepts a whole config, a bare {key} map, or a single server object.", { key: <span className="font-mono">mcpServers</span> })}
      </p>
      <textarea
        className={codeAreaCls}
        rows={7}
        spellCheck={false}
        aria-label={t("Server JSON")}
        placeholder={"{\n  \"mcpServers\": {\n    \"filesystem\": {\n      \"command\": \"npx\",\n      \"args\": [\"-y\", \"@modelcontextprotocol/server-filesystem\", \"/data\"]\n    }\n  }\n}"}
        value={text}
        onChange={(ev) => setText(ev.target.value)}
      />
      {result && (
        <div className="mt-2 text-xs">
          {result.added.length > 0 && (
            <p className="text-ok">{t("Added {names}", { names: result.added.join(", ") })}</p>
          )}
          {result.skipped.map((s) => (
            <p key={s.name} className="text-warn">
              {t("Skipped {name}: {reason}", { name: s.name, reason: s.reason })}
            </p>
          ))}
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <button
          className={primaryCls}
          disabled={busy || !text.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api.importMcp(text);
              setResult(r);
              if (r.added.length) {
                setText("");
                onDone();
              }
            } catch (e) {
              onError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <LuRefreshCw className="h-4 w-4 animate-spin" /> : <LuDownload className="h-4 w-4" />}
          {t("Import")}
        </button>
        <button className={btnCls} onClick={onCancel}>
          {t("Cancel")}
        </button>
      </div>
    </div>
  );
}

function ServerForm({
  server,
  state,
  taken,
  onBack,
  onSave,
  onError,
}: {
  server?: McpServerView;
  state?: McpServerState;
  /** The names of the other servers: a new or renamed one on any of them would replace it. */
  taken: string[];
  onBack: () => void;
  onSave: (name: string, entry: McpServerEntry, settings: { exposure: Exposure; approve: string[] }) => Promise<void>;
  onError: (e: string) => void;
}) {
  const e = server?.entry ?? {};
  const [name, setName] = useState(server?.name ?? "");
  const [transport, setTransport] = useState<Transport>(
    server && server.transport !== "unknown" ? server.transport : "stdio",
  );
  const [command, setCommand] = useState(e.command ?? "");
  const [args, setArgs] = useState((e.args ?? []).join("\n"));
  const [env, setEnv] = useState(pairsToText(e.env, "="));
  const [cwd, setCwd] = useState(e.cwd ?? "");
  const [url, setUrl] = useState(e.url ?? "");
  const [headers, setHeaders] = useState(pairsToText(e.headers, ": "));
  const [description, setDescription] = useState(e.description ?? "");
  const [timeout, setTimeoutSeconds] = useState(e.timeout === undefined ? "" : String(e.timeout));
  const [disabled, setDisabled] = useState(e.enabled === false || e.disabled === true);
  /** The portal's own mark on the server, which is not in the file, and the tools that ask first. */
  const [exposure, setExposure] = useState<Exposure>(state?.mark ?? "auto");
  const [approve, setApprove] = useState((state?.approve ?? []).join("\n"));
  const [saving, setSaving] = useState(false);
  const nameTaken = taken.includes(name.trim());
  // Whatever it was opened with is not a draft; the first look at the fields is what they are compared with.
  const fields = JSON.stringify([name, transport, command, args, env, cwd, url, headers, description, timeout, disabled, exposure, approve]);
  const opened = useRef(fields);
  useUnsavedDraft(!saving && fields !== opened.current);

  const submit = async () => {
    if (!name.trim()) return onError(t("Give the server a name"));
    if (nameTaken) return onError(t("A server called {name} already exists", { name: name.trim() }));
    // Start from the stored entry so fields this form does not show — oauth
    // blocks, how the tools are exposed, what is hidden — survive an edit here.
    const next: McpServerEntry = { ...e };
    // `type` too: it names the transport, which the fields below say again (a stdio server moved to an address is no longer `stdio`).
    for (const k of ["type", "command", "args", "env", "cwd", "url", "headers", "description", "timeout", "enabled", "disabled"]) {
      delete next[k];
    }

    if (transport === "stdio") {
      next.command = command.trim();
      if (lines(args).length) next.args = lines(args);
      const parsed = textToPairs(env, "=");
      if (parsed) next.env = parsed;
      if (cwd.trim()) next.cwd = cwd.trim();
    } else if (transport === "http") {
      next.url = url.trim();
      const parsed = textToPairs(headers, ":");
      if (parsed) next.headers = parsed;
    }

    if (description.trim()) next.description = description.trim();
    if (timeout.trim() && Number(timeout) > 0) next.timeout = Number(timeout);
    if (disabled) next.enabled = false;

    setSaving(true);
    try {
      await onSave(name.trim(), next, { exposure, approve: lines(approve) });
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        className="mb-4 flex items-center gap-1 text-sm text-fg-muted transition hover:text-fg"
        onClick={onBack}
      >
        <LuChevronLeft className="h-4 w-4" /> {t("Servers")}
      </button>

      <div className="space-y-4">
        <Field label={t("Name")} hint={nameTaken ? <span className="text-danger">{t("A server called {name} already exists", { name: name.trim() })}</span> : t("How its tools are prefixed, so keep it short")}>
          <input
            className={inputCls}
            aria-invalid={nameTaken || undefined}
            value={name}
            placeholder="filesystem"
            onChange={(ev) => setName(ev.target.value)}
          />
        </Field>

        <Field label={t("Transport")}>
          <Segments label={t("Transport")} size="md" className="flex gap-2" value={transport} options={TRANSPORTS} onChange={setTransport} />
        </Field>

        {transport === "stdio" && (
          <>
            <Field label={t("Command")}>
              <input
                className={inputCls}
                value={command}
                placeholder="npx"
                onChange={(ev) => setCommand(ev.target.value)}
              />
            </Field>
            <Field label={t("Arguments")} hint={t("One per line")}>
              <textarea
                className={codeAreaCls}
                rows={3}
                spellCheck={false}
                value={args}
                placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/data"}
                onChange={(ev) => setArgs(ev.target.value)}
              />
            </Field>
            <Field label={t("Environment")} hint={t("KEY=value per line; ${VAR} is expanded at launch")}>
              <textarea
                className={codeAreaCls}
                rows={2}
                spellCheck={false}
                value={env}
                placeholder="GITHUB_TOKEN=${GITHUB_TOKEN}"
                onChange={(ev) => setEnv(ev.target.value)}
              />
            </Field>
            <Field label={t("Working directory")} hint={t("Optional")}>
              <input className={inputCls} value={cwd} onChange={(ev) => setCwd(ev.target.value)} />
            </Field>
          </>
        )}

        {transport === "http" && (
          <>
            <Field label={t("URL")}>
              <input
                className={inputCls}
                value={url}
                placeholder="https://example.com/mcp"
                onChange={(ev) => setUrl(ev.target.value)}
              />
            </Field>
            <Field label={t("Headers")} hint={t("Name: value per line")}>
              <textarea
                className={codeAreaCls}
                rows={2}
                spellCheck={false}
                value={headers}
                onChange={(ev) => setHeaders(ev.target.value)}
              />
            </Field>
            <p className="text-xs text-fg-faint">
              {tx("A server that asks for a sign-in is signed in to with {command} in a terminal; a token goes in a header, as {example}.", { command: <span className="font-mono">{"pi mcp login <name>"}</span>, example: <span className="font-mono">{"Authorization: Bearer ${TOKEN}"}</span> })}
            </p>
          </>
        )}

        <Field label={t("Description")} hint={t("Optional: what the server offers, in a sentence")}>
          <input className={inputCls} value={description} onChange={(ev) => setDescription(ev.target.value)} />
        </Field>
        <Field label={t("Request timeout")} hint={t("Seconds; empty is pi's default")}>
          <input className={inputCls} value={timeout} inputMode="numeric" onChange={(ev) => setTimeoutSeconds(ev.target.value)} />
        </Field>

        <Field
          label={t("Tools in the model's list")}
          hint={t("Auto: the threshold decides, by how long the list is (Settings → Tools). Lazy: the model finds and calls the tools through tool_search, and the server starts when one is first used. Direct: the tools are always in the list, and the server starts with the chat.")}
        >
          <Segments label={t("Tools in the model's list")} size="md" className="flex gap-2" value={exposure} options={EXPOSURES} onChange={setExposure} />
          {state && (
            <p className="mt-1.5 text-xs text-fg-faint">
              {t("Now: {state}. {tools}.", { state: exposureText(state), tools: toolsText(state) })}
              {typeof e.exposure === "string" && " " + t("The file says exposure {value}, which is what pi's command line reads.", { value: e.exposure })}
              {e.toolExposure && typeof e.toolExposure === "object" && " " + t("It also sets {n} tools by name in the file; edit the file directly to change those.", { n: Object.keys(e.toolExposure).length })}
            </p>
          )}
        </Field>
        <Field
          label={t("Ask before these tools")}
          hint={t("One pattern per line, of the server's own tool names, * for any characters: delete_* asks before every tool that starts with delete_. You are asked in the chat before the call runs; where nobody can be asked (a routine, a heartbeat), it is refused.")}
        >
          <textarea className={codeAreaCls} rows={2} spellCheck={false} aria-label={t("Ask before these tools")} value={approve} placeholder="delete_*" onChange={(ev) => setApprove(ev.target.value)} />
        </Field>

        <div className="space-y-2 rounded-xl border border-line bg-raised/40 p-3">
          <Toggle
            checked={disabled}
            onChange={setDisabled}
            label={t("Disabled")}
            hint={t("Kept here but never connected")}
          />
        </div>

        <div className="flex gap-2 pt-1">
          <button className={primaryCls} disabled={saving} onClick={submit}>
            {saving && <LuRefreshCw className="h-4 w-4 animate-spin" />}
            {t("Save")}
          </button>
          <button className={btnCls} onClick={onBack}>
            {t("Cancel")}
          </button>
        </div>
      </div>
    </>
  );
}

function RawEditor({
  initial,
  onSaved,
  onError,
}: {
  initial: string;
  onSaved: () => Promise<void>;
  onError: (e: string) => void;
}) {
  const seeded = (file: string) => file || '{\n  "mcpServers": {}\n}\n';
  const [text, setText] = useState(seeded(initial));
  /** What `text` started from: it is changed once it is not that. */
  const [from, setFrom] = useState(seeded(initial));
  const [saving, setSaving] = useState(false);
  useUnsavedDraft(!saving && text !== from);

  // The file as it is now, unless the text has been typed in: a toggle in the list
  // above rewrites the file, and saving the old text would undo it.
  useEffect(() => {
    if (text === from) setText(seeded(initial));
    setFrom(seeded(initial));
  }, [initial]);

  return (
    <div className="mt-2">
      <textarea
        className={codeAreaCls}
        rows={14}
        spellCheck={false}
        aria-label="mcp.json"
        value={text}
        onChange={(ev) => setText(ev.target.value)}
      />
      <button
        className={`${primaryCls} mt-2`}
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          try {
            await api.saveMcpRaw(text);
            setFrom(text);
            await onSaved();
          } catch (e) {
            onError((e as Error).message);
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving && <LuRefreshCw className="h-4 w-4 animate-spin" />}
        {t("Save file")}
      </button>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        className="mt-0.5 accent-accent"
        checked={checked}
        onChange={(ev) => onChange(ev.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-sm text-fg">{label}</span>
        {hint && <span className="block text-xs text-fg-faint">{hint}</span>}
      </span>
    </label>
  );
}
