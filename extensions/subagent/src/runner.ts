import type { Chat, ChildChatOptions, ChildRun } from "@pithagoras/extension-api/server";

/** What the tool needs of the portal's child chats (`portal.chats`): stood in for by the tests. */
export interface ChildChats {
  get(id: string): Chat | undefined;
  children(parent: string): Chat[];
  create(options: ChildChatOptions): Chat;
  prompt(id: string, message: string, options?: { steer?: boolean }): Promise<ChildRun>;
  abort(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Hears what a chat's pi says, as it says it (`portal.chats.onEvent`), until what it returns is called. */
export type Hear = (chatId: string, handler: (event: Record<string, unknown>) => void) => () => void;

export type Status = ChildRun["status"];

/**
 * A subagent at work: one task in its child chat, from the message that gives it to the end of the run that takes it
 * in. Its id is the chat's.
 */
export interface Runner {
  id: string;
  /** "running" until `finished` has settled, and then how it ended. */
  status(): "running" | Status;
  /** The last thing it said, so far. */
  answer(): string;
  /** A message for it while it works, taken in after the step it is on, as the person's would be in its chat. */
  send(text: string): void;
  /** Stops its run, as the person's Stop in its chat does. */
  stop(): void;
  /**
   * Settles once its run has ended, with what it said last; `failure` is why it failed, where it did, and `marked` is set
   * where it had read outside content that holds a chat back (`ChildRun.marked`). Never rejects.
   */
  finished: Promise<{ status: Status; answer: string; failure?: string; marked?: true }>;
}

const textOf = (message: any): string =>
  (Array.isArray(message?.content) ? message.content : []).filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("");

/**
 * Gives `task` to the child chat `id` and follows its run. `progress` is told what it has said and what it is doing as
 * its pi says it (heard through `hear`), for the card of the call that waits on it.
 */
export function startRunner(chats: ChildChats, id: string, task: string, hear?: Hear, progress?: (answer: string, phase: string) => void): Runner {
  let status: "running" | Status = "running";
  let answer = "";
  let steps = 0;
  const off = hear?.(id, (event: any) => {
    if (status !== "running") return;
    if (event?.type === "tool_execution_start") {
      steps++;
      progress?.(answer, `${event.toolName} (${steps} steps)`);
    }
    if (event?.type === "message_end" && event.message?.role === "assistant") {
      const text = textOf(event.message);
      if (text) answer = text;
      progress?.(answer, "thinking");
    }
  });
  const finished = (async () => {
    try {
      const run = await chats.prompt(id, task);
      if (run.answer) answer = run.answer;
      status = run.status;
      return { status: run.status, answer, ...(run.status === "error" ? { failure: run.error || "The run failed" } : {}), ...(run.marked ? { marked: true as const } : {}) };
    } catch (e) {
      // Not its child, or no words: nothing ran.
      status = "error";
      return { status: "error" as const, answer, failure: (e as Error)?.message ?? String(e) };
    } finally {
      off?.();
    }
  })();
  return {
    id,
    status: () => status,
    answer: () => answer,
    send: (text) => {
      // Once it has ended, a message would start a run of its own that nobody waits for.
      if (status === "running") void chats.prompt(id, text, { steer: true }).catch(() => undefined);
    },
    stop: () => {
      if (status === "running") void chats.abort(id).catch(() => undefined);
    },
    finished,
  };
}
