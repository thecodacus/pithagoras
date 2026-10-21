import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestCommand, terminalRuns } from '../extensions/terminal/src/runs.ts';

test('the terminal extension opens on a command, not on a mention of one or another tool', () => {
  const events = [
    { seq: 1, type: 'message_update', payload: { text: 'bash' } },
    { seq: 2, type: 'tool_execution_start', payload: { toolName: 'bash', input: { command: 'echo browser' } } },
    { seq: 3, type: 'tool_execution_start', payload: { toolName: 'mcp', input: { tool: 'browser_navigate' } } },
  ];
  assert.equal(latestCommand(events.slice(0, 1)), 0);
  assert.equal(latestCommand(events), 2);
});
test('terminal follows cumulative streamed output and final tool errors by call id', () => {
  const events = [
    { seq: 1, type: 'tool_execution_start', payload: { toolName: 'bash', toolCallId: 'a', input: { command: 'npm test' } } },
    { seq: 2, type: 'tool_execution_update', payload: { toolCallId: 'a', partialResult: { content: [{ type: 'text', text: 'Starting' }] } } },
    { seq: 3, type: 'tool_execution_end', payload: { toolCallId: 'a', isError: true, result: { content: [{ type: 'text', text: 'Starting\nFailed' }] } } },
  ];
  assert.deepEqual(terminalRuns(events), [{ id: 'a', command: 'npm test', output: 'Starting\nFailed', running: false, error: true }]);
});

test('a shell tool called through MCP is a run, and one its run left open is settled, not spinning', () => {
  const events = [
    { seq: 1, type: 'tool_execution_start', payload: { toolName: 'mcp', toolCallId: 'm', input: { tool: 'shell', args: { command: 'ls' } } } },
    { seq: 2, type: 'tool_execution_start', payload: { toolName: 'bash', toolCallId: 'b', input: { command: 'sleep 99' } } },
    { seq: 3, type: 'tool_execution_end', payload: { toolName: 'mcp', toolCallId: 'm', result: { content: [{ type: 'text', text: 'a\nb' }] } } },
    { seq: 4, type: 'agent_end', payload: {} },
  ];
  assert.deepEqual(terminalRuns(events), [
    { id: 'm', command: 'ls', output: 'a\nb', running: false, error: false },
    { id: 'b', command: 'sleep 99', output: '', running: false, error: false, interrupted: true },
  ]);
  assert.equal(terminalRuns(events.slice(0, 2), 6, 20000, true)[1].interrupted, true, 'ended with no event to say so');
});

test('the pictures and a window that says nothing of its place take the side first, and the middle when the side is taken', async () => {
  const { placeWindows } = await import('../core/web/src/voice-windows.js');
  const none = { pictures: false };
  // The terminal's window, an extension's that asks for the side; the browser's, one that asks for the middle; and
  // Files', which does not say.
  const terminal = 'x:pithagoras-terminal/terminal' as const, browser = 'x:pithagoras-browser/browser' as const;
  const wants = { [terminal]: 'side' as const, [browser]: 'middle' as const };
  const files = 'x:pithagoras-files/files' as const;
  assert.deepEqual(placeWindows({ ...none, pictures: true }), { main: undefined, side: 'pictures' });
  assert.deepEqual(placeWindows({ ...none, [files]: true, [terminal]: true }, wants), { main: files, side: terminal });
  assert.deepEqual(placeWindows({ ...none, pictures: true, [browser]: true }, wants), { main: browser, side: 'pictures' });
  assert.deepEqual(placeWindows({ ...none, pictures: true, [files]: true }), { main: files, side: 'pictures' });
  assert.deepEqual(placeWindows({ ...none, [browser]: true, [terminal]: true }, wants), { main: browser, side: terminal });
  // The conversation is a window like them, not something drawn over them.
  assert.deepEqual(placeWindows({ ...none, conversation: true }), { main: undefined, side: 'conversation' });
  assert.deepEqual(placeWindows({ ...none, conversation: true, [terminal]: true }, wants), { main: 'conversation', side: terminal });
  assert.deepEqual(placeWindows({ ...none, conversation: true, pictures: true }), { main: 'pictures', side: 'conversation' });
});

