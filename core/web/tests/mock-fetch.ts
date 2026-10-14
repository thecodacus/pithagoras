/** What a fixture's `answer` says for a call: the JSON of a 200, a Response of its own, or undefined for "not mine". */
export type FetchAnswer = unknown | Response;

/**
 * The page's `fetch`, answered by a fixture. `answer(url, init)` gets every call; one it returns nothing for goes on
 * to the real fetch, where the browser tests answer it or, if no test did, `tests/browser/portal-mock.ts` answers it
 * 501 with its name. So a call a fixture and its test both leave out fails where it is made, and none of them reaches
 * a portal. Calls to what the page serves itself (a sound, a picture) are the real fetch's too.
 */
export function mockFetch(answer: (url: string, init?: RequestInit) => FetchAnswer | Promise<FetchAnswer>) {
  const realFetch = window.fetch;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const got = await answer(String(input), init);
    if (got === undefined) return realFetch(input, init);
    return got instanceof Response ? got : new Response(JSON.stringify(got), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}
