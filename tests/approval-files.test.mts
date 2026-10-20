import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "./helpers.mts";

// What a call of a tool that declares the files it is approved for (`approvalFiles`) is approved on: each of those files,
// by a tool rule or by the primary user's answer, and never the rest of the call. edit_image is that tool here by its name
// alone, with the two parameters it declares: one picture or a list of them.
inProcessHome("pitha-approval-files-");

/** What edit_image declares it is approved for (`approvalFiles`), as the guard reads it from the tool's definition. */
const EDIT_FILES = ["path", "paths"];
const filesOf = (name: string) => (name === "edit_image" ? EDIT_FILES : undefined);

test("a tool rule for edit_image is matched on each picture, whether it is named by path or by a list, never on the list's JSON", async () => {
  const { ruleAllows, guardExtension } = await import("../core/server/src/pi/guard.ts");
  const { addToolRule, deleteToolRule, listToolRules } = await import("../core/server/src/db.ts");
  const rule = (pattern: string, more: Record<string, unknown> = {}) =>
    ({ id: `r-${pattern}`, role: "colleague", tool: "edit_image", pattern, note: "", created_at: "", person_key: null, ...more }) as Parameters<typeof ruleAllows>[0][number];
  const allows = (rules: ReturnType<typeof rule>[], input: Record<string, unknown>, role = "colleague") => ruleAllows(rules, role, "edit_image", input, undefined, undefined, EDIT_FILES);

  const folder = [rule("shared/*")];
  assert.equal(allows(folder, { path: "shared/a.png", prompt: "p" }), true, "one picture, as ever");
  assert.equal(allows(folder, { path: "private.png", prompt: "p" }), false);
  // A list is the same pictures one by one: a folder rule that allowed each still does, and one that did not allow one does not allow the call.
  assert.equal(allows(folder, { paths: ["shared/a.png"], prompt: "p" }), true, "a list of one is the one picture");
  assert.equal(allows(folder, { paths: ["shared/a.png", "shared/b.jpg"], prompt: "p" }), true);
  assert.equal(allows(folder, { paths: ["shared/a.png", "private.png"], prompt: "p" }), false, "one that is not allowed is enough");
  assert.equal(allows(folder, { paths: ["private.png", "shared/a.png"], prompt: "p" }), false, "wherever it is in the list");

  // A rule for a word is not met by the prompt or by another picture of the list, which the call's JSON would have let through.
  const word = [rule("*shared/*")];
  assert.equal(allows(word, { path: "private.png", prompt: "like shared/x" }), false);
  assert.equal(allows(word, { paths: ["private.png"], prompt: "like shared/x" }), false, "the prompt is no picture");
  assert.equal(allows(word, { paths: ["private.png", "shared/a.png"], prompt: "p" }), false, "nor is another picture of the list");
  assert.equal(allows(word, { paths: ["x/shared/a.png", "y/shared/b.png"], prompt: "p" }), true);

  // Each picture needs a rule, not the same one: two folders, two rules.
  assert.equal(allows([rule("shared/*"), rule("pictures/*")], { paths: ["shared/a.png", "pictures/b.png"], prompt: "p" }), true);
  assert.equal(allows([rule("shared/*"), rule("pictures/*")], { paths: ["shared/a.png", "other/b.png"], prompt: "p" }), false);

  // Whichever name the tool would use is checked: a path that is allowed does not carry a list that is not, nor the other way round.
  assert.equal(allows(folder, { path: "shared/a.png", paths: ["private.png"], prompt: "p" }), false);
  assert.equal(allows(folder, { path: "private.png", paths: ["shared/a.png"], prompt: "p" }), false);
  assert.equal(allows(folder, { paths: "private.png", prompt: "p" }), false, "a list given as text, as pi may coerce it");
  // A call that names no picture, an empty list, or something that is no name is allowed by nothing, even by a rule for everything.
  const anything = [rule("*")];
  for (const input of [{ prompt: "p" }, { paths: [], prompt: "p" }, { paths: [""], prompt: "p" }, { paths: ["a.png", 5], prompt: "p" }, { path: 5, prompt: "p" }]) {
    assert.equal(allows(anything, input), false, JSON.stringify(input));
  }
  assert.equal(allows(anything, { paths: ["a.png", "b.png"], prompt: "p" }), true);

  // The rule's role, person and tool count as for any call.
  assert.equal(allows(folder, { paths: ["shared/a.png"], prompt: "p" }, "stranger"), false);
  assert.equal(allows([rule("shared/*", { role: "all" })], { paths: ["shared/a.png"], prompt: "p" }, "stranger"), true);
  assert.equal(allows([rule("shared/*", { tool: "show_image" })], { paths: ["shared/a.png"], prompt: "p" }), false);
  assert.equal(ruleAllows([rule("shared/*", { person_key: "priya" })], "colleague", "edit_image", { paths: ["shared/a.png"] }, "priya", undefined, EDIT_FILES), true);
  assert.equal(ruleAllows([rule("shared/*", { person_key: "priya" })], "colleague", "edit_image", { paths: ["shared/a.png"] }, "sam", undefined, EDIT_FILES), false);
  // Without its declaration a call is matched whole, as any tool's: an extra list neither narrows nor hides what it does.
  assert.equal(ruleAllows(folder, "colleague", "edit_image", { paths: ["shared/a.png"], prompt: "p" }), false, "a list is no file of an undeclared tool");

  // Other tools are matched as they were: a command, a path, or the call's own arguments.
  const bash = (pattern: string) => rule(pattern, { tool: "bash" });
  assert.equal(ruleAllows([bash("ls*")], "colleague", "bash", { command: "ls -l 2>&1" }), true);
  assert.equal(ruleAllows([bash("ls*")], "colleague", "bash", { command: "ls; rm x" }), false);
  assert.equal(ruleAllows([rule("docs/*", { tool: "write" })], "colleague", "write", { path: "docs/a.md", content: "x" }), true);
  assert.equal(ruleAllows([rule("*shared*", { tool: "other_tool" })], "colleague", "other_tool", { paths: ["a"], note: "shared" }), true, "a tool of another name keeps its arguments' JSON");

  // As the guard asks it, with the rules in the portal's own table: the call goes through for the pictures the rule allows and is refused for the rest.
  const added = [{ id: "issue90-a", pattern: "shared/*" }];
  for (const r of added) addToolRule({ id: r.id, role: "colleague", tool: "edit_image", pattern: r.pattern, note: "", person_key: null });
  try {
    assert.equal(listToolRules().filter((r) => r.id === "issue90-a").length, 1);
    let handler: ((event: any) => any) | undefined;
    guardExtension("/tmp/none", () => ({ role: "colleague" }), "chat-issue90", undefined, undefined, undefined, undefined, undefined, undefined, filesOf)({ on: (name: string, fn: (event: any) => any) => { if (name === "tool_call") handler = fn; } });
    const asked = (input: Record<string, unknown>) => handler!({ toolName: "edit_image", input });
    assert.equal(asked({ paths: ["shared/a.png", "shared/b.png"], prompt: "p" }), undefined, "allowed");
    assert.equal(asked({ paths: ["shared/a.png"], prompt: "like shared/x" }), undefined);
    assert.equal(asked({ paths: ["private.png"], prompt: "like shared/x" })?.block, true, "refused: the prompt is not a rule's business");
    assert.equal(asked({ paths: ["shared/a.png", "private.png"], prompt: "p" })?.block, true);
  } finally {
    for (const r of added) deleteToolRule(r.id);
  }
});

