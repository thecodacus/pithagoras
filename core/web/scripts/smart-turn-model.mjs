import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Smart Turn v3.2 (web/src/smart-turn.ts) is not published on npm: it comes
 * from its model repository, at a fixed revision, and is checked against the
 * hash it had there. It is downloaded once; a copy that is already in place
 * with that hash is kept.
 */
export const SMART_TURN = {
  file: 'smart-turn-v3.2-cpu.onnx',
  url: 'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx',
  sha256: '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f',
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The model in `dir`, downloaded there if it is not; answers with its path. */
export async function downloadSmartTurn(dir) {
  const path = resolve(dir, SMART_TURN.file);
  const kept = await readFile(path).catch(() => null);
  if (kept && sha256(kept) === SMART_TURN.sha256) return path;
  // A stalled connection fails the build with this error rather than holding it up for good.
  const response = await fetch(SMART_TURN.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Could not download ${SMART_TURN.file}: ${response.status} from ${SMART_TURN.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== SMART_TURN.sha256) throw new Error(`${SMART_TURN.file} from ${SMART_TURN.url} is not the file that was checked`);
  // Written beside it and moved into place, so that a build or test running at the same time never reads half of it.
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, path);
  return path;
}
