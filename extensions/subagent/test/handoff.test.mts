import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scratch } from "../../../tests/helpers.mts";
import { takeChatsHandoff, takeHandoff } from "../src/server.ts";
import { chatModel, openChats, setChatModel } from "../src/per-chat.ts";
import { openStore, saveSettings, settings } from "../src/settings.ts";

/**
 * Taking up the settings pi's settings.json held for the tool before it was an extension, from a hand-off folder as
 * the upgrade leaves it (core's side is in schema-fingerprint.test.mjs, and both together in upgrade.test.mts), over a
 * stand-in for the portal whose `handoffs` give the folder from where the extension's data folder has it.
 */

/** The extension's data folder with its store open, and the portal it is given. `done` removes what `take` gave. */
function extension({ removes = true } = {}) {
  const data = realpathSync(scratch("subagent-handoff-"));
  const logged: string[] = [];
  const kept = path.join(data, "handoff-subagent");
  const portal = {
    log: (line: string) => logged.push(line),
    handoffs: {
      take: (name: string) => (name === "subagent" && existsSync(kept) ? kept : undefined),
      done: (name: string) => void (removes && name === "subagent" && rmSync(kept, { recursive: true, force: true })),
    },
  };
  openStore(data);
  /** A hand-off left as the upgrade leaves it: pi's three keys, each null where pi's settings had none. */
  const leave = (said: Record<string, unknown>, format = 1) => {
    mkdirSync(kept, { recursive: true });
    writeFileSync(path.join(kept, "handoff.json"), JSON.stringify({ format, name: "subagent", schema: 12, made: "2026-10-25T10:00:00.000Z" }));
    writeFileSync(path.join(kept, "settings.json"), JSON.stringify({ subagentMode: null, subagentMaxParallel: null, subagentModel: null, ...said }));
  };
  const stored = () => JSON.parse(readFileSync(path.join(data, "settings.json"), "utf8"));
  return { portal, logged, kept, leave, stored, data };
}

test("what pi's settings said is the extension's, read as the tool read it, and the hand-off is done with", () => {
  const { portal, logged, kept, leave, stored } = extension();
  leave({ subagentMode: "background", subagentMaxParallel: 3, subagentModel: "llama-swap/model-b" });
  takeHandoff(portal as any);
  assert.deepEqual(settings(), { mode: "background", maxParallel: 3, model: "llama-swap/model-b" });
  // With a note of what came from pi's settings, for a later hand-off to tell it from what the person says.
  const given = { mode: "background", maxParallel: 3, model: "llama-swap/model-b" };
  assert.deepEqual(stored(), { ...given, handedOver: given });
  assert.equal(existsSync(kept), false);
  assert.deepEqual(logged, ["took up the subagent settings pi's settings held: mode, maxParallel, model"]);
});

test("taken up twice, as by a start that stopped before it was done, it comes to the same", () => {
  const { portal, leave, stored } = extension({ removes: false });
  leave({ subagentMode: "background", subagentMaxParallel: 40 });
  takeHandoff(portal as any);
  takeHandoff(portal as any);
  // More than the tool ever ran at once is what it ran: the most there may be.
  assert.deepEqual(stored(), { mode: "background", maxParallel: 16, handedOver: { mode: "background", maxParallel: 16 } });
});

test("one said on the page while the hand-off waited stays, and what pi's settings had as the default is nothing to take", () => {
  const { portal, logged, leave, stored } = extension();
  saveSettings({ ...settings(), maxParallel: 2 });
  leave({ subagentMode: "interrupt", subagentMaxParallel: 4, subagentModel: "auto" });
  takeHandoff(portal as any);
  assert.deepEqual(stored(), { maxParallel: 2 });
  assert.deepEqual(logged, ["took up the subagent settings pi's settings held"]);
});

test("one in a format this does not read is kept for a later version, and says why", () => {
  const { portal, logged, kept, leave } = extension();
  leave({ subagentMode: "background" }, 2);
  takeHandoff(portal as any);
  assert.equal(settings().mode, "interrupt");
  assert.ok(existsSync(kept));
  assert.deepEqual(logged, ["could not take up the subagent settings pi's settings held, which are kept for the next start: they are in a format this version does not read (2)"]);
});

