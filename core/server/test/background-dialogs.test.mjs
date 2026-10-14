import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * A dialog an extension opens (confirm, select, input, editor) where nobody can answer it (issue #114): in a
 * routine run, a heartbeat look and a chat reached through a channel it is answered at once with its no-answer
 * value, and shown to no page. In a chat of the person's, in the browser, it is shown and waits.
 */
inProcessHome("pithagoras-background-dialogs-");
const model = await fakeModel();
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));

const { createSession, getSettings, setSettings } = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");
setSettings({ ...getSettings(), provider: "fake", model: "m" });

/** The pi the portal starts for a conversation of this kind, with the events it sends. */
async function launch(id, kind, extra = {}) {
  createSession({ id, title: id, workspace: process.env.WORKSPACE_ROOT, executor: "host", kind, ...extra });
  const client = await sessions.ensureClient(id);
  const events = [];
  client.on("event", (e) => events.push(e));
  return { client, ui: client.buildUiContext(), events };
}
const requests = (events) => events.filter((e) => e.type === "extension_ui_request");

/** Every kind of dialog is answered at once, with nothing sent and nothing left to replay to a page that opens. */
async function unanswerable(id, kind, extra) {
  const { client, ui, events } = await launch(id, kind, extra);
  try {
    // Not awaited together: a dialog that waited would hang the test, not fail it.
    const answers = await Promise.race([
      Promise.all([ui.confirm("Sure?", "Really"), ui.select("Pick", ["a", "b"]), ui.input("Name", ""), ui.editor("Edit", "text"), ui.questions({ questions: [] })]),
      new Promise((r) => setTimeout(() => r("it waited"), 2000)),
    ]);
    assert.deepEqual(answers, [false, undefined, undefined, undefined, undefined]);
    assert.deepEqual(requests(events), [], "no dialog request went to any page");
    assert.equal(client.dialogsOpen(), 0);
    assert.deepEqual(client.openDialogRequests(), []);
    assert.deepEqual(sessions.liveSnapshot(id).filter((row) => row.type === "extension_ui_request"), [], "nothing is replayed to a page that opens");
    // One-way news is not a dialog: it still goes out.
    ui.notify("Done", "info");
    assert.equal(requests(events).length, 1);
  } finally {
    client.dispose();
  }
}

test("a routine run answers an extension's dialog at once with no answer, and shows it nowhere", async () => {
  await unanswerable("bg-routine", "routine", { routine_slug: "nightly" });
});

test("a heartbeat look answers an extension's dialog at once with no answer, and shows it nowhere", async () => {
  await unanswerable("bg-heartbeat", "heartbeat");
});

test("a chat reached through a channel answers an extension's dialog at once with no answer, and shows it nowhere", async () => {
  await unanswerable("bg-channel", "agent", { channel_slug: "telegram", channel_key: "telegram:1" });
});

test("a chat in the browser, and a conversation on the Agent page, show the dialog and wait for the person", async () => {
  for (const [id, kind, extra] of [["fg-chat", "task", {}], ["fg-agent-page", "agent", { channel_slug: "browser", channel_key: "page1234" }]]) {
    const { client, ui, events } = await launch(id, kind, extra);
    try {
      const answer = ui.confirm("Sure?", "Really");
      assert.equal(requests(events).length, 1, id);
      assert.equal(sessions.liveSnapshot(id).filter((row) => row.type === "extension_ui_request").length, 1, `${id}: replayed to a page that opens`);
      assert.equal(sessions.respondUi(id, requests(events)[0].id, { value: true }), true);
      assert.equal(await answer, true, id);
    } finally {
      client.dispose();
    }
  }
});
