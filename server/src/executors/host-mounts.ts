import path from 'node:path';
export interface DockerMount { Type: string; Source: string; Destination: string; }

/** Translate a portal path using the daemon's actual bind/volume mount sources. */
export function hostMountPath(containerPath: string, mounts: DockerMount[]): string {
  const resolved = path.resolve(containerPath);
  const candidates = mounts.filter(m => ['bind', 'volume'].includes(m.Type) && path.isAbsolute(m.Source))
    .sort((a, b) => b.Destination.length - a.Destination.length);
  for (const mount of candidates) {
    const relative = path.relative(mount.Destination, resolved);
    if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
      return path.join(mount.Source, relative);
    }
  }
  throw new Error(`Executor path ${resolved} is not backed by a portal bind mount or named volume`);
}