test("a second hand-off, after going back and upgrading again, gives what pi's settings hold then, except where the page has said otherwise since", () => {
  const { portal, logged, kept, leave, stored } = extension();
  leave({ subagentMode: "background", subagentMaxParallel: 3 });
  takeHandoff(portal as any);
  assert.deepEqual(stored(), { mode: "background", maxParallel: 3, handedOver: { mode: "background", maxParallel: 3 } });
  // Back in the older version the limit became 4 and the model was chosen; the upgrade leaves them again.
  leave({ subagentMode: "background", subagentMaxParallel: 4, subagentModel: "llama-swap/model-b" });
  takeHandoff(portal as any);
  assert.deepEqual(settings(), { mode: "background", maxParallel: 4, model: "llama-swap/model-b" });
  assert.equal(existsSync(kept), false);
  assert.equal(logged[1], "took up the subagent settings pi's settings held: maxParallel, model");
  // The person says another limit on the page; a third hand-off does not take it back.
  saveSettings({ ...settings(), maxParallel: 6 });
  leave({ subagentMode: "background", subagentMaxParallel: 5, subagentModel: "llama-swap/model-c" });
  takeHandoff(portal as any);
  assert.deepEqual(settings(), { mode: "background", maxParallel: 6, model: "llama-swap/model-c" });
});

/**
 * What each chat said its subagents run on, as the upgrade to schema 13 leaves it (core's side is in
 * schema-fingerprint.test.mjs, both together in upgrade.test.mts), taken up the same way.
 */
function chatsExtension({ removes = true } = {}) {
  const data = realpathSync(scratch("subagent-chats-handoff-"));
  const logged: string[] = [];
  const kept = path.join(data, "handoff-subagent-chats");
  const portal = {
    log: (line: string) => logged.push(line),
    handoffs: {
      take: (name: string) => (name === "subagent-chats" && existsSync(kept) ? kept : undefined),
      done: (name: string) => void (removes && name === "subagent-chats" && rmSync(kept, { recursive: true, force: true })),
    },
  };
  openChats(data);
  const leave = (models: unknown, format = 1) => {
    mkdirSync(kept, { recursive: true });
    writeFileSync(path.join(kept, "handoff.json"), JSON.stringify({ format, name: "subagent-chats", schema: 13, made: "2026-10-25T10:00:00.000Z" }));
    writeFileSync(path.join(kept, "models.json"), JSON.stringify(models));
  };
  const stored = () => JSON.parse(readFileSync(path.join(data, "chats.json"), "utf8"));
  return { portal, logged, kept, leave, stored };
}

test("what each chat said its subagents run on is the extension's, and the hand-off is done with", () => {
  const { portal, logged, kept, leave, stored } = chatsExtension();
  leave({ "chat-1": "llama-swap/model-b", "chat-2": "auto" });
  takeChatsHandoff(portal as any);
  assert.deepEqual([chatModel("chat-1"), chatModel("chat-2"), chatModel("chat-3")], ["llama-swap/model-b", "auto", undefined]);
  assert.deepEqual(stored(), { "chat-1": "llama-swap/model-b", "chat-2": "auto" });
  assert.equal(existsSync(kept), false);
  assert.deepEqual(logged, ["took up what 2 chats said their subagents run on"]);
});

test("taken up twice comes to the same, and a chat that said another since in its model menu keeps that", () => {
  const { portal, leave, stored } = chatsExtension({ removes: false });
  setChatModel("chat-1", "vllm/model-c");
  leave({ "chat-1": "llama-swap/model-b", "chat-2": "auto", "chat-3": "no model" });
  takeChatsHandoff(portal as any);
  takeChatsHandoff(portal as any);
  // What is no model was never one the portal took: nothing to take.
  assert.deepEqual(stored(), { "chat-1": "vllm/model-c", "chat-2": "auto" });
});

test("a chats' hand-off in a format this does not read is kept for a later version, and says why", () => {
  const { portal, logged, kept, leave } = chatsExtension();
  leave({ "chat-1": "auto" }, 2);
  takeChatsHandoff(portal as any);
  assert.equal(chatModel("chat-1"), undefined);
  assert.ok(existsSync(kept));
  assert.deepEqual(logged, ["could not take up what the chats said their subagents run on, which is kept for the next start: it is in a format this version does not read (2)"]);
});
