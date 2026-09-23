import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
type DockerCommand = (args: string[]) => Promise<string>;
const docker: DockerCommand = async (args) => (await exec('docker', args)).stdout;

/** Reclaim an old session name without killing a live or unrelated container. */
export async function removeStoppedRunner(sessionId: string, run: DockerCommand = docker): Promise<void> {
  const name = `pithagoras-${sessionId}`;
  let output: string;
  try {
    output = await run(['container', 'inspect', name]);
  } catch (error) {
    const stderr = (error as {stderr?: string}).stderr ?? '';
    if (/No such (?:object|container):/i.test(stderr)) return;
    throw error;
  }
  const [container] = JSON.parse(output);
  const labels = container?.Config?.Labels;
  if (labels?.['pithagoras.managed'] !== 'true' || labels?.['pithagoras.session'] !== sessionId) {
    throw new Error(`Container ${name} is not owned by this session; remove or rename it manually.`);
  }
  if (!['created', 'exited', 'dead'].includes(container.State?.Status)) {
    throw new Error(`Container ${name} is still active; wait for it to stop before resuming.`);
  }
  // Use the inspected ID, never force removal: a container that starts between
  // inspect and rm remains protected by Docker's running-container check.
  await run(['container', 'rm', container.Id]);
}
