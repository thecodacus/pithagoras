import { lazy, type ComponentType } from "react";

/**
 * A part of the portal whose code could not be fetched: the file is gone, as it
 * is after an update that this page was opened before. Told apart from a part
 * that threw while drawing, because trying again cannot help — React keeps the
 * rejected import, and only a reload fetches it afresh.
 */
export class ChunkLoadFailed extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ChunkLoadFailed";
  }
}

/**
 * A component fetched when it is first drawn, from a module that exports it by
 * name: `lazyComponent(() => import("./components/Page"), "Page")`. Without
 * this the page, and everything only it uses, is part of the file that has to
 * be fetched and read before anything is drawn.
 */
export function lazyComponent<M extends Record<K, ComponentType<any>>, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(async () => {
    let module: M;
    try {
      module = await load();
    } catch (e) {
      throw new ChunkLoadFailed(e);
    }
    return { default: module[name] };
  });
}