test("a colleague's edit_image call can be approved once or always, with the action the guard asks for, in either shape of the tool", async () => {
  const { guardExtension, callSubject, rulePatterns } = await import("../core/server/src/pi/guard.ts");
  const { deleteToolRule, listToolRules, rememberTools, remembered } = await import("../core/server/src/db.ts");
  // As a chat reports it: what an answer outside the chat writes its rules by.
  rememberTools([remembered({ name: "edit_image", source: "my-pictures", inline: true, approvalFiles: EDIT_FILES })]);
  const { askQuestion, readAnswer } = await import("../core/server/src/questions.ts");
  const { recordApproval } = await import("../core/server/src/approvals.ts");

  // What the guard calls a call: the path, or the path of each picture, one to a line, never the prompt.
  assert.equal(callSubject("edit_image", { path: "shared/a.png", prompt: "p" }, EDIT_FILES), "shared/a.png", "as it was");
  assert.equal(callSubject("edit_image", { paths: ["shared/a.png"], prompt: "p" }, EDIT_FILES), "shared/a.png", "a list of one is its picture");
  assert.equal(callSubject("edit_image", { paths: ["shared/a.png", " shared/b.jpg "], prompt: "other" }, EDIT_FILES), "shared/a.png\nshared/b.jpg");
  assert.equal(callSubject("edit_image", { prompt: "p" }, EDIT_FILES), JSON.stringify({ prompt: "p" }), "a call that names nothing is shown as it is");
  assert.equal(callSubject("bash", { command: " ls " }), "ls");
  assert.equal(callSubject("write", { path: "docs/a.md" }), "docs/a.md");
  assert.deepEqual(rulePatterns("shared/a.png\n shared/b.jpg \n", true), ["shared/a.png", "shared/b.jpg"], "one rule for each picture");
  assert.deepEqual(rulePatterns("Summer, 2026.png", true), ["Summer, 2026.png"], "a comma is part of a name");
  assert.deepEqual(rulePatterns("ls\nmore", false), ["ls\nmore"], "other tools' actions are one pattern as they were");

  const session = "chat-issue90-approval";
  const person = { role: "colleague", key: "priya" };
  let handler: ((event: any) => any) | undefined;
  let who: { role: string; key?: string } = person;
  guardExtension("/tmp/none", () => who, session, undefined, undefined, undefined, undefined, undefined, undefined, filesOf)({ on: (name: string, fn: (event: any) => any) => { if (name === "tool_call") handler = fn; } });
  const call = (input: Record<string, unknown>) => handler!({ toolName: "edit_image", input });
  /** What the agent does with a refusal: asks with the action it names, as ask_primary files it, and the primary answers. */
  const approve = (refused: any, answer: string) => {
    assert.equal(refused?.block, true);
    assert.match(refused.reason, /actionTool is edit_image/);
    const action = refused.reason.split("exactly:\n")[1].trim();
    const row = askQuestion({ sessionId: session, personKey: "priya", personName: "Priya", channelSlug: "chat", channelKey: "k", question: "may I?", actionTool: "edit_image", action });
    const pending = readAnswer(`#${row.id} ${answer}`)!;
    recordApproval(pending.question, { id: session }, pending.approves, pending.always);
    return action;
  };
  try {
    // Once, for several pictures: refused, told what to ask for, approved, then it runs, and only once.
    const several = { paths: ["shared/logo.png", "Summer, banner.png"], prompt: "put the logo on the banner" };
    assert.equal(approve(call(several), "approve"), "shared/logo.png\nSummer, banner.png");
    assert.equal(call({ ...several, prompt: "another words" }), undefined, "it is the pictures that were approved");
    assert.equal(call(several)?.block, true, "and once");
    assert.equal(call({ paths: ["shared/logo.png"], prompt: "p" })?.block, true, "not for fewer or other pictures");

    // The path the agent would write for one picture works for a list of one, as for the tool's other shape.
    const row = askQuestion({ sessionId: session, personKey: "priya", personName: "Priya", channelSlug: "chat", channelKey: "k", question: "may I?", actionTool: "edit_image", action: "shared/a.png" });
    recordApproval(readAnswer(`#${row.id} approve`)!.question, { id: session }, true, false);
    assert.equal(call({ paths: ["shared/a.png"], prompt: "p" }), undefined);
    const again = askQuestion({ sessionId: session, personKey: "priya", personName: "Priya", channelSlug: "chat", channelKey: "k", question: "may I?", actionTool: "edit_image", action: "shared/a.png" });
    recordApproval(readAnswer(`#${again.id} approve`)!.question, { id: session }, true, false);
    assert.equal(call({ path: "shared/a.png", prompt: "p" }), undefined, "and for one path");

    // Always: one rule for each picture, for her alone, which lets the same call through every time and nothing else.
    approve(call(several), "always");
    const made = listToolRules().filter((r) => r.tool === "edit_image" && r.person_key === "priya");
    assert.deepEqual(made.map((r) => r.pattern).sort(), ["Summer, banner.png", "shared/logo.png"], "a rule that held both would match neither");
    assert.equal(call(several), undefined);
    assert.equal(call(several), undefined, "not spent");
    assert.equal(call({ paths: ["Summer, banner.png"], prompt: "p" }), undefined, "each picture is allowed on its own now");
    assert.equal(call({ paths: ["shared/logo.png", "private.png"], prompt: "p" })?.block, true, "a picture that was not approved is not");
    // "Always" is also an approval of the call once, which her rules did not need and left open for this conversation: spent here.
    who = { role: "colleague", key: "sam" };
    assert.equal(call(several), undefined, "the one-off approval is the conversation's, whoever speaks");
    assert.equal(call(several)?.block, true, "the rules are Priya's alone");
  } finally {
    for (const r of listToolRules().filter((rule) => rule.tool === "edit_image")) deleteToolRule(r.id);
  }
});

