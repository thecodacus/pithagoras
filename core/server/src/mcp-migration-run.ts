import type Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { mcpConfigPath, readMcpFile } from "./api/mcp.js";
import { DATA_DIR } from "./data-dir.js";
import { sourceOf } from "./extension-switch.js";
import { McpMigration, parseAdapterCache, type AdapterState, type Report } from "./mcp-migration.js";
import { configHash, declarationTokens, rememberServerTools, type CachedTool } from "./mcp-tools.js";
import { piAgentDir, readPiSettings, readProjectPiSettings, updatePiSettingsNow } from "./pi-settings.js";
import { PI_BUILT_IN_TOOLS } from "./tool-policy.js";

/**
 * The upgrade from `pi-mcp-adapter` to pi's own MCP support, run once as the database is brought to schema 17 (the
 * database was backed up before: db-upgrade.ts), and again at each start while the file it converts cannot be read.
 *
 * Taking the adapter out of pi's package settings is what lets pi's own MCP support start, and every server of the file
 * would then connect for the first time. So what meant "off" or "not reachable" is carried over as off first: a server of
 * an adapter that was switched off or not installed is written `enabled: false`; the switches stored by the adapter's tool
 * names (`<server>_<tool>`) are written again by pi's (`mcp__<server>__<tool>`) in every place that holds them; and where a
 * conversion is not certain, the server is switched off and named in the report. docs/guide/upgrading.md says what a person
 * does with the report, and how to go back.
 *
 * What it keeps: `mcp.json.adapter` beside the converted `mcp.json` (the file as it was), the adapter's own files and its
 * package on disk (only its entry in pi's settings goes), and the report, in the database and as `mcp-migration.json` in the
 * data folder, which survives going back to the database from before.
 */

export const MCP_MIGRATION = "mcp_migration";
export const MCP_MIGRATION_NOTICE = "mcp_migration_notice";

