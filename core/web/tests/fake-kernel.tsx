// Development-only: the kernel's stores for a fixture page, with the chat's stream and what is done in it standing in for the server.
//
// The chat view reads the chat's events from the kernel's chats store and acts through its controller (kernel/), so a
// fixture does not hand it props any more: it gives the page a fake kernel and puts the chat's state in it. Everything
// else the chat reads (the composer, the models, the media addresses) is the page's own, over `fetch`, which the
// fixture answers with `mockFetch`.
import type { ReactNode } from 'react';
import { api, type PortalEvent } from '../src/api';
import { pending } from '../src/attachments';
import { confirmDialog } from '../src/components/ConfirmDialog';
import { drafts } from '../src/drafts';
import { createChats, LOADING, type ChatController, type ChatState } from '../src/kernel/chats';
import { createComposer } from '../src/kernel/composer';
import { KernelProvider, pageKernel, type Kernel } from '../src/kernel/context';
import type { Store } from '../src/kernel/store';

/** A store whose value can also be put without anyone being told: for a state a parent sets as it draws the chat. */
function fakeStore(initial: ChatState): Store<ChatState> & { seed(next: ChatState): void } {
  let state = initial;
  const listeners = new Set<() => void>();
  const store = {
    get: () => state,
    set(next: ChatState) {
      if (Object.is(next, state)) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    update: (change: (prev: ChatState) => ChatState) => store.set(change(state)),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    seed(next: ChatState) {
      state = next;
    },
  };
  return store;
}

/** What a mutating call of the portal answers in a fixture, unless the fixture says otherwise: nothing was sent anywhere. */
const stubbed = async () => ({ ok: true as const });

export interface FakeKernelOptions {
  /** What the fixture's portal answers, over the real `api` (whose calls reach `fetch`, which the fixture mocks). */
  api?: Partial<typeof api>;
  /** What a chat's controller does in place of the kernel's: a send recorded, a stop that stops the fixture's run. */
  controller?: (id: string) => Partial<ChatController>;
}

export function createFakeKernel(options: FakeKernelOptions = {}) {
  const states = new Map<string, ReturnType<typeof fakeStore>>();
  const store = (id: string) => {
    let s = states.get(id);
    if (!s) states.set(id, (s = fakeStore(LOADING)));
    return s;
  };
  // The kernel's own controller over the fixture's answers, so that what it asks first (a message to delete, a result to
  // trust, a mode that asks) is asked here as it is in the page.
  const real = createChats({
    api: {
      ...api,
      prompt: stubbed,
      abort: stubbed,
      editMessage: stubbed,
      deleteMessage: stubbed,
      takeBackQueued: stubbed,
      sendQueuedNow: stubbed,
      renameSession: stubbed,
      setMode: stubbed,
      ...options.api,
    } as typeof api,
    ask: confirmDialog,
    open: () => {
      throw new Error('A fixture has no stream');
    },
    poll: () => () => {},
    frame: (run) => {
      run();
      return () => {};
    },
    sessions: { patchStatus: () => {}, refresh: async () => [] },
    fanOut: { serverPush: () => {}, extensionMessage: () => {}, fill: () => {}, onScreen: () => {} },
  });
  const controllers = new Map<string, ChatController>();
  const controller = (id: string): ChatController => {
    let c = controllers.get(id);
    if (!c) controllers.set(id, (c = { ...real.controller(id), ...options.controller?.(id) }));
    return c;
  };
  // A chat the fixture put events in is the fixture's. Any other (a child chat's run in a panel, which the fixture's own
  // page serves a stream for) is read from the page's own store, as in the app.
  const chats: Kernel['chats'] = {
    acquire: (id) => (states.has(id) ? () => {} : pageKernel.chats.acquire(id)),
    open: (id) => (states.has(id) ? () => {} : pageKernel.chats.open(id)),
    peek: (id) => (states.has(id) ? states.get(id)!.get() : pageKernel.chats.peek(id)),
    stateOf: (id) => states.get(id) ?? pageKernel.chats.stateOf(id),
    dismissDialog: (id, requestId) => store(id).update((s) => ({ ...s, dialogs: s.dialogs.filter((d) => d.id !== requestId) })),
    controller,
  };
  const kernel: Kernel = { ...pageKernel, chats, composer: createComposer({ api, drafts, pending, chat: controller }) };

  /** Puts what a chat's stream said into the store, and tells whoever reads it. */
  const set = (id: string, patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) =>
    store(id).update((s) => ({ ...s, ...(typeof patch === 'function' ? patch(s) : patch) }));
  return {
    kernel,
    set,
    /** The chat's conversation, as the drawing parent has it: put where the chat reads it as it is drawn, nobody told (the chat is drawn with it). */
    feed(id: string, events: PortalEvent[], more: Partial<ChatState> = {}) {
      const s = store(id);
      const was = s.get();
      const next = { ...was, events, loaded: true, ...more };
      if (was.events === next.events && was.loaded === next.loaded && was.versions === next.versions && was.moreBefore === next.moreBefore) return;
      s.seed(next);
    },
    /** More events, as a stream says them. */
    append(id: string, ...events: PortalEvent[]) {
      set(id, (s) => ({ events: [...s.events, ...events] }));
    },
    controller,
  };
}

export type FakeKernel = ReturnType<typeof createFakeKernel>;

/** The page a chat is drawn in: what is inside it reads the fake kernel's stores. */
export function WithKernel({ fake, children }: { fake: FakeKernel; children: ReactNode }) {
  return <KernelProvider kernel={fake.kernel}>{children}</KernelProvider>;
}