test("only a tool that declares its files is approved on them: a command, a tool server and any other call are approved whole, whatever they carry", async () => {
  const { declaredFiles, callSubject, ruleAllows, approvalCannotHelp } = await import("../core/server/src/pi/guard.ts");
  const params = (properties: Record<string, unknown>) => ({ type: "object", properties });
  const text = { type: "string" }, list = { type: "array", items: { type: "string" } };
  // What a definition may declare: parameters it has, as text or a list of text; a name of another shape of it besides.
  assert.deepEqual(declaredFiles({ name: "edit_image", approvalFiles: ["path", "paths"], parameters: params({ paths: list, prompt: text }) }), ["path", "paths"]);
  assert.deepEqual(declaredFiles({ name: "merge_pdfs", approvalFiles: ["inputs"], parameters: params({ inputs: list, title: text }) }), ["inputs"]);
  assert.equal(declaredFiles({ name: "merge_pdfs", approvalFiles: ["count"], parameters: params({ count: { type: "number" } }) }), undefined, "no file is a number");
  assert.equal(declaredFiles({ name: "merge_pdfs", approvalFiles: ["nowhere"], parameters: params({ inputs: list }) }), undefined, "none of its own");
  assert.equal(declaredFiles({ name: "merge_pdfs", approvalFiles: [], parameters: params({ inputs: list }) }), undefined);
  assert.equal(declaredFiles({ name: "merge_pdfs", parameters: params({ paths: list }) }), undefined, "a list is no declaration");
  for (const name of ["bash", "mcp", "mcp_script", "mcpScript", "codemode", "tools"]) {
    assert.equal(declaredFiles({ name, approvalFiles: ["paths"], parameters: params({ paths: list }) }), undefined, name);
  }
  // Undeclared, a call is matched and shown whole: an extra list is part of its arguments, and the command is the command.
  const rule = (tool: string, pattern: string) => ({ id: `r-${tool}`, role: "colleague", tool, pattern, note: "", created_at: "", person_key: null }) as Parameters<typeof ruleAllows>[0][number];
  assert.equal(callSubject("bash", { command: "rm -rf ~", paths: ["shared/x"] }), "rm -rf ~");
  assert.equal(ruleAllows([rule("bash", "shared/*")], "colleague", "bash", { command: "rm -rf ~", paths: ["shared/x"] }), false);
  const send = { to: "anyone@example.com", body: "the secrets", paths: ["shared/report.pdf"] };
  assert.equal(callSubject("send_mail", send), JSON.stringify(send));
  assert.equal(ruleAllows([rule("send_mail", "shared/*")], "colleague", "send_mail", send), false, "a rule for a folder does not reach a mail with an attachment in it");
  assert.equal(ruleAllows([rule("mcp", "shared/*")], "colleague", "mcp", { tool: "notes_delete", paths: ["shared/x"] }), false);
  // Declared, each file is a subject: every one must be allowed.
  const pdfs = [rule("merge_pdfs", "shared/*")];
  assert.equal(ruleAllows(pdfs, "colleague", "merge_pdfs", { inputs: ["shared/a.pdf", "shared/b.pdf"], title: "x" }, undefined, undefined, ["inputs"]), true);
  assert.equal(ruleAllows(pdfs, "colleague", "merge_pdfs", { inputs: ["shared/a.pdf", "private.pdf"] }, undefined, undefined, ["inputs"]), false);
  // A read is never asked for, a line or several; a tool that declares its files is asked for them.
  assert.match(approvalCannotHelp("read", "/etc/hosts\n/etc/passwd", undefined)!, /it is a read/);
  assert.equal(approvalCannotHelp("edit_image", "shared/a.png\nshared/b.png", undefined, undefined, EDIT_FILES), undefined);
});
