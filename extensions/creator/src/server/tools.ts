import { rmSync } from "node:fs";
import type { Chat } from "@pithagoras/extension-api/server";
import { DONE } from "../mode";
import { copyOf, listMade, oneAtATime, records, saveRecords, subjectOf, type Run } from "./made";

/** A tool's answer: its result as JSON, for the model, and as itself, for the page. */
const answer = (result: object) => ({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result });

/** What `extension_status` gives of an extension's lines: the last 50, and of those no more than 8,000 characters. */
const LINES = { count: 50, chars: 8_000 };

/**
 * Creator mode's tools, in a chat in the mode: say where a made extension stands, and remove one. Each throws with its
 * reason where it refuses, which pi gives the model as the call's error. After a suspected prompt injection the guard
 * asks the person before a removal (`acts: ["persist"]`); what a made extension says of itself is outside content
 * (`outside`).
 */
export function registerTools(run: Run, pi: any, chat: Chat): void {
  const { portal } = run;

  pi.registerTool({
    name: "extension_status",
    label: "Extension status",
    description:
      "Where an extension stands: without `name`, every extension made in Creator mode; with it, whether its server half runs, why not, the crash it is held off for, what this chat could not load of it, its page's last failure, and its latest log lines (after `since`, the `next` of an earlier answer).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The extension's package name" },
        since: { type: "number", description: "Only the lines after this one: the `next` an earlier answer gave" },
      },
      additionalProperties: false,
    },
    // What a made extension logs can hold what it fetched from outside.
    guard: { outside: true },
    execute: async (_id: string, params: { name?: string; since?: number }) => {
      if (params.name === undefined) return answer({ made: (await listMade(run)).map(({ draft: _draft, ...one }) => ({ ...one, chat: one.chat?.title ?? null })) });
      const status = await portal.extensions.status(params.name, { chatId: chat.id, ...(params.since !== undefined ? { since: params.since } : {}) });
      if (!status) throw new Error(`${params.name} is not installed`);
      if (!status.server) return answer(status);
      let lines = status.server.lines.slice(-LINES.count);
      while (lines.length > 1 && lines.reduce((sum, line) => sum + line.text.length, 0) > LINES.chars) lines = lines.slice(1);
      return answer({ ...status, server: { ...status.server, lines }, next: lines.at(-1)?.id ?? params.since });
    },
  });

  pi.registerTool({
    name: "extension_remove",
    label: "Remove extension",
    description: "Uninstalls an extension made in Creator mode, and deletes its copy. The draft in this chat's folder stays.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "The extension's package name" } },
      required: ["name"],
      additionalProperties: false,
    },
    guard: { acts: ["persist"] },
    execute: (_id: string, params: { name: string }) =>
      oneAtATime(async () => {
        const made = records(run);
        const record = made.get(params.name);
        if (!record) throw new Error(`${params.name} was not made in Creator mode: remove it in Settings → Extensions`);
        const removed = await portal.extensions.remove(params.name);
        rmSync(copyOf(run, params.name), { recursive: true, force: true });
        made.delete(params.name);
        saveRecords(run, made);
        portal.audit.record({ subject: subjectOf(params.name, record), reason: DONE.removed, chatId: chat.id });
        return answer(removed);
      }),
  });
}