const ADAPTER = /(^|[:/])pi-mcp-adapter(@[^/]*)?$/;
const ADAPTER_TOOL = /pi-mcp-adapter/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const settingIn = (d: Database.Database, key: string): string | undefined => (d.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
const putIn = (d: Database.Database, key: string, value: string): void => void d.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
const lines = (raw: string | null | undefined): string[] => (raw ?? "").split("\n").map((name) => name.trim()).filter(Boolean);
const tidy = (names: readonly string[]): string[] => [...new Set(names.map((name) => name.trim()).filter(Boolean))].sort();

function jsonIn(d: Database.Database, key: string): unknown {
  const raw = settingIn(d, key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The report of an earlier run, where there is one. */
export function migrationReport(d: Database.Database): Report | undefined {
  const raw = jsonIn(d, MCP_MIGRATION);
  return isRecord(raw) && raw.v === 1 ? (raw as unknown as Report) : undefined;
}

/** Whether the last run could not read the file it converts and waits for the next start. */
export const migrationPending = (d: Database.Database): boolean => migrationReport(d)?.status === "pending";

/** The adapter in pi's package list: its entry, and whether it is on. */
function adapterIn(packages: unknown): { entry: unknown; source: string; on: boolean } | undefined {
  for (const entry of Array.isArray(packages) ? packages : []) {
    const source = sourceOf(entry);
    if (source && ADAPTER.test(source)) {
      // Switched off as `pi config` writes it: every kind of resource emptied (extension-switch.ts isSwitchedOff, written out here).
      const off = isRecord(entry) && entry.autoload !== false && ["extensions", "skills", "prompts", "themes"].every((kind) => Array.isArray(entry[kind]) && (entry[kind] as unknown[]).length === 0);
      return { entry, source, on: !off };
    }
  }
  return undefined;
}

/** The adapter's cache of what each server offered: `mcp-cache.json` in pi's agent folder. */
function readAdapterCache(): ReturnType<typeof parseAdapterCache> {
  try {
    return parseAdapterCache(JSON.parse(readFileSync(path.join(piAgentDir(), "mcp-cache.json"), "utf8")));
  } catch {
    return {};
  }
}

interface SeenTool {
  name?: unknown;
  source?: unknown;
  package?: unknown;
  server?: unknown;
  [key: string]: unknown;
}

/** An entry of the tools the portal has seen that the adapter brought: it was filed under the adapter, by its package or by what pi called its source. */
const fromAdapter = (tool: SeenTool): boolean => ADAPTER_TOOL.test(String(tool.package ?? "")) || ADAPTER_TOOL.test(String(tool.source ?? ""));

/** The tools whose names mean what they say whatever the servers' prefixes look like: pi's own, and the ones the portal and its extensions bring. */
const OWN_TOOLS = ["codemode", "tool_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
/** The browser's tools, which an extension brings; written out here, as an upgrade step does not change with the code after it. */
const BROWSER_TOOLS = ["browser_back", "browser_click", "browser_find", "browser_get_text", "browser_key", "browser_navigate", "browser_screenshot", "browser_scroll", "browser_select", "browser_snapshot", "browser_type"];

/** The settings that hold marks, in the shape `tool_marks` has: entries (sets, or `<tool>name`) by mark. */
function marksIn(d: Database.Database): Record<string, string> {
  const raw = jsonIn(d, "tool_marks");
  return isRecord(raw) ? Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
}

/** Where a folder brings its own MCP configuration, or the adapter itself. */
function projectsOf(d: Database.Database): Report["projects"] {
  const folders = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && path.isAbsolute(value)) folders.add(value);
  };
  for (const row of d.prepare("SELECT DISTINCT workspace FROM sessions").all() as { workspace: string }[]) add(row.workspace);
  for (const row of d.prepare("SELECT project FROM project_tools").all() as { project: string }[]) add(row.project);
  for (const row of d.prepare("SELECT home FROM agents").all() as { home: string }[]) add(row.home);
  const out: Report["projects"] = [];
  for (const folder of [...folders].sort().slice(0, 1000)) {
    try {
      if (!statSync(folder).isDirectory()) continue;
    } catch {
      continue;
    }
    const adapterSettings = adapterIn(readProjectPiSettings(folder).packages) !== undefined;
    const mcpJson = existsSync(path.join(folder, ".pi", "mcp.json"));
    const foreign = [".mcp.json", path.join(".vscode", "mcp.json"), "opencode.json"].filter((file) => existsSync(path.join(folder, file)));
    if (adapterSettings || mcpJson || foreign.length) out.push({ folder, adapterSettings, mcpJson, foreign });
  }
  return out;
}

/** Stored texts that still name the old tools, by where they are: scanned, not changed. */
function textsNaming(d: Database.Database, names: readonly string[]): Report["texts"] {
  const words = [...new Set([...names, "mcp_script", "mcpScript"])];
  if (!words.length) return [];
  const escaped = words.sort((a, b) => b.length - a.length).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const find = new RegExp(`(?<![A-Za-z0-9_])(${escaped.join("|")})(?![A-Za-z0-9_])|\\bmcp\\(\\s*\\{`, "g");
  const found: Report["texts"] = [];
  const scan = (where: string, text: unknown) => {
    if (typeof text !== "string" || !text || text.length > 400_000) return;
    const hits = [...new Set([...text.matchAll(find)].map((one) => (one[1] ? one[1] : "mcp({…})")))];
    if (hits.length) found.push({ where, names: hits.slice(0, 8) });
  };
  for (const row of d.prepare("SELECT slug, instructions FROM routines").all() as { slug: string; instructions: string }[]) scan(`routine ${row.slug}`, row.instructions);
  for (const row of d.prepare("SELECT id, instructions FROM chat_modes").all() as { id: string; instructions: string }[]) scan(`mode ${row.id}`, row.instructions);
  for (const row of d.prepare("SELECT key, value FROM settings WHERE key LIKE '%prompt%' OR key LIKE '%instruction%' OR key LIKE '%rule%' OR key LIKE '%soul%'").all() as { key: string; value: string }[]) scan(`setting ${row.key}`, row.value);
  for (const row of d.prepare("SELECT id, home FROM agents").all() as { id: string; home: string }[]) {
    for (const file of ["SOUL.md", "PrimaryUser.md", "MEMORY.md", "AGENTS.md"]) {
      try {
        scan(`agent ${row.id}: ${file}`, readFileSync(path.join(row.home, file), "utf8"));
      } catch {
        // Not there.
      }
    }
  }
  return found.slice(0, 200);
}

/** What the guard matches a rule against for a tool other than bash: the path, or the arguments as JSON (the guard's own subjectOf, written out). */
const subjectOfArgs = (tool: string, args: Record<string, unknown>): string =>
  tool === "bash" ? (typeof args.command === "string" ? args.command : "") : typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : JSON.stringify(args);

/** A rule's pattern as the text it matches, where it matches only that (the guard's `literalPattern` undone), or undefined where it has a wildcard. */
function literalOf(pattern: string): string | undefined {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && (pattern[i + 1] === "*" || pattern[i + 1] === "\\")) out += pattern[++i];
    else if (c === "*") return undefined;
    else out += c;
  }
  return out;
}

