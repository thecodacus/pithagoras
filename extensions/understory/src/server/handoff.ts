import { readFileSync } from "node:fs";
import path from "node:path";
import { portal } from "./host";
import { putSettings, setting, type Settings } from "./store";

/**
 * What the portal kept of Understory when it was part of it, taken up when Understory first starts: the upgrade that
 * made Understory an extension left it in the portal's data folder under the name "understory", and
 * `portal.handoffs.take` gives it to the first extension that asks, moved into its own folder. In it:
 *
 *   handoff.json    what it is: {"format": 1, …}, the format this reads
 *   settings.json   Understory's four settings as the portal stored them, each by its setting's name and null where it
 *                   had none: understory_config (the model that keeps the memory and when it tidies up, as JSON),
 *                   understory_token (the token its container was made with, which the agent's MCP entry carries),
 *                   understory_llm_token (the key it calls the model server with) and understory_last_dream (what the
 *                   last pass the portal started came to, as JSON)
 *
 * Each setting is kept where Understory's own store has none: one said here since, while the hand-off waited, is the
 * person's latest word. A JSON one that cannot be read is left out, as the portal read it as nothing said. Only then is
 * the hand-off done with, so a start that stopped half way takes it up again, harmlessly. What cannot be taken up stays
 * where it is, for the next start: Understory starts without it, and says why in the portal's log.
 *
 * The container and its volume are not in it: they are taken over by their names, as the half starts (service.ts). The
 * agent's MCP entry stays in pi's mcp.json, where it was, with its token.
 */
export function takeHandoff(): void {
  try {
    const dir = portal().handoffs.take("understory");
    if (!dir) return;
    const read = (name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    const { format } = read("handoff.json");
    if (format !== 1) throw new Error(`it is in a format this version of Understory does not read (${format})`);
    const kept: Record<string, unknown> = read("settings.json");
    const parsed = (value: unknown) => {
      try {
        return typeof value === "string" ? JSON.parse(value) : undefined;
      } catch {
        return undefined;
      }
    };
    const taken: Settings = {};
    const config = parsed(kept.understory_config);
    if (config !== undefined && setting("config") === undefined) taken.config = config;
    if (typeof kept.understory_token === "string" && setting("token") === undefined) taken.token = kept.understory_token;
    if (typeof kept.understory_llm_token === "string" && setting("llmToken") === undefined) taken.llmToken = kept.understory_llm_token;
    const lastDream = parsed(kept.understory_last_dream);
    if (lastDream !== undefined && setting("lastDream") === undefined) taken.lastDream = lastDream;
    const settings = Object.keys(taken);
    if (settings.length) putSettings(taken);
    portal().handoffs.done("understory");
    portal().log(`took up what the portal kept of Understory${settings.length ? `: the settings ${settings.join(", ")}` : ""}`);
  } catch (e) {
    // Nothing of it is lost: it stays where it is, for the next start to take up.
    portal().log(`could not take up what the portal kept of Understory, which is kept for the next start: ${(e as Error).message}`);
  }
}
