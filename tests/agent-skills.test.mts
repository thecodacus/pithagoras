import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentSkillsDir, listAgentSkills, readAgentSkill, skillFrontmatter, skillsLine } from '../server/src/agent-skills.js';

const home = mkdtempSync(path.join(tmpdir(), 'agent-skills-'));
const agent = { home };
const skill = (id: string, text: string, extra: Record<string, string> = {}, at?: number) => {
  const dir = path.join(agentSkillsDir(agent), id);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  writeFileSync(file, text);
  for (const [name, body] of Object.entries(extra)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  if (at) utimesSync(file, at / 1000, at / 1000);
};

test('an agent with no skills folder has none, and is told where they go', () => {
  assert.deepEqual(listAgentSkills({ home: path.join(home, 'nobody') }), []);
  assert.match(skillsLine(agent), new RegExp(`${agentSkillsDir(agent)}.*SKILL\\.md`));
  // The words the skill-creator skill tells the agent to look for.
  assert.ok(skillsLine(agent).startsWith('Your own skills are in '));
  assert.match(readFileSync(path.join(import.meta.dirname, '../skills/skill-creator/SKILL.md'), 'utf8'), /"Your own skills are in"/);
});

test("an agent's skills are listed from their SKILL.md, newest first, with the files beside them", () => {
  skill('board', '---\nname: Video board\ndescription: "Read the ClickUp board and say what is late"\n---\n# Steps\nRun clickup-board.\n', { 'scripts/check.sh': 'echo hi' }, Date.now() - 60_000);
  skill('reply', '# No frontmatter\nAnswer comments.\n', {}, Date.now());
  mkdirSync(path.join(agentSkillsDir(agent), 'half-made'), { recursive: true });
  const skills = listAgentSkills(agent);
  assert.deepEqual(skills.map((s) => s.id), ['reply', 'board'], 'newest first, and a folder without SKILL.md is not one');
  assert.equal(skills[1].name, 'Video board');
  assert.equal(skills[1].description, 'Read the ClickUp board and say what is late');
  assert.deepEqual(skills[1].files, [path.join('scripts', 'check.sh')]);
  assert.equal(skills[0].name, 'reply', 'its folder name, without frontmatter');
  assert.match(readAgentSkill(agent, 'board') ?? '', /Run clickup-board/);
});

test('a skill is read only by its own id: nothing outside the folder', () => {
  assert.equal(readAgentSkill(agent, '../../etc'), null);
  assert.equal(readAgentSkill(agent, 'missing'), null);
  assert.deepEqual(skillFrontmatter('no block'), {});
});
