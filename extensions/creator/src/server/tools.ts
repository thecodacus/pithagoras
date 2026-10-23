import { rmSync } from "node:fs";
import type { Chat } from "@pithagoras/extension-api/server";
import { DONE } from "../mode";
import { copyOf, listMade, oneAtATime, records, saveRecords, subjectOf, type Run } from "./made";
import { installed, snapshot, undo } from "./snapshot";

/** A tool's answer: its result as JSON, for the model, and as itself, for the page. */
const answer = (result: object) => ({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result });

/** When an install's tools are in the chat (the reload at the next step waits while a subagent works in the background). */
const NEXT =
  "This chat loads it before your next step, or once this run ends while a subagent of this chat is still working in the background: its tools are there then. It stays switched off where the person switched it off in Settings.";

/** What `extension_status` gives of an extension's lines: the last 50, and of those no more than 8,000 characters. */
const LINES = { count: 50, chars: 8_000 };

/**
 * Creator mode's tools, in a chat in the mode: install a draft of the chat's folder into the portal (again, after a
 * change), say where a made extension stands, and remove one. Each throws with its reason where it refuses, which pi
 * gives the model as the call's error. After a suspected prompt injection the guard asks the person before an install
 * or a removal (`acts: ["persist"]`); what a made extension says of itself is outside content (`outside`).
 */
export function registerTools(run: Run, pi: any, chat: Chat): void {
  const { portal } = run;

  pi.registerTool({
    name: "extension_install",
    label: "Install extension",
    description:
      "Installs the extension in the folder `path` (relative to this chat's folder) into the portal, or installs it again after a change: a copy of it is taken and loaded. Its tools are in this chat from your next step.",
    promptGuidelines: [
      "After extension_install, read what it says of the server half. If it names a failure or a crash, call extension_status and fix the code before calling the new tools.",
      "Install again after every change; nothing reloads by itself.",
    ],
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "The extension's folder, relative to this chat's folder: extensions/<name>" } },
      required: ["path"],
      additionalProperties: false,
    },
    guard: { acts: ["persist"], outside: true },
    execute: (_id: string, params: { path: string }) =>
      oneAtATime(async () => {
        const draft = params.path;
        const copy = await snapshot(run, chat, draft);
        const made = records(run);
        const first = !made.has(copy.name);
        let status;
        try {
          status = await portal.extensions.install(copy.folder, { note: `${portal.chats.get(chat.id)?.title ?? chat.title} · ${draft}` });
        } catch (e) {
          // What pi lists stays what was installed and recorded last: a copy changed in made/ without an install would load, unrecorded, at the next sync.
          undo(copy);
          throw e;
        }
        const record = { ...(copy.version ? { version: copy.version } : {}), chat: chat.id, draft, digest: copy.digest, at: new Date().toISOString() };
        // In Audit first: whatever fails after it, the install is there.
        portal.audit.record({ subject: subjectOf(copy.name, record), reason: first ? DONE.installed : DONE.again, chatId: chat.id });
        made.set(copy.name, record);
        saveRecords(run, made);
        installed(copy);
        // Its lines are extension_status's, which hands them over as outside content. What this chat could not load of
        // it is said there too: the chat loads it at its next step, after this answer.
        const { enabled, server, client, reloaded, waiting } = status;
        return answer({
          name: copy.name,
          version: copy.version,
          digest: copy.digest,
          files: copy.files,
          bytes: copy.bytes,
          left: copy.left,
          enabled,
          server: server && { running: server.running, failure: server.failure, crash: server.crash },
          client,
          reloaded,
          waiting,
          next: NEXT,
        });
      }),
  });

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
