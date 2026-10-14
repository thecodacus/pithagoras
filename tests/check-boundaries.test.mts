import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findCrossings } from '../scripts/check-boundaries.mjs';
import { scratch } from './helpers.mts';

/** A repository with these files in it. */
function repo(files: Record<string, string>) {
  const root = scratch('boundaries-');
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
}

test('core and the extensions may each use the contract between them, npm packages, and their own files', () => {
  const root = repo({
    'web/src/extensions/loader.ts': 'import type { Portal } from "@pithagoras/extension-api";\nimport { register } from "./slots";\nimport * as React from "react";',
    'web/src/extensions/slots.ts': 'export const register = 1;',
    'server/src/extensions/browser-service.ts': 'import { x } from "../db.js";',
    'server/src/api/extensions.ts': 'import { start } from "../extensions/browser-service.js";',
    'extensions/terminal/src/client.tsx': 'import { useState } from "react";\nimport type { Portal } from "@pithagoras/extension-api";\nimport { Shell } from "./shell";\nconst xterm = () => import("@xterm/xterm");',
    'extensions/terminal/src/shell.tsx': 'export const Shell = 1;',
    'extensions/terminal/server.js': 'import { spawn } from "node:child_process";',
  });
  assert.deepEqual(findCrossings(root), []);
});

test('core importing an extension, or an extension importing core, is found, by path or by package name, in every form of import', () => {
  const root = repo({
    'web/src/components/Chat.tsx': 'import { Terminal } from "../../../extensions/terminal/src/client";',
    'server/src/server.ts': 'const half = await import("../../extensions/terminal/server.js");',
    'extensions/terminal/src/client.tsx': 'import { api } from "../../../web/src/api";\nexport { stripAnsi } from "../../../web/src/transcript";',
    'extensions/terminal/server.js': 'const db = require("../../server/src/db.js");\nimport "@pithagoras/server/dist/db.js";',
  });
  assert.deepEqual(findCrossings(root).sort(), [
    'extensions/terminal/server.js:1 imports "../../server/src/db.js": an extension imports nothing of core',
    'extensions/terminal/server.js:2 imports "@pithagoras/server/dist/db.js": an extension imports nothing of core',
    'extensions/terminal/src/client.tsx:1 imports "../../../web/src/api": an extension imports nothing of core',
    'extensions/terminal/src/client.tsx:2 imports "../../../web/src/transcript": an extension imports nothing of core',
    'server/src/server.ts:1 imports "../../extensions/terminal/server.js": core imports nothing from extensions/',
    'web/src/components/Chat.tsx:1 imports "../../../extensions/terminal/src/client": core imports nothing from extensions/',
  ]);
});

test('what an extension built and what it installed are not read', () => {
  const root = repo({
    'extensions/docs/node_modules/x/index.js': 'require("../../../../server/src/db.js");',
    'extensions/terminal/web/chunks/xterm-1.js': 'import "../../../../web/src/api";',
  });
  assert.deepEqual(findCrossings(root), []);
});

test('this repository keeps them apart', () => {
  assert.deepEqual(findCrossings(path.resolve(import.meta.dirname, '..')), []);
});
