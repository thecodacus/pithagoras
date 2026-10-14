import express, { type Router } from "express";
import { applySandbox, type ApplyReport } from "../sandbox/apply.js";
import { DEFAULT_POLICY, SECRETS_DIR, TRUSTED_DIR, parsePolicy, sandboxPolicy, sandboxSupport, saveSandboxPolicy } from "../sandbox/policy.js";

/** What the last apply did, for the page to show until the next one. */
let lastReport: ApplyReport | null = null;

/** What the router needs of the chats: reloading the open ones, so a change reaches them. */
interface OpenChats {
  reloadIdle(): Promise<{ reloaded: number; waiting: number }>;
}

/**
 * The open chats reloaded, so each takes the sandbox as it now is: tools are
 * bound when a chat's pi loads its extensions, and a chat opened before the
 * switch would otherwise keep what it had. A busy one is tried again until it
 * is idle, for up to ten minutes.
 */
async function reloadChats(chats: OpenChats): Promise<{ reloaded: number; waiting: number }> {
  const first = await chats.reloadIdle();
  if (first.waiting) {
    let tries = 0;
    const retry = setInterval(async () => {
      const r = await chats.reloadIdle().catch(() => ({ reloaded: 0, waiting: 0 }));
      if (!r.waiting || ++tries >= 60) clearInterval(retry);
    }, 10_000);
    retry.unref?.();
  }
  return first;
}

/** Settings → Sandbox: the policy, whether this portal can sandbox, and putting a policy on. */
export function sandboxRouter(chats: OpenChats): Router {
  const router = express.Router();

  router.get("/sandbox", (_req, res) => {
    const support = sandboxSupport();
    res.json({
      policy: sandboxPolicy(),
      defaults: DEFAULT_POLICY(),
      available: support.available,
      reason: support.reason ?? null,
      trustedDir: TRUSTED_DIR,
      secretsDir: SECRETS_DIR,
      lastReport,
    });
  });

  /**
   * Saves a policy and puts it on the files at once. With a big workspace under
   * a read or write rule this walks every file in it, so it can take a while;
   * the answer says what was done and what could not be.
   */
  router.put("/sandbox", async (req, res) => {
    let policy;
    try {
      policy = parsePolicy(req.body);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    const support = sandboxSupport();
    if (policy.enabled && !support.available) return res.status(409).json({ error: support.reason });
    // Put on first, saved after: a sandbox saved as on whose rules did not go on looks on and protects nothing.
    lastReport = await applySandbox(policy, support, true);
    console.log(`[sandbox] ${policy.enabled ? "apply" : "off"}: ${lastReport.ok ? "ok" : "failed"}${lastReport.warnings.length ? ` — ${lastReport.warnings.join("; ")}` : ""}`);
    if (policy.enabled && !lastReport.ok) {
      saveSandboxPolicy({ ...policy, enabled: false });
      await applySandbox({ ...policy, enabled: false }, support, false);
      return res.status(500).json({ error: `The sandbox was not switched on: ${lastReport.warnings.join("; ")}`, report: lastReport });
    }
    saveSandboxPolicy(policy);
    const reloaded = await reloadChats(chats);
    res.json({ policy: sandboxPolicy(), report: lastReport, chats: reloaded });
  });

  return router;
}
