import test from "node:test";
import assert from "node:assert/strict";
import { mentionsCommand, statusParts } from "../core/web/src/status-commands.ts";

test("a command named in an extension's status can be run from it, and nothing else", () => {
  const known = new Set(["bg-update", "reload"]);
  assert.deepEqual(statusParts("bg ⬆ v2.6.5 /bg-update", known), [{ text: "bg ⬆ v2.6.5 " }, { command: "bg-update" }]);
  assert.deepEqual(statusParts("/reload, then /bg-update.", known), [{ command: "reload" }, { text: ", then " }, { command: "bg-update" }, { text: "." }]);
  assert.deepEqual(statusParts("logs in /tmp/x and /nope", known), [{ text: "logs in /tmp/x and /nope" }]);
  assert.deepEqual(statusParts("a/bg-update", known), [{ text: "a/bg-update" }], "only a word of its own");
  // Named as people name commands: before a colon or a dash, in brackets or quotes.
  assert.deepEqual(statusParts("run /bg-update: now", known), [{ text: "run " }, { command: "bg-update" }, { text: ": now" }]);
  assert.deepEqual(statusParts("(/bg-update)", known), [{ text: "(" }, { command: "bg-update" }, { text: ")" }]);
  assert.deepEqual(statusParts('try "/reload"', known), [{ text: 'try "' }, { command: "reload" }, { text: '"' }]);
  assert.deepEqual(statusParts("try /bg-update-", known), [{ text: "try " }, { command: "bg-update" }, { text: "-" }]);
  assert.equal(mentionsCommand("bg ⬆ v2.6.5 /bg-update"), true);
  assert.equal(mentionsCommand("(/bg-update)"), true);
  assert.equal(mentionsCommand("3 running"), false);
});

import { buildTranscript } from "../core/web/src/transcript.ts";

test("each command sent is a line in the chat that says how it went", () => {
  let seq = 0;
  const ev = (type: string, payload: any = {}) => ({ seq: ++seq, type, at: 0, payload });
  const items = buildTranscript([
    ev("portal_command", { text: "/bg-clear" }),
    ev("portal_command_end", { of: 1, outcome: "handled", quiet: true }),
    ev("portal_command", { text: "/bg-update" }),
    ev("portal_notice", { text: "2.6.5 is out", from: "extension" }),
    ev("portal_command_end", { of: 3, outcome: "handled" }),
    ev("portal_command", { text: "/skill:x" }),
    ev("portal_command_end", { of: 6, outcome: "started" }),
    ev("portal_command", { text: "/broken" }),
    ev("portal_notice", { text: "/broken failed: boom", error: true, from: "extension", of: 8 }),
    ev("portal_command_end", { of: 8, error: "boom" }),
    ev("message_end", { message: { role: "custom", customType: "r", content: [{ type: "text", text: "All green" }], display: true } }),
    ev("message_end", { message: { role: "custom", customType: "hidden", content: "for the model", display: false } }),
    // Not said to be for display: for the model, as pi's TUI takes it.
    ev("message_end", { message: { role: "custom", customType: "ctx", content: "context for the model" } }),
  ]);
  assert.deepEqual(
    items.map((i) => (i.kind === "command" ? `${i.text}:${i.state}${i.error ? `:${i.error}` : ""}` : i.kind === "notice" ? `notice:${i.text}` : i.kind)),
    ["/bg-clear:quiet", "/bg-update:done", "notice:2.6.5 is out", "/skill:x:started", "/broken:failed:boom", "notice:All green"],
  );
});

const line = (i: any) => (i.kind === "command" ? `${i.text}:${i.state}${i.error ? `:${i.error}` : ""}` : i.kind === "notice" ? `notice:${i.text}` : i.kind);

test("a command still going is not taken for done when the run beside it ends", () => {
  let seq = 0;
  const ev = (type: string, payload: any = {}) => ({ seq: ++seq, type, at: 0, payload });
  const items = buildTranscript([
    ev("agent_start"),
    // Sent into the run, and waiting on a dialog when the run ends.
    ev("portal_command", { text: "/deploy" }),
    ev("agent_end"),
    ev("portal_status", { status: "idle" }),
  ]);
  assert.deepEqual(items.filter((i) => i.kind === "command").map(line), ["/deploy:running"]);
});

test("a command's failure is said on its line once it ends, and by its notice until then", () => {
  let seq = 0;
  const ev = (type: string, payload: any = {}) => ({ seq: ++seq, type, at: 0, payload });
  const thrown = [ev("portal_command", { text: "/broken" }), ev("portal_notice", { text: "/broken failed: boom", error: true, from: "extension", of: 1 })];
  // Its end not yet written — or never, where the portal went first: the notice is all that says it.
  assert.deepEqual(buildTranscript(thrown).map(line), ["/broken:running", "notice:/broken failed: boom"]);
  assert.deepEqual(buildTranscript([...thrown, ev("portal_command_end", { of: 1, error: "boom" })]).map(line), ["/broken:failed:boom"]);
});