const literalPattern = (text: string): string => text.replace(/[\\*]/g, "\\$&");

/** Run the migration on the open database: the work of getDb()'s transaction, the files it touches, and the report. */
export function migrateMcp(d: Database.Database): void {
  const now = new Date().toISOString();
  const read = readMcpFile();
  const { config, raw } = read;
  // An empty file is not a broken one: pi reads it as no servers, as the adapter did.
  const error = raw.trim() === "" ? undefined : read.error;
  const settings = readPiSettings();
  const adapter = adapterIn(settings.packages);
  const cache = readAdapterCache();
  const had = !error && Object.keys(config.mcpServers).length > 0;
  // A portal that never had the adapter or a server: nothing to carry over, and nothing to say.
  if (!error && !adapter && !had && !Object.keys(cache).length) return;

  const base = { v: 1 as const, at: now };
  if (error) {
    // The adapter could not read it either, so no server of it was reachable; nothing is changed until it is fixed, and the next start tries again.
    const report: Report = {
      ...base,
      status: "pending",
      adapter: { was: adapter ? (adapter.on ? "on" : "off") : "absent", removed: false },
      file: { state: "unreadable", note: error },
      servers: [], names: { converted: 0 }, expanded: [], unconverted: [], untrusted: [], texts: [], projects: [], gone: [], notes: [],
    };
    putIn(d, MCP_MIGRATION, JSON.stringify(report));
    putIn(d, MCP_MIGRATION_NOTICE, "1");
    console.warn(`[portal] mcp.json cannot be read (${error}); the MCP servers are not carried over to pi's own MCP support until it is fixed, and the next start tries again`);
    return;
  }

  const { mcpServers: servers, settings: adapterSettings, imports, ...extra } = config as Record<string, unknown> & { mcpServers: Record<string, unknown> };
  const state: AdapterState = {
    servers,
    settings: isRecord(adapterSettings) ? adapterSettings : {},
    extra,
    imports,
    cache,
    adapter: adapter ? (adapter.on ? "on" : "off") : "absent",
  };

  // What the portal has seen of tools, to tell the adapter's from the rest.
  const seenRaw = jsonIn(d, "tools_seen");
  const seen: SeenTool[] = Array.isArray(seenRaw) ? seenRaw.filter((tool): tool is SeenTool => isRecord(tool) && typeof tool.name === "string") : [];
  const normal = new Set<string>([...PI_BUILT_IN_TOOLS, ...OWN_TOOLS, ...BROWSER_TOOLS, ...seen.filter((tool) => !fromAdapter(tool)).map((tool) => String(tool.name))]);
  const marks = marksIn(d);
  const lazyOf = (tool: SeenTool): boolean => {
    const name = String(tool.name);
    if (marks[`<tool>${name}`] === "direct") return false;
    if (marks[`<tool>${name}`] === "lazy") return true;
    return marks[String(tool.server ?? tool.source ?? "")] === "lazy";
  };
  // What the gateway `tools` reached: the tools of lazy sets that are not the adapter's.
  const lazyOnly = tidy(seen.filter((tool) => !fromAdapter(tool) && lazyOf(tool)).map((tool) => String(tool.name)));

  const migration = new McpMigration({ state, known: { normal }, lazyOnly });

  // --- every place that holds tool names ---
  const changed = (a: readonly string[], b: readonly string[]) => a.length !== b.length || a.some((name, i) => name !== b[i]);

  const defaults = lines(settingIn(d, "tools_off_default"));
  const defaultsNow = tidy(migration.list("the default for every chat", "off", defaults));
  if (changed(tidy(defaults), defaultsNow)) putIn(d, "tools_off_default", defaultsNow.join("\n"));

  const layer = (table: string, key: string, rows: { id: string; label: string; off: string; on: string; keep?: string }[], keepColumn: boolean) => {
    const update = d.prepare(`UPDATE ${table} SET tools_off = ?, tools_on = ?${keepColumn ? ", keep_direct = ?" : ""} WHERE ${key} = ?`);
    for (const row of rows) {
      const off = tidy(migration.list(row.label, "off", lines(row.off)));
      const on = tidy(migration.list(row.label, "on", lines(row.on)));
      const keep = keepColumn ? tidy(migration.entries(row.label, lines(row.keep))) : [];
      if (changed(tidy(lines(row.off)), off) || changed(tidy(lines(row.on)), on) || (keepColumn && changed(tidy(lines(row.keep)), keep))) {
        if (keepColumn) update.run(off.join("\n"), on.join("\n"), keep.join("\n"), row.id);
        else update.run(off.join("\n"), on.join("\n"), row.id);
      }
    }
  };
  const has = (table: string, column: string) => (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((one) => one.name === column);
  const rowsOf = (table: string, key: string, label: (id: string) => string, keep: boolean) => {
    const kept = keep && has(table, "keep_direct");
    const rows = d.prepare(`SELECT ${key} AS id, tools_off AS off_, tools_on AS on_${kept ? ", keep_direct AS keep_" : ""} FROM ${table} WHERE tools_off != '' OR tools_on != ''${kept ? " OR keep_direct != ''" : ""}`).all() as { id: string; off_: string; on_: string; keep_?: string }[];
    return rows.map((row) => ({ id: row.id, label: label(row.id), off: row.off_, on: row.on_, keep: row.keep_ }));
  };
  layer("sessions", "id", rowsOf("sessions", "id", (id) => `chat ${id}`, false), false);
  layer("project_tools", "project", rowsOf("project_tools", "project", (id) => `project ${id}`, false), false);
  layer("agent_tools", "agent", rowsOf("agent_tools", "agent", (id) => `agent ${id}`, true), has("agent_tools", "keep_direct"));
  if (has("routines", "tools_off")) layer("routines", "slug", rowsOf("routines", "slug", (id) => `routine ${id}`, false), false);
  layer("chat_modes", "id", rowsOf("chat_modes", "id", (id) => `mode ${id}`, true), has("chat_modes", "keep_direct"));

  // What a chat froze about its lazy sets names them by the server's name.
  if (has("sessions", "lazy_head")) {
    const update = d.prepare("UPDATE sessions SET lazy_head = ? WHERE id = ?");
    for (const row of d.prepare("SELECT id, lazy_head FROM sessions WHERE lazy_head IS NOT NULL AND lazy_head != ''").all() as { id: string; lazy_head: string }[]) {
      try {
        const head = JSON.parse(row.lazy_head);
        if (!isRecord(head)) continue;
        const next = { ...head } as Record<string, unknown>;
        for (const key of ["lazy", "direct"]) if (Array.isArray(head[key])) next[key] = migration.entries(`chat ${row.id}`, (head[key] as unknown[]).filter((one): one is string => typeof one === "string"));
        const text = JSON.stringify(next);
        if (text !== JSON.stringify(head)) update.run(text, row.id);
      } catch {
        // Not a head this version wrote: it is read as none and made again.
      }
    }
  }

  // The marks: a server's follows its rename, a mark on one of its tools follows the tool's name; the adapter's default (lazy) is said explicitly.
  const nextMarks: Record<string, string> = {};
  for (const [key, mark] of Object.entries(marks)) {
    const [mapped] = migration.entries("the marks", [key]);
    if (mapped !== undefined) nextMarks[mapped] = mark;
  }
  for (const plan of migration.servers) if (plan.mark && !(plan.newName in nextMarks)) nextMarks[plan.newName] = plan.mark;
  if (JSON.stringify(nextMarks) !== JSON.stringify(marks)) putIn(d, "tool_marks", Object.keys(nextMarks).length ? JSON.stringify(nextMarks) : "");

  // Sets that carry a name given by the person, and what the threshold took out of the list.
  const groupNames = jsonIn(d, "tool_group_names");
  if (isRecord(groupNames)) {
    const renamed = Object.fromEntries(Object.entries(groupNames).map(([set, label]) => [migration.setName(set), label]));
    if (JSON.stringify(renamed) !== JSON.stringify(groupNames)) putIn(d, "tool_group_names", JSON.stringify(renamed));
  }
  for (const key of ["lazy_notice"]) {
    const list = jsonIn(d, key);
    if (Array.isArray(list)) {
      const next = tidy(migration.entries(key, list.filter((one): one is string => typeof one === "string")));
      if (JSON.stringify(next) !== JSON.stringify(list)) putIn(d, key, JSON.stringify(next));
    }
  }
  const resolved = jsonIn(d, "lazy_resolved");
  if (isRecord(resolved) && Array.isArray(resolved.lazy)) {
    const next = { ...resolved, lazy: migration.entries("lazy_resolved", resolved.lazy.filter((one): one is string => typeof one === "string")) };
    if (JSON.stringify(next) !== JSON.stringify(resolved)) putIn(d, "lazy_resolved", JSON.stringify(next));
  }

  // The servers whose output the person counts as their own: a rename that was not certain is not trusted.
  const trustedNow = jsonIn(d, "guard_trusted_mcp_servers");
  let untrusted: string[] = [];
  if (Array.isArray(trustedNow)) {
    const trusted = migration.trusted(trustedNow.filter((one): one is string => typeof one === "string"));
    untrusted = trusted.untrusted;
    if (JSON.stringify(trusted.names) !== JSON.stringify(trustedNow)) putIn(d, "guard_trusted_mcp_servers", JSON.stringify([...new Set(trusted.names)]));
  }
  for (const key of ["mcp_configured", "mcp_removed"]) {
    const list = jsonIn(d, key);
    if (Array.isArray(list)) {
      const next = [...new Set(list.filter((one): one is string => typeof one === "string").map((name) => migration.setName(name)))].sort();
      if (JSON.stringify(next) !== JSON.stringify(list)) putIn(d, key, JSON.stringify(next));
    }
  }
  // Which tools ask for a confirmation: the adapter's `approveTools`, by the server's new name.
  const approveNow = jsonIn(d, "mcp_approve");
  const approve: Record<string, string[]> = isRecord(approveNow) ? Object.fromEntries(Object.entries(approveNow).map(([server, globs]) => [migration.setName(server), Array.isArray(globs) ? globs.filter((one): one is string => typeof one === "string") : []])) : {};
  for (const plan of migration.servers) if (plan.approve.length) approve[plan.newName] = tidy([...(approve[plan.newName] ?? []), ...plan.approve]);
  if (JSON.stringify(approve) !== JSON.stringify(approveNow ?? {})) putIn(d, "mcp_approve", Object.keys(approve).length ? JSON.stringify(approve) : "");

  // The tools the portal has seen: the adapter's own wrapper tools go, its servers' tools are the servers' by pi's names, and a tool that cannot be told is no longer listed.
  if (Array.isArray(seenRaw)) {
    const next: unknown[] = [];
    for (const tool of seenRaw) {
      if (!isRecord(tool) || typeof tool.name !== "string") {
        next.push(tool);
        continue;
      }
      if (!fromAdapter(tool)) {
        next.push(tool);
        continue;
      }
      const verdict = migration.verdict(tool.name);
      if (verdict.kind === "map") {
        const { package: _package, ...rest } = tool;
        const server = migration.setName(verdict.server);
        next.push({ ...rest, name: verdict.to, source: server, server });
        migration.counted();
      }
      // Its wrapper tools, the resource tools of a server and a tool that cannot be told from another's are not remembered: the servers report them again as they run.
    }
    if (JSON.stringify(next) !== JSON.stringify(seenRaw)) putIn(d, "tools_seen", JSON.stringify(next));
  }

  // Standing permissions by the tool's name: the tool of an MCP server by its new name; one given to the adapter's `mcp` tool, or to the gateway, to the tool it reached. What cannot be told is dropped: a rule only ever allows.
  const droppedRules: { id: string; tool: string; why: string }[] = [];
  const rules = d.prepare("SELECT id, tool, pattern FROM tool_rules").all() as { id: string; tool: string; pattern: string }[];
  const updateRule = d.prepare("UPDATE tool_rules SET tool = ?, pattern = ? WHERE id = ?");
  const deleteRule = d.prepare("DELETE FROM tool_rules WHERE id = ?");
  for (const rule of rules) {
    const verdict = migration.verdict(rule.tool);
    if (verdict.kind === "map") {
      updateRule.run(verdict.to, rule.pattern, rule.id);
      migration.counted();
    } else if (verdict.kind === "wrapper") {
      const subject = literalOf(rule.pattern);
      let reached: { tool: string; args: Record<string, unknown> } | undefined;
      try {
        const call = subject === undefined ? undefined : JSON.parse(subject);
        const tool = isRecord(call) ? (typeof call.tool === "string" ? call.tool : typeof call.name === "string" ? call.name : undefined) : undefined;
        const given = isRecord(call) ? call.args : undefined;
        const args = typeof given === "string" ? JSON.parse(given) : given;
        if (tool && isRecord(args)) reached = { tool: tool.trim(), args };
      } catch {
        // Not a rule on one call.
      }
      const target = reached && migration.verdict(reached.tool);
      const name = target?.kind === "map" ? target.to : target?.kind === "keep" ? reached!.tool : undefined;
      if (reached && name) {
        updateRule.run(name, literalPattern(subjectOfArgs(name, reached.args)), rule.id);
        migration.counted();
      } else {
        deleteRule.run(rule.id);
        droppedRules.push({ id: rule.id, tool: rule.tool, why: "a permission given to a way to other tools, which cannot be told from here which tool it was for" });
      }
    }
  }
  for (const rule of droppedRules) migration.note({ where: "standing permissions", name: rule.tool, why: rule.why });

  // Texts and folders that the person has to look at.
  const texts = textsNaming(d, migration.oldNames());
  const projects = projectsOf(d);

  // --- the files, after everything the database holds: a failure here rolls the whole upgrade back, and the next start tries it all again ---
  const out = migration.finish();
  const newFile = { ...out.extra, mcpServers: out.mcpServers };
  const text = JSON.stringify(newFile, null, 2) + "\n";
  const file = mcpConfigPath();
  const copy = `${file}.adapter`;
  let fileState: Report["file"]["state"] = "none";
  let copyNote: string | undefined;
  const hadFile = existsSync(file);
  if (hadFile && text !== raw) {
    // The file as it was, once: a try after one that stopped halfway keeps the first copy, not a converted one.
    if (!existsSync(copy)) writeFileAtomic(copy, raw, 0o600);
    writeFileAtomic(file, text, 0o600);
    fileState = "converted";
  } else if (hadFile) fileState = "converted";
  // Where the file was kept as it was, whichever try made the copy.
  if (existsSync(copy)) copyNote = path.basename(copy);

  // What each server offered, for the tool lists before it runs: pi has no cache of its own.
  for (const plan of migration.servers) {
    const entry = out.mcpServers[plan.newName];
    const offered = cache[plan.name];
    if (!entry || !offered?.tools.length) continue;
    const tools: CachedTool[] = [];
    for (const tool of offered.tools) {
      if (tool.appOnly) continue;
      const name = migration.nativeName(plan.name, tool.name);
      if (!name) continue;
      const parameters = tool.inputSchema ?? { type: "object", properties: {} };
      const description = tool.description ?? "";
      tools.push({ name, original: tool.name, description, parameters, tokens: declarationTokens(name, description, parameters) });
    }
    if (tools.length) {
      try {
        rememberServerTools(plan.newName, configHash(entry), tools);
      } catch (e) {
        console.warn(`[portal] what ${plan.newName} offered could not be kept for its tool list: ${(e as Error).message}`);
      }
    }
  }

  // The adapter leaves pi's package list: that is what lets pi's MCP support run. Its files stay on disk.
  let removed = false;
  let adapterNote: string | undefined;
  if (adapter) {
    try {
      updatePiSettingsNow((all) => {
        const packages = Array.isArray(all.packages) ? all.packages : [];
        const kept = packages.filter((entry) => !ADAPTER.test(sourceOf(entry) ?? ""));
        if (kept.length !== packages.length) all.packages = kept;
      });
      removed = true;
      for (const key of ["extension_stash", "extension_install_notes"]) {
        const stored = jsonIn(d, key);
        if (isRecord(stored) && adapter.source in stored) {
          delete stored[adapter.source];
          putIn(d, key, Object.keys(stored).length ? JSON.stringify(stored) : "");
        }
      }
    } catch (e) {
      adapterNote = `pi's settings could not be changed (${(e as Error).message}); the portal keeps the adapter out of every chat, and Settings → Extensions removes it`;
      console.warn(`[portal] ${adapterNote}`);
    }
  }

  const report: Report = {
    ...base,
    status: "done",
    adapter: { was: state.adapter, removed, ...(adapter ? { spec: adapter.source } : {}), ...(adapterNote ? { note: adapterNote } : {}) },
    file: { state: fileState, ...(copyNote ? { copy: copyNote } : {}) },
    servers: out.servers,
    names: out.names,
    expanded: out.expanded,
    unconverted: out.unconverted,
    untrusted,
    texts,
    projects,
    gone: out.gone,
    notes: [],
  };
  putIn(d, MCP_MIGRATION, JSON.stringify(report));
  putIn(d, MCP_MIGRATION_NOTICE, "1");
  try {
    writeFileAtomic(path.join(path.resolve(DATA_DIR), "mcp-migration.json"), JSON.stringify(report, null, 2) + "\n", 0o600);
  } catch (e) {
    console.warn(`[portal] the report of the MCP migration could not be written to its file: ${(e as Error).message}`);
  }
  const off = report.servers.filter((one) => one.state === "off" && one.why.length);
  console.log(
    `[portal] MCP servers moved to pi's own MCP support: ${report.servers.length} in the file, ${off.length} switched off${off.length ? ` (${off.map((one) => one.renamedTo ?? one.name).join(", ")})` : ""}; ` +
      `${report.names.converted} stored tool names carried over, ${report.unconverted.length} not; the old file is ${copyNote ?? "unchanged"}. Settings → MCP has the report.`,
  );
}
