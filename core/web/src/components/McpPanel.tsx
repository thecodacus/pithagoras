import { useEffect, useRef, useState } from "react";
import { Select } from "./Select";
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
  LuPlug,
  LuPlus,
  LuRefreshCw,
  LuTerminal,
  LuTrash2,
  LuTriangleAlert,
} from "react-icons/lu";
import { api, type McpConfigView, type McpServerEntry, type McpServerView } from "../api";
import { Field, LoadFailed, Segments, btnCls, codeAreaCls, gridCls, inputCls, primaryCls, primarySmCls } from "./SettingsUi";
import { msg, t, tx } from "../i18n";


type Transport = "stdio" | "http" | "socket";

const TRANSPORTS: { id: Transport; label: string }[] = [
  { id: "stdio", label: msg("Local process") },
  { id: "http", label: "HTTP" },
  { id: "socket", label: msg("Unix socket") },
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

/**
 * MCP servers for `pi-mcp-adapter`.
 *
 * The adapter is what turns this file into tools; the portal only owns the
 * configuration. So the panel says plainly when the adapter is missing rather
 * than letting someone configure servers that nothing will ever read.
 */
export function McpPanel({ onError }: { onError: (e: string) => void }) {
  const [view, setView] = useState<McpConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ name: string | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);

  const load = async () => {
    try {
      setView(await api.mcp());
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
        taken={view.servers.filter((s) => s.name !== existing?.name).map((s) => s.name)}
        onBack={() => setEditing(null)}
        onSave={async (name, entry) => {
          await api.saveMcpServer(name, entry, existing?.name);
          setEditing(null);
          await load();
        }}
        onError={onError}
      />
    );
  }

  return (
    <>
      {!view.adapterInstalled && (
        <section className="mb-6 rounded-xl border border-warn/30 bg-warn/10 p-3">
          <div className="flex items-start gap-2">
            <LuTriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-fg">{t("The MCP adapter is not installed")}</p>
              <p className="mt-1 text-xs text-fg-muted">
                {tx("MCP support comes from the {name} extension. Until it is installed, servers configured here are read by nothing.", { name: <span className="font-mono">pi-mcp-adapter</span> })}
              </p>
              <button
                className={`${primaryCls} mt-3`}
                disabled={installing}
                onClick={async () => {
                  setInstalling(true);
                  try {
                    await api.installPackage(view.adapterSpec);
                    await load();
                  } catch (e) {
                    onError((e as Error).message);
                  } finally {
                    setInstalling(false);
                  }
                }}
              >
                {installing ? (
                  <LuRefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <LuDownload className="h-4 w-4" />
                )}
                {t("Install it")}
              </button>
            </div>
          </div>
        </section>
      )}

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

      <section className="mb-6 rounded-xl border border-line bg-raised/40 p-3">
        <div className="flex items-center gap-2">
          <LuFileJson className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
          <p className="text-xs text-fg-subtle">{t("Config file")}</p>
          <p className="ml-auto truncate pl-3 font-mono text-xs text-fg-muted">{view.path}</p>
        </div>
        <p className="mt-1.5 text-xs text-fg-faint">
          {t("Applies to every session in this portal. Changes are picked up by sessions started afterwards, so restart a running one to pull in a new server.")}
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
                onOpen={() => setEditing({ name: s.name })}
                onToggle={() =>
                  act(() =>
                    api.saveMcpServer(s.name, { ...s.entry, disabled: !s.disabled }, s.name),
                  )
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

      <GlobalSettings
        settings={view.settings}
        onSave={(next) => act(() => api.saveMcpSettings(next))}
      />

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
  onOpen,
  onToggle,
  onDelete,
}: {
  server: McpServerView;
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
        : server.transport === "socket"
          ? e.socket
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
  taken,
  onBack,
  onSave,
  onError,
}: {
  server?: McpServerView;
  /** The names of the other servers: a new or renamed one on any of them would replace it. */
  taken: string[];
  onBack: () => void;
  onSave: (name: string, entry: McpServerEntry) => Promise<void>;
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
  const [auth, setAuth] = useState<string>(e.auth === false ? "none" : (e.auth ?? "auto"));
  const [tokenEnv, setTokenEnv] = useState(e.bearerTokenEnv ?? "");
  const [socket, setSocket] = useState(e.socket ?? "");
  const [lifecycle, setLifecycle] = useState(e.lifecycle ?? "lazy");
  const [includeTools, setIncludeTools] = useState((e.includeTools ?? []).join("\n"));
  const [excludeTools, setExcludeTools] = useState((e.excludeTools ?? []).join("\n"));
  const [directTools, setDirectTools] = useState(e.directTools === true);
  const [debug, setDebug] = useState(e.debug === true);
  const [disabled, setDisabled] = useState(e.disabled === true);
  const [saving, setSaving] = useState(false);
  const nameTaken = taken.includes(name.trim());
  // Whatever it was opened with is not a draft; the first look at the fields is what they are compared with.
  const fields = JSON.stringify([name, transport, command, args, env, cwd, url, headers, auth, tokenEnv, socket, lifecycle, includeTools, excludeTools, directTools, debug, disabled]);
  const opened = useRef(fields);
  useUnsavedDraft(!saving && fields !== opened.current);

  const submit = async () => {
    if (!name.trim()) return onError(t("Give the server a name"));
    if (nameTaken) return onError(t("A server called {name} already exists", { name: name.trim() }));
    // Start from the stored entry so fields this form does not show — oauth
    // blocks, tracing, timeouts set by hand — survive an edit here.
    const next: McpServerEntry = { ...e };
    for (const k of [
      "command", "args", "env", "cwd", "url", "headers", "socket",
      "auth", "bearerTokenEnv", "lifecycle", "includeTools", "excludeTools",
      "directTools", "debug", "disabled",
    ]) {
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
      if (auth === "none") next.auth = false;
      else if (auth !== "auto") next.auth = auth as "oauth" | "bearer";
      if (auth === "bearer" && tokenEnv.trim()) next.bearerTokenEnv = tokenEnv.trim();
    } else {
      next.socket = socket.trim();
    }

    if (lifecycle !== "lazy") next.lifecycle = lifecycle as McpServerEntry["lifecycle"];
    if (lines(includeTools).length) next.includeTools = lines(includeTools);
    if (lines(excludeTools).length) next.excludeTools = lines(excludeTools);
    if (directTools) next.directTools = true;
    if (debug) next.debug = true;
    if (disabled) next.disabled = true;

    setSaving(true);
    try {
      await onSave(name.trim(), next);
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
            <Field label={t("Authentication")}>
              <Select
                className="w-full"
                value={auth}
                onChange={setAuth}
                options={[
                  { value: "auto", label: t("Detect"), hint: t("OAuth if the server offers it") },
                  { value: "oauth", label: "OAuth" },
                  { value: "bearer", label: t("Bearer token") },
                  { value: "none", label: t("None") },
                ]}
              />
            </Field>
            {auth === "bearer" && (
              <Field
                label={t("Token environment variable")}
                hint={t("The variable name, not the token — secrets do not belong in this file")}
              >
                <input
                  className={inputCls}
                  value={tokenEnv}
                  placeholder="MY_SERVICE_TOKEN"
                  onChange={(ev) => setTokenEnv(ev.target.value)}
                />
              </Field>
            )}
          </>
        )}

        {transport === "socket" && (
          <Field label={t("Socket path")}>
            <input
              className={inputCls}
              value={socket}
              placeholder="~/.rmcp/mux.sock"
              onChange={(ev) => setSocket(ev.target.value)}
            />
          </Field>
        )}

        <Field label={t("Lifecycle")} hint={t("Lazy connects on first use, which is usually what you want")}>
          <Select
            className="w-full"
            value={lifecycle}
            onChange={(v) => setLifecycle(v as McpServerEntry["lifecycle"] & string)}
            options={[
              { value: "lazy", label: t("Lazy") },
              { value: "lazy-keep-alive", label: t("Lazy, then keep alive") },
              { value: "eager", label: t("Eager") },
              { value: "keep-alive", label: t("Keep alive") },
            ]}
          />
        </Field>

        <Field label={t("Only these tools")} hint={t("One name or glob per line; leave empty for all")}>
          <textarea
            className={codeAreaCls}
            rows={2}
            spellCheck={false}
            value={includeTools}
            onChange={(ev) => setIncludeTools(ev.target.value)}
          />
        </Field>
        <Field label={t("Except these tools")} hint={t("One name or glob per line")}>
          <textarea
            className={codeAreaCls}
            rows={2}
            spellCheck={false}
            value={excludeTools}
            onChange={(ev) => setExcludeTools(ev.target.value)}
          />
        </Field>

        <div className="space-y-2 rounded-xl border border-line bg-raised/40 p-3">
          <Toggle
            checked={directTools}
            onChange={setDirectTools}
            label={t("Register tools directly")}
            hint={t("Puts every tool in the system prompt instead of behind the proxy — 150–300 tokens each, so keep it to small servers. Off, the tools are lazy, as the lazy button of the server in Settings → Tools says.")}
          />
          <Toggle checked={debug} onChange={setDebug} label={t("Show server stderr")} />
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

function GlobalSettings({
  settings,
  onSave,
}: {
  settings: Record<string, unknown>;
  /** True when it was saved: what is not stays to be saved again. */
  onSave: (next: Record<string, unknown>) => Promise<boolean>;
}) {
  const shown = (v: unknown) => (v === undefined ? "" : String(v));
  const [prefix, setPrefix] = useState(String(settings.toolPrefix ?? "server"));
  const [idle, setIdle] = useState(shown(settings.idleTimeout));
  const [request, setRequest] = useState(shown(settings.requestTimeoutMs));
  const [dirty, setDirty] = useState(false);
  useUnsavedDraft(dirty);

  // The fields follow the file when it changes elsewhere (the raw editor, another
  // window), unless something is typed in them: that is saved, or not, as it is.
  const loaded = JSON.stringify(settings);
  useEffect(() => {
    if (dirty) return;
    setPrefix(String(settings.toolPrefix ?? "server"));
    setIdle(shown(settings.idleTimeout));
    setRequest(shown(settings.requestTimeoutMs));
  }, [loaded]);

  const save = async () => {
    const next: Record<string, unknown> = { ...settings };
    if (prefix === "server") delete next.toolPrefix;
    else next.toolPrefix = prefix;
    if (idle.trim() === "") delete next.idleTimeout;
    else next.idleTimeout = Number(idle);
    if (request.trim() === "") delete next.requestTimeoutMs;
    else next.requestTimeoutMs = Number(request);
    if (await onSave(next)) setDirty(false);
  };

  const track = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDirty(true);
  };

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <LuPlug className="h-3.5 w-3.5 text-fg-faint" />
        <h3 className="text-sm font-medium text-fg">{t("Adapter settings")}</h3>
        {dirty && (
          <button className={`${primarySmCls} ml-auto`} onClick={save}>
            {t("Save")}
          </button>
        )}
      </div>
      <div className="grid gap-3 rounded-xl border border-line bg-raised/40 p-3 sm:grid-cols-3">
        <Field label={t("Tool naming")}>
          <Select
            className="w-full"
            value={prefix}
            onChange={(v) => track(setPrefix)(v)}
            options={[
              { value: "server", label: "server_tool" },
              { value: "short", label: "short" },
              { value: "mcp", label: "mcp_tool" },
              { value: "none", label: "tool" },
            ]}
          />
        </Field>
        <Field label={t("Idle timeout")} hint={t("Minutes; 0 never disconnects")}>
          <input
            className={inputCls}
            value={idle}
            placeholder="10"
            inputMode="numeric"
            onChange={(ev) => track(setIdle)(ev.target.value)}
          />
        </Field>
        <Field label={t("Request timeout")} hint={t("Milliseconds")}>
          <input
            className={inputCls}
            value={request}
            placeholder={t("default")}
            inputMode="numeric"
            onChange={(ev) => track(setRequest)(ev.target.value)}
          />
        </Field>
      </div>
    </section>
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
