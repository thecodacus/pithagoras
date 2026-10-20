import express, { type Router } from "express";
import {
  allTrustedResults,
  browserAllowlist,
  getDb,
  getDefaultReportTo,
  getSession,
  openGrants,
  recordAudit,
  revokeGrant,
  routineExemptions,
  setBrowserAllowlist,
  setRoutineExemptions,
  setTrustedMcpServers,
  trustedMcpServers,
} from "../db.js";
import { EXECUTOR_KIND } from "../executor-kind.js";
import { hasPrimary } from "../people.js";
import { GUARD_RULES, flaggedResult, untrustFlagged } from "../pi/guard.js";
import { GUARD_RULE_NAMES } from "../pi/guard-rule-names.js";
import { sandboxOn, sandboxSupport } from "../sandbox/policy.js";
import { serversAndBrowsers } from "./mcp.js";

/**
 * The Guard page in Settings: what the guard holds and what of it can be changed (see pi/guard.ts and
 * docs/guide/security.md). What can be changed is where the owner decided it may be: a routine's exemption from a
 * rule after a suspected injection, one rule at a time; an MCP server counted as the person's own and not outside
 * content; the sites the agent's tools may reach; and taking back what was allowed once, an approval not yet spent or
 * a flagged result that was trusted. Everything else is shown, and stays as it is.
 */

/** What a trusted result was, read from the call that carried it: its tool, the signs it carried and the start of what it said. */
interface TrustedResult {
  id: string;
  tool?: string;
  signals?: string[];
  excerpt?: string;
}

/** The flagged result with this envelope id in a conversation's events, as the page shows it; just its id where it is not found. */
function trustedResult(sessionId: string, id: string): TrustedResult {
  const row = getDb()
    .prepare("SELECT payload FROM events WHERE session_id = ? AND type = 'tool_execution_end' AND payload LIKE ? ORDER BY seq DESC LIMIT 1")
    .get(sessionId, `%untrusted:${id}>>> (suspected prompt injection:%`) as { payload: string } | undefined;
  if (!row) return { id };
  try {
    const payload = JSON.parse(row.payload);
    const parts: { type?: string; text?: string }[] = Array.isArray(payload?.result?.content) ? payload.result.content : [];
    const texts = parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text as string);
    const flagged = texts.map((text) => flaggedResult(text)).find(Boolean);
    // The envelope's first and last parts are its markers; what is between them is what was read.
    const read = texts.slice(1, -1).join(" ").replace(/\s+/g, " ").trim();
    return {
      id,
      ...(typeof payload?.toolName === "string" ? { tool: payload.toolName } : {}),
      ...(flagged ? { signals: flagged.signals } : {}),
      ...(read ? { excerpt: read.slice(0, 160) } : {}),
    };
  } catch {
    return { id };
  }
}

export function guardRouter(): Router {
  const router = express.Router();

  router.get("/guard", (_req, res) => {
    const trusted = trustedMcpServers();
    const { servers, browsers } = serversAndBrowsers();
    const support = sandboxSupport();
    const routines = getDb().prepare("SELECT id, slug, name FROM routines ORDER BY name COLLATE NOCASE").all() as { id: string; slug: string; name: string }[];
    res.json({
      // Only a pi the portal runs on the host has the guard: the container executor runs pi with none of the portal's extensions.
      running: EXECUTOR_KIND === "host",
      sandbox: sandboxOn() ? "on" : support.available ? "off" : "unavailable",
      primary: hasPrimary(),
      approvalsTo: getDefaultReportTo() !== null,
      rules: GUARD_RULES,
      servers: [...new Set([...servers, ...browsers])].sort().map((name) => ({ name, trusted: !browsers.includes(name) && trusted.has(name), browser: browsers.includes(name) })),
      routines: routines.map((routine) => ({ id: routine.id, name: routine.name, exempt: [...routineExemptions(routine.slug)] })),
      // The sites the agent's tools may reach, one domain per line: for every tool that says where it goes, and for an MCP server's browser tools. Empty is any site.
      allowlist: browserAllowlist().join("\n"),
      approvals: openGrants().map((grant) => ({
        id: grant.id,
        sessionId: grant.session_id,
        chat: getSession(grant.session_id)?.title ?? null,
        tool: grant.tool,
        subject: grant.subject,
        expiresAt: grant.expires_at,
      })),
      trusted: allTrustedResults().map(({ sessionId, ids }) => ({
        sessionId,
        chat: getSession(sessionId)?.title ?? null,
        results: ids.map((id) => trustedResult(sessionId, id)),
      })),
    });
  });

  /** One server counted as the person's own, or not. The browser is outside content whoever runs it, and is never counted so. */
  router.put("/guard/servers/:name", (req, res) => {
    const name = req.params.name;
    const on = req.body?.trusted;
    if (typeof on !== "boolean") return res.status(400).json({ error: "trusted must be true or false" });
    const { servers, browsers } = serversAndBrowsers();
    if (browsers.includes(name)) return res.status(400).json({ error: "The browser's pages are anybody's words; its server cannot be trusted" });
    if (on && !servers.includes(name)) return res.status(404).json({ error: `There is no MCP server called "${name}"` });
    const trusted = trustedMcpServers();
    if (on) trusted.add(name);
    else trusted.delete(name);
    setTrustedMcpServers([...trusted]);
    res.json({ name, trusted: on });
  });

  /** The rules a routine's runs are exempt from, by name: the rest hold. */
  router.put("/guard/routines/:id", (req, res) => {
    const exempt = req.body?.exempt;
    if (!Array.isArray(exempt) || !exempt.every((name) => typeof name === "string")) return res.status(400).json({ error: "exempt must be a list of rule names" });
    const unknown = exempt.filter((name) => !(GUARD_RULE_NAMES as readonly string[]).includes(name));
    if (unknown.length) return res.status(400).json({ error: `No such rule: ${unknown.join(", ")}` });
    const routine = getDb().prepare("SELECT id, slug FROM routines WHERE id = ?").get(req.params.id) as { id: string; slug: string } | undefined;
    if (!routine) return res.status(404).json({ error: "Not found" });
    setRoutineExemptions(routine.id, exempt);
    res.json({ id: routine.id, exempt: [...routineExemptions(routine.slug)] });
  });

  /** The sites the agent's tools may reach: one domain per line, `*.example.com` for its subdomains. Empty means any site. */
  router.put("/guard/allowlist", (req, res) => {
    const domains = req.body?.domains;
    if (typeof domains !== "string") return res.status(400).json({ error: "domains required" });
    setBrowserAllowlist(domains);
    res.json({ allowlist: browserAllowlist().join("\n") });
  });

  /** An approval taken back before it is spent. */
  router.delete("/guard/approvals/:id", (req, res) => {
    const grant = revokeGrant(req.params.id);
    if (!grant) return res.status(404).json({ error: "That approval was spent, ran out or was taken back already" });
    recordAudit({ kind: "revoked", tool: grant.tool, subject: grant.subject, reason: "One-off approval taken back before it was spent", sessionId: grant.session_id });
    res.json({ ok: true });
  });

  /** A flagged result that was trusted, untrusted: it holds its conversation back again. */
  router.delete("/guard/trusted/:session/:result", (req, res) => {
    const { session, result } = req.params;
    if (!/^[0-9a-f]{16}$/.test(result)) return res.status(400).json({ error: "Not a result" });
    if (!untrustFlagged(session, result)) return res.status(404).json({ error: "That result is not trusted" });
    recordAudit({ kind: "untrusted", reason: `Flagged result ${result} is no longer trusted`, sessionId: session });
    res.json({ ok: true });
  });

  return router;
}
