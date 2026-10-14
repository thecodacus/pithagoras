import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_COMMANDS, isClientCommand, isCommand } from "../core/web/src/client-commands.ts";
import { getBuiltinCommands } from "../core/server/src/pi/builtins.ts";

test("the page knows the same UI commands the server lists", async () => {
  const server = (await getBuiltinCommands()).filter((c) => c.where === "client").map((c) => c.name);
  assert.deepEqual([...CLIENT_COMMANDS].sort(), server.sort());
});

test("once listed, the server's word decides where a command runs", () => {
  const listed = [
    { name: "model", source: "builtin", where: "server" as const },
    { name: "later", source: "builtin", where: "client" as const },
  ];
  assert.equal(isClientCommand("model", listed), false);
  assert.equal(isClientCommand("later", listed), true);
  // Not listed yet: the page's own list.
  assert.equal(isClientCommand("settings", []), true);
  assert.equal(isClientCommand("compact", []), false);
  // An extension of the same name is not the builtin.
  assert.equal(isClientCommand("clear", [{ name: "clear", source: "extension" }]), true);
});

test("a command of any kind is told from a message that starts with a slash", () => {
  const listed = [{ name: "skill:foo", source: "skill" }, { name: "compact", source: "builtin", where: "server" as const }];
  assert.equal(isCommand("skill:foo", listed), true);
  assert.equal(isCommand("compact", listed), true);
  assert.equal(isCommand("new", []), true);
  assert.equal(isCommand("etc", listed), false);
});
