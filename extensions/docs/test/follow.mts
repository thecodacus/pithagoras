import type { MockPage } from '@pithagoras/extension-api/testing';

/**
 * A page listening to one of the Documents extension's topics, message by message, for the tests of what a page is
 * told: `folders` (the list's version) and `doc/<folder>/<document>` (each revision, each change to the comments).
 */

/** One message of a topic: what kind it is, and what it says (without the mark of the first). */
export interface Message { event: 'revision' | 'threads' | 'documents' | 'deleted'; data: any; first: boolean }

/** The topic a document's or the list's old stream address stands for. */
export function topicOf(address: string): string {
  if (address === '/folders/events') return 'folders';
  const match = /^\/folders\/([^/]+)\/documents\/([^/]+)\/events$/.exec(address);
  return match ? `doc/${match[1]}/${match[2]}` : address;
}

const kindOf = (message: any): Message['event'] => (message.deleted ? 'deleted' : message.threads ? 'threads' : message.version !== undefined ? 'documents' : 'revision');

/** Listens to `topic` (or to the address of a stream that was, see topicOf) on `page`. `status` is 200 where the page may listen, 404 where it is refused. */
export async function follow(page: MockPage, address: string) {
  const topic = topicOf(address);
  const result = await page.listen(topic);
  let taken = 0;
  const all = () => page.heard().filter(([t]) => t === topic).map(([, data]) => data as any);
  const ended = () => page.lost().includes(topic);
  /** The next message of the topic, or null once the topic is lost (the extension stopped). */
  const frame = async (ms = 5000): Promise<Message | null> => {
    await page.until(() => all().length > taken || ended(), `a message of ${topic}`, ms);
    if (all().length <= taken) return null;
    const { first, ...data } = all()[taken++];
    return { event: kindOf(data), data, first: first === true };
  };
  /** The next message of a kind, skipping the others. */
  const next = async (event: Message['event']) => {
    for (;;) {
      const got = await frame();
      if (!got || got.event === event) return got;
    }
  };
  /** The data of the next revision. */
  const revision = async () => (await next('revision'))?.data ?? null;
  return { page, topic, result, status: result === 'listening' ? 200 : 404, frame, next, revision, frames: all, ended, close: () => page.leave(topic) };
}
