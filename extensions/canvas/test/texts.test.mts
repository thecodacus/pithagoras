import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanvasTools } from '../src/tools.ts';
import { piDependency } from '../../../core/server/src/pi/package.ts';

/**
 * What the canvas tools cost in every request: their description, their schema and the line pi lists them by. Written
 * for a model that reads each token before it can answer, so a text that grows back fails here. The caps are the
 * lengths agreed for each (a quarter of a token to the character, as in the review of issue #183), with 10 for a
 * changed word.
 */
const tools: any[] = [];
new CanvasTools({} as any, 's', () => 'direct').register({ registerTool: (tool: any) => tools.push(tool) });
const tokens = (text: string) => Math.ceil(text.length / 4);
const cost = (tool: any) => tokens(tool.description) + tokens(JSON.stringify(tool.parameters)) + (tool.promptSnippet ? tokens(`- ${tool.name}: ${tool.promptSnippet}`) : 0);
const ROOM = 10;
const AGREED: Record<string, number> = { canvas_list: 21, canvas_create: 50, canvas_read: 59, canvas_write: 161, canvas_delete: 51 };

test('each canvas tool costs no more than was agreed', () => {
  assert.deepEqual(tools.map((tool) => tool.name).sort(), Object.keys(AGREED).sort());
  for (const tool of tools) assert.ok(cost(tool) <= AGREED[tool.name] + ROOM, `${tool.name} costs ${cost(tool)}, agreed ${AGREED[tool.name]}`);
  // What is said for spoken turns is said once for all of them, and only there.
  assert.ok(tools.every((tool) => tool.voiceGuidelines === tools[0].voiceGuidelines && !tool.promptGuidelines));
});

test('an operation outside its list is refused before canvas_write runs', async () => {
  const { validateToolArguments } = await piDependency('@earendil-works/pi-ai');
  const write = tools.find((tool) => tool.name === 'canvas_write');
  const check = (args: Record<string, unknown>) => validateToolArguments(write, { type: 'toolCall', id: '1', name: 'canvas_write', arguments: args });
  assert.equal(check({ canvas_id: 'c', revision: 1, operation: 'append', content: 'x' }).operation, 'append');
  assert.throws(() => check({ canvas_id: 'c', revision: 1, operation: 'prepend', content: 'x' }), /Validation failed/);
});
