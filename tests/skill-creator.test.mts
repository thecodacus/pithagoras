import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skillsLine } from "../server/src/agent-skills.js";

// The built-in skill-creator tells the agent where to write a skill: the agent's own skills folder, which the
// portal names in its instructions and hands to pi as a skill path. Under the sandbox the agent's HOME is one of
// its own, so a path under $HOME/.pi/agent, or pi's own folder, is a skill that never loads.
const dir = path.join(import.meta.dirname, "..", "skills", "skill-creator");
const files = ["SKILL.md", "reference/frontmatter.md"].map((file) => readFileSync(path.join(dir, file), "utf8"));
const FOLDER = "<your skills folder>";

test("the skill sends the agent to the skills folder its instructions name, by the words they name it with", () => {
  const opening = skillsLine({ home: "/data/agents/scout" }).match(/^(Your own skills are in)/)?.[1];
  assert.ok(opening);
  assert.ok(files[0].includes(`"${opening}"`));
  assert.ok(files.join("\n").includes(`mkdir -p "${FOLDER}/<skill-name>"`));
});

test("every command it gives writes into that folder, and pi's own folder is only named as one that is not loaded", () => {
  const commands = files.join("\n").match(/^(?:mkdir -p|cat|head -5) "[^\n]*$/gm) ?? [];
  assert.equal(commands.length, 3);
  for (const command of commands) assert.ok(command.includes(`"${FOLDER}/`), command);
  assert.equal(files.join("\n").includes("PI_CODING_AGENT_DIR"), false);
  // Sentence by sentence, as they wrap across lines.
  for (const sentence of files.join("\n").replace(/\s+/g, " ").split(/(?<=\.) /).filter((s) => s.includes(".pi/agent"))) {
    assert.match(sentence, /is not loaded/, sentence);
  }
});