test('the orb stands in the widest gap the windows leave, when it fits', async () => {
  const { freeStrip } = await import('../core/web/src/voice-windows.ts');
  const stage = { left: 100, right: 1100 };
  // Two windows with 400px between them: the orb goes in the middle of it.
  assert.deepEqual(freeStrip(stage, [{ left: 100, right: 400 }, { left: 800, right: 1100 }]), { center: 600, width: 400 });
  // One window at the right: the gap is everything to its left.
  assert.deepEqual(freeStrip(stage, [{ left: 600, right: 1100 }]), { center: 350, width: 500 });
  // Too narrow anywhere: back to the dock.
  assert.equal(freeStrip(stage, [{ left: 100, right: 600 }, { left: 700, right: 1100 }]), null);
  // Windows that overlap, or reach past the stage, are taken as they cover it.
  assert.deepEqual(freeStrip(stage, [{ left: 0, right: 300 }, { left: 250, right: 450 }, { left: 900, right: 1300 }]), { center: 675, width: 450 });
});

test('a window the orb comes back to its dock under is made to end above the dock', async () => {
  const { clearOfDock, dockBox } = await import('../core/web/src/voice-windows.ts');
  const size = { width: 520, height: 80, middle: 50, inset: 16 };
  const dock = dockBox({ left: 0, top: 0, right: 1000, bottom: 800 }, size);
  // 520px wide in the middle, its top 90px above the stage's bottom.
  assert.deepEqual(dock, { left: 240, right: 760, top: 710, bottom: 790 });
  assert.deepEqual(clearOfDock(dock, { left: 400, right: 980, top: 50, bottom: 790 }, 180, 0), { top: 50, height: 710 - 16 - 50 });
  assert.equal(clearOfDock(dock, { left: 400, right: 980, top: 50, bottom: 700 }, 180, 0), null, 'ends above it already, if closer than the gap');
  assert.equal(clearOfDock(dock, { left: 780, right: 980, top: 50, bottom: 790 }, 180, 0), null, 'beside the dock, not over it');
  // Too near the dock to be shortened enough: it moves up, as far as its area lets it.
  assert.deepEqual(clearOfDock(dock, { left: 400, right: 980, top: 610, bottom: 790 }, 180, 0), { top: 514, height: 180 });
  assert.deepEqual(clearOfDock(dock, { left: 400, right: 980, top: 610, bottom: 790 }, 180, 560), { top: 560, height: 180 });
  // On a narrow stage the dock is the stage less its inset either side; on a phone it sits higher.
  assert.deepEqual(dockBox({ left: 0, top: 0, right: 400, bottom: 800 }, { ...size, middle: 94 }), { left: 16, right: 384, top: 666, bottom: 746 });
});

test('a window dragged by a corner stops at a window off that corner, by the edge that gives up less', async () => {
  const { clear } = await import('../core/web/src/components/ResizeHandles.tsx');
  const a = { left: 0, top: 0, right: 300, bottom: 300 };
  const b = { left: 400, top: 420, right: 700, bottom: 700 };
  const overlaps = (x: typeof a, y: typeof a) => x.left < y.right && x.right > y.left && x.top < y.bottom && x.bottom > y.top;
  // Down and to the right, over B: the bottom has less to give up, and stops 16px above it.
  const got = clear(a, { ...a, right: 600, bottom: 600 }, 'se', [b]);
  assert.deepEqual(got, { ...a, right: 600, bottom: 404 });
  assert.ok(!overlaps(got, b));
  // Further right than down: the right edge stops instead.
  assert.deepEqual(clear(a, { ...a, right: 450, bottom: 650 }, 'se', [b]), { ...a, right: 384, bottom: 650 });
  // Beside or below alone, as before; and one it does not reach is no matter.
  assert.equal(clear(a, { ...a, right: 900 }, 'e', [{ left: 500, top: 100, right: 700, bottom: 200 }]).right, 484);
  assert.equal(clear(a, { ...a, bottom: 900 }, 's', [{ left: 100, top: 500, right: 200, bottom: 600 }]).bottom, 484);
  assert.deepEqual(clear(a, { ...a, right: 350 }, 'se', [b]), { ...a, right: 350 });
  // Closer than the gap already: pressing the edge does not throw it back, and it can still be pulled in.
  const near = { left: 310, top: 0, right: 500, bottom: 300 };
  assert.equal(clear(a, { ...a }, 'e', [near]).right, 300);
  assert.equal(clear(a, { ...a, right: 280 }, 'e', [near]).right, 280);
  // Ending 10px above the dock, to the dock's left: widened alongside it, over free space, it is not stopped.
  const dock = { left: 500, top: 310, right: 900, bottom: 390 };
  assert.equal(clear(a, { ...a, right: 700 }, 'e', [dock]).right, 700);
  // But grown down toward it, the bottom still stops GAP above it.
  assert.equal(clear(a, { ...a, right: 700, bottom: 380 }, 'se', [dock]).bottom, 300);
});
