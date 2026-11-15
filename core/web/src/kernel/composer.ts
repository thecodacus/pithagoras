import type { PiCommand, PromptOptions, api as realApi } from "../api";
import { sortFiles, uploadedNote, type Attachment, type createPending } from "../attachments";
import type { createDrafts } from "../drafts";
import { withUnsent } from "../drafts";
import type { ChatController } from "./chats";
import { createStore } from "./store";

/**
 * What a person is writing in a chat, and has put with it: the words (kept per chat, so that what was half written in
 * one does not follow them into the next, nor get lost when the page reloads), the pictures waiting to go with the
 * next message, and the slash commands the chat has. The kernel owns them, so that changing the interface in the middle
 * of a message loses nothing typed; the pictures are in memory only, and the dialog that switches names them.
 */
export interface ComposerState {
  draft: string;
  attachments: readonly Attachment[];
  /** Pictures being read or files being uploaded: a message waits for them. */
  adding: number;
  /** The commands the chat has, once asked for (see `loadCommands`). */
  commands: readonly PiCommand[];
  /** A message is on its way. */
  sending: boolean;
}

export type ComposerApi = Pick<typeof realApi, "commands" | "uploadFile">;

export interface ComposerDeps {
  api: ComposerApi;
  drafts: ReturnType<typeof createDrafts>;
  pending: ReturnType<typeof createPending>;
  /** Makes a picture ready to go (attachments.ts `prepareImage`, which needs the browser's canvas) unless a test gives its own. */
  prepare?: (file: File) => Promise<Attachment>;
  /** A chat's actions: what a message is sent with. */
  chat: (id: string) => Pick<ChatController, "send">;
}

const EMPTY: ComposerState = { draft: "", attachments: [], adding: 0, commands: [], sending: false };

export function createComposer(deps: ComposerDeps) {
  const { api, drafts, pending } = deps;
  /** What is held per chat beyond the draft and the pictures, which `drafts` and `pending` keep. */
  const extra = new Map<string, { adding: number; commands: readonly PiCommand[]; sending: boolean }>();
  const store = createStore<Readonly<Record<string, ComposerState>>>({});

  const stateOf = (id: string): ComposerState => {
    const more = extra.get(id);
    return { draft: drafts.get(id), attachments: pending.get(id), adding: more?.adding ?? 0, commands: more?.commands ?? [], sending: more?.sending ?? false };
  };
  /** Puts the chat's state, as `drafts`, `pending` and what is held here have it, where readers see it. */
  const publish = (id: string) =>
    store.update((all) => {
      const now = stateOf(id);
      const was = all[id];
      if (was && was.draft === now.draft && was.attachments === now.attachments && was.adding === now.adding && was.commands === now.commands && was.sending === now.sending) return all;
      return { ...all, [id]: now };
    });
  const hold = (id: string, change: Partial<{ adding: number; commands: readonly PiCommand[]; sending: boolean }>) => {
    extra.set(id, { adding: 0, commands: [], sending: false, ...extra.get(id), ...change });
    publish(id);
  };
  // Voice mode adds to and takes from the same pictures: what it does is seen here.
  pending.subscribe((id) => publish(id));

  /** The chat's state; nothing for one nobody has written in. */
  const get = (id: string): ComposerState => store.get()[id] ?? (drafts.get(id) || pending.get(id).length ? stateOf(id) : EMPTY);

  /** Which `commands` list is for what: fetched once per chat and `key`, which changes after each run (it may install an extension). */
  const listed = new Map<string, { key: string; list: Promise<PiCommand[]> }>();

  const canSubmit = (id: string): boolean => {
    const s = get(id);
    return (Boolean(s.draft.trim()) || s.attachments.length > 0) && !s.sending && s.adding === 0;
  };

  return {
    store,
    get,
    setDraft(id: string, text: string): void {
      drafts.set(id, text);
      publish(id);
    },
    /**
     * Pictures and files pasted, dropped or picked. Pictures wait with the message; anything else is put in the chat's
     * folder at once and the draft says so, so the agent knows to look. What went wrong is returned, to be shown.
     */
    async attach(id: string, files: readonly File[]): Promise<string[]> {
      if (!files.length) return [];
      const { images, others } = sortFiles(files);
      hold(id, { adding: (extra.get(id)?.adding ?? 0) + 1 });
      const problems: string[] = [];
      try {
        problems.push(...(await pending.add(id, images, deps.prepare)));
        const uploaded: string[] = [];
        for (const file of others) {
          try {
            uploaded.push((await api.uploadFile(id, "", file)).path);
          } catch (e) {
            problems.push((e as Error).message);
          }
        }
        const note = uploadedNote(uploaded);
        if (note) {
          const text = drafts.get(id);
          drafts.set(id, text.trim() ? `${text.trimEnd()}\n${note}` : note);
        }
      } finally {
        hold(id, { adding: Math.max(0, (extra.get(id)?.adding ?? 1) - 1) });
      }
      return problems;
    },
    /** Takes a picture out of the box. */
    detach(id: string, attachment: string): void {
      pending.set(id, pending.get(id).filter((a) => a.id !== attachment));
    },
    /**
     * The commands the chat has, fetched once for `key` (the chat's turn count, say: a run can install an extension,
     * whose commands should then be offered). Asked for only when wanted: listing them starts pi for the chat, and it stays up.
     */
    loadCommands(id: string, key = ""): Promise<readonly PiCommand[]> {
      const was = listed.get(id);
      let list = was?.list;
      if (!was || was.key !== key) {
        list = api.commands(id).then((r) => r.commands, () => [] as PiCommand[]);
        listed.set(id, { key, list });
      }
      return list!.then((found) => {
        if (listed.get(id)?.key === key) hold(id, { commands: found });
        return found;
      });
    },
    canSubmit,
    /**
     * Sends what is in the box, with its pictures. The box is emptied at once; a message that did not go is put
     * back in front of whatever was typed since (not over it), with its pictures, and the failure is thrown. False
     * where there was nothing to send.
     */
    async submit(id: string, options?: Pick<PromptOptions, "voice" | "steer">): Promise<boolean> {
      if (!canSubmit(id)) return false;
      const message = drafts.get(id).trim();
      const images = pending.get(id);
      drafts.set(id, "");
      pending.set(id, []);
      hold(id, { sending: true });
      try {
        await deps.chat(id).send(message, {
          ...(options?.voice ? { voice: true } : {}),
          ...(options?.steer ? { steer: true } : {}),
          ...(images.length ? { images: [...images] } : {}),
        });
        return true;
      } catch (e) {
        if (message) drafts.set(id, withUnsent(drafts.get(id), message));
        if (images.length) pending.set(id, [...images, ...pending.get(id)]);
        publish(id);
        throw e;
      } finally {
        hold(id, { sending: false });
      }
    },
  };
}

export type Composer = ReturnType<typeof createComposer>;