test("a message for people is shown without the codes a terminal would act on", () => {
  const items = buildTranscript([
    { seq: 1, type: "message_end", at: 0, payload: { message: { role: "custom", customType: "r", content: "\x1b[?25l\x1b[32mAll green\x1b[0m", display: true } } },
  ]);
  assert.deepEqual(items.map(line), ["notice:All green"]);
});

test("a message of markup written for the model is shown as the sentence it carries: a background task's end is one", () => {
  const block = (status: string, extra = "") =>
    [
      "<background-task-notification>",
      "  <task-id>b55b2d6a4</task-id>",
      "  <task-name>Watch PR 103 CI</task-name>",
      `  <status>${status}</status>`,
      extra,
      "  <output-file>.pi/tasks/x/b55b2d6a4.output</output-file>",
      `  <summary>Background task "Watch PR 103 CI" ${status}</summary>`,
      "  <guidance>Do not call bg_status to reconfirm.</guidance>",
      "</background-task-notification>",
    ].filter(Boolean).join("\n");
  const end = (seq: number, content: string) => ({ seq, type: "message_end", at: 0, payload: { message: { role: "custom", customType: "background-task-notification", content, display: true } } });
  const items = buildTranscript([
    end(1, block("completed", "  <exit-code>0</exit-code>")),
    // As the extension writes them: a failing command says its code in its error, a killed or timed-out one has no code.
    end(2, block("failed", "  <exit-code>2</exit-code>\n  <error>Exited with code 2</error>")),
    end(3, block("killed", "  <exit-code>null</exit-code>")),
    end(4, block("failed", "  <exit-code>null</exit-code>\n  <error>Timed out after 30s</error>")),
    end(5, block("failed", "  <exit-code>3</exit-code>")),
  ]);
  assert.deepEqual(items.map(line), [
    'notice:Background task "Watch PR 103 CI" completed',
    'notice:Background task "Watch PR 103 CI" failed (Exited with code 2)',
    'notice:Background task "Watch PR 103 CI" killed',
    'notice:Background task "Watch PR 103 CI" failed (Timed out after 30s)',
    'notice:Background task "Watch PR 103 CI" failed (exit code 3)',
  ]);
  assert.deepEqual(items.map((i: any) => i.tone), ["info", "warn", "warn", "warn", "warn"]);
});

test("any extension's markup message is shown readably, and words that are not markup stay as they are", () => {
  const shown = (content: string) => buildTranscript([{ seq: 1, type: "message_end", at: 0, payload: { message: { role: "custom", customType: "x", content, display: true } } }]);
  const titled = shown("<sync-result>\n  <id>7</id>\n  <title>Synced 3 files</title>\n  <path>/a/b</path>\n</sync-result>");
  assert.deepEqual(titled.map(line), ["notice:Synced 3 files"]);
  const bare = shown("<job-report>\n  <job>nightly</job>\n  <status>failed</status>\n</job-report>");
  assert.deepEqual(bare.map(line), ["notice:job: nightly\nstatus: failed"]);
  assert.equal((bare[0] as any).tone, "warn");
  for (const plain of ["All green", "a <b>bold</b> word", "Use <tag> like this", "<b>bold</b>", "<note><b>Heads up:</b> the build server is down until 5pm</note>", "<p>Run <code>npm test</code> before you push.</p>"]) assert.deepEqual(shown(plain).map(line), [`notice:${plain}`]);
  // Only a failure word warns: a green CI result or a job that has just started is not a warning.
  const status = (word: string) => shown(`<ci-result>\n  <title>CI for PR 7</title>\n  <status>${word}</status>\n</ci-result>`)[0] as any;
  for (const word of ["passed", "running", "started", "queued", "complete", "finished", "completed"]) {
    assert.equal(status(word).tone, "info", word);
    assert.equal(status(word).text, `CI for PR 7 (${word})`, word);
  }
  for (const word of ["failed", "Timed-out", "timed_out", "timed out", "cancelled", "aborted"]) {
    assert.equal(status(word).tone, "warn", word);
    assert.equal(status(word).text, `CI for PR 7 (${word})`, word);
  }
  // The status is not said twice, and an exit code comes after it.
  // A status spelled differently from the same words in the summary is not added after them.
  for (const [summary, word] of [["CI for PR 7 timed out", "timed-out"], ["CI for PR 7 timed out", "timed_out"], ["Deploy cancelled", "canceled"], ["Deploy canceled", "cancelled"]]) {
    assert.deepEqual(shown(`<ci>\n  <summary>${summary}</summary>\n  <status>${word}</status>\n</ci>`).map(line), [`notice:${summary}`], word);
  }
  assert.deepEqual(shown("<deploy>\n  <message>Deploy of web</message>\n  <status>timeout</status>\n</deploy>").map(line), ["notice:Deploy of web (timeout)"]);
  assert.deepEqual(shown("<deploy>\n  <message>Deploy of web failed</message>\n  <status>failed</status>\n  <exit-code>3</exit-code>\n</deploy>").map(line), ["notice:Deploy of web failed (exit code 3)"]);
  assert.deepEqual(shown("<deploy>\n  <message>Deploy of web</message>\n  <status>failed</status>\n  <exit-code>3</exit-code>\n</deploy>").map(line), ["notice:Deploy of web (failed, exit code 3)"]);
});
