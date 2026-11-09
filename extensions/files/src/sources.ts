import type { ChatOwner, RequestPerson } from "@pithagoras/extension-api/server";

/**
 * Where other extensions put their own file trees in Files: a Nextcloud, a
 * bucket, a wiki. Each is a source Files shows as a root of its own beside the
 * chat's folder, with the same file view. This is the half that gives the hook
 * (`portal.provide`) and keeps what is registered; src/server.ts serves it.
 *
 * A source's paths are its own. They are never read against the chat's folder,
 * and the chat's folder is never handed to a source.
 */

/** What every call to a source is told about who asks: the chat the panel is open on, whose it is, and the person at the page. Never the chat's folder. */
export interface SourceContext {
  chatId: string;
  /** Whose the chat is: an agent's or a project's (see `chats.owner`), without its `path`: where it is on this machine is not a source's to know. Nothing for a chat that is in neither. */
  owner?: Omit<ChatOwner, "path">;
  person?: RequestPerson;
}

/** One thing in a source's folder. A source has files and folders; there are no links. */
export interface SourceEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
  /** Milliseconds since the epoch. */
  mtime?: number;
}

/** A file's text (shown, and edited where the source can write), or its bytes (offered as a download). */
export type SourceFile = { content: string; mtime?: number } | { bytes: Uint8Array; mtime?: number };

export interface FilesSource {
  /** Letters, digits, `.`, `_` and `-`, at most 64, starting with a letter or digit: it is in an address. Unique among all sources. */
  id: string;
  /** The root's name on the tab beside the chat's folder. */
  label: string;
  /** Whether the person at the page sees this source in this chat: asked every time the list of sources is. Without it, everyone who can see the chat sees it. */
  visible?(context: SourceContext): boolean | Promise<boolean>;
  /** What is directly in the folder at `path` (`""` is the root), in the source's own paths. */
  list(path: string, context: SourceContext): SourceEntry[] | Promise<SourceEntry[]>;
  read(path: string, context: SourceContext): SourceFile | Promise<SourceFile>;
  /** A link to open or download the file with, `http:` or `https:`. Without it the file is sent through Files. */
  url?(path: string, context: SourceContext): string;
  /**
   * Saves a file's text. `expected` is the `mtime` it was read with, when it had one; refuse with an error whose `code` is
   * `"conflict"` if the file is not as that says. Without `write` the source is read-only: nothing in the page offers to change it.
   */
  write?(path: string, content: string, context: SourceContext & { expected?: number }): { mtime?: number } | void | Promise<{ mtime?: number } | void>;
}

/** What an extension that builds on Files is given (`portal.extensions.use("pithagoras-files")`). */
export interface FilesSources {
  sources: {
    /** Adds a source, or replaces the one of this extension with the same id. Throws a TypeError for one that is not shaped as above, or whose id another extension has. */
    register(source: FilesSource): void;
    /** Takes this extension's source `id` away again, for the stop function of its server half. Nothing for one it does not have. */
    unregister(id: string): void;
  };
}

/** A call to a source that was not answered in time. */
export class SourceTimeout extends Error {
  readonly code = "timeout";
}

/** `work`'s answer, or a SourceTimeout after `ms`: a source that never answers must not keep a request open for ever. */
export function answerWithin<T>(ms: number, work: () => T | Promise<T>, what: string): Promise<T> {
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => fail(new SourceTimeout(`${what} did not answer in time`)), ms);
    Promise.resolve()
      .then(work)
      .then(ok, fail)
      .finally(() => clearTimeout(timer));
  });
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function check(source: FilesSource): void {
  if (!source || typeof source !== "object") throw new TypeError("register takes a source: { id, label, list, read }");
  if (typeof source.id !== "string" || !ID.test(source.id)) throw new TypeError("A source's id is letters, digits, . _ and -, at most 64, starting with a letter or digit");
  if (typeof source.label !== "string" || !source.label.trim()) throw new TypeError("A source needs a label: the name its tab shows");
  for (const fn of ["list", "read"] as const) if (typeof source[fn] !== "function") throw new TypeError(`A source needs ${fn}()`);
  for (const fn of ["visible", "url", "write"] as const) if (source[fn] !== undefined && typeof source[fn] !== "function") throw new TypeError(`A source's ${fn} is a function, or left out`);
}

/** The sources registered, by id, each remembered by the extension that gave it. */
export class SourceRegistry {
  /** `visibleMs`: how long a source's `visible` has to answer; one that does not is not shown. */
  constructor(private readonly visibleMs = 5000) {}

  private readonly all = new Map<string, { source: FilesSource; by: string }>();

  /**
   * What the extension `by` is given. Asked for again (it was started anew), it starts from nothing: what it registered before is
   * gone, and it registers what it has now.
   */
  forConsumer(by: string): FilesSources {
    this.dropAll(by);
    return {
      sources: {
        register: (source) => {
          check(source);
          const taken = this.all.get(source.id);
          if (taken && taken.by !== by) throw new TypeError(`Another extension already has a source called "${source.id}"`);
          this.all.set(source.id, { source, by });
        },
        unregister: (id) => {
          if (this.all.get(id)?.by === by) this.all.delete(id);
        },
      },
    };
  }

  private dropAll(by: string): void {
    for (const [id, held] of this.all) if (held.by === by) this.all.delete(id);
  }

  /** The source by its id, if the person may see it in this chat (a `visible` that throws counts as no). */
  async get(id: string, context: SourceContext): Promise<FilesSource | undefined> {
    const held = this.all.get(id);
    if (!held) return undefined;
    return (await this.sees(held.source, context)) ? held.source : undefined;
  }

  /** The sources the person sees in this chat, in the order they were registered. */
  async list(context: SourceContext): Promise<FilesSource[]> {
    const seen = await Promise.all([...this.all.values()].map(({ source }) => this.sees(source, context)));
    return [...this.all.values()].map(({ source }) => source).filter((_, i) => seen[i]);
  }

  private async sees(source: FilesSource, context: SourceContext): Promise<boolean> {
    if (!source.visible) return true;
    try {
      return (await answerWithin(this.visibleMs, () => source.visible!(context), source.label)) === true;
    } catch (e) {
      console.error(`[files] source ${source.id}: visible() failed:`, (e as Error)?.message ?? e);
      return false;
    }
  }
}
