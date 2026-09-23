/** Empty inherits; explicit invalid or zero values are errors, never silent defaults. */
export function executorLimits(env: NodeJS.ProcessEnv = process.env) {
  const read = (name: string, fallback: number, minimum: number, integer: boolean) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < minimum || (integer && !Number.isInteger(value))) {
      throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} >= ${minimum}; got ${JSON.stringify(raw)}`);
    }
    return value;
  };
  return {
    memoryMb: read('TASK_MEMORY_MB', 2048, 6, true),
    cpus: read('TASK_CPUS', 2, Number.MIN_VALUE, false),
    pidsLimit: read('TASK_PIDS_LIMIT', 512, 1, true),
  };
}
