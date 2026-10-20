/**
 * Media's settings saved a change to what the portal makes: the sidebar's
 * entry and the Media page ask the server half again how things stand, so
 * that they follow at once.
 */
const listeners = new Set<() => void>();

/** Says it, to everything that listens. */
export function mediaChanged(): void {
  for (const listener of listeners) listener();
}

/** Listens; returns what stops it. */
export function onMediaChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
