import { chromium, type Browser, type Page } from "playwright-core";
import { cdpUrl } from "./cdp";
import { bareRef, REF_TOKEN } from "./ref";
import { pointAt, pointTo, press, typing } from "./cursor";
import { boolean, number, object, oneOf, string } from "./schema";
import { diffViews, findNodes, findRef, pinned, renderView, sectionText, textPage, type AxChild, type View, type Viewport } from "./view";

/**
 * The agent's browser tools: Browser's own, on the same Chromium the
 * Playwright MCP drove, over its debugging port.
 *
 * Every response is sized for a local model, which reads each token before it
 * can answer: a page is the viewport (view.ts), an action answers with what it
 * changed, text is read a section at a time. Elements are addressed by the refs
 * a view shows, resolved here — never by a selector the model wrote — and a
 * ref whose element has gone says so instead of acting on something else.
 */

let browser: Browser | null = null;
let connecting: Promise<Browser> | null = null;

async function connect(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  const at = cdpUrl();
  connecting ??= chromium
    .connectOverCDP(at, { timeout: 10_000 })
    .then((b) => {
      browser = b;
      b.on("disconnected", () => {
        if (browser === b) browser = null;
      });
      return b;
    })
    .catch((e: Error) => {
      throw new Error(`The browser is not reachable at ${at} (${e.message.split("\n")[0]}). Is it running? See the Browser page.`);
    })
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

/** What each chat was last shown, and on which tab: diffs and scrolls are told against it. */
interface Seen {
  page: Page;
  view?: View;
  url?: string;
  scrollY?: number;
}
const seen = new Map<string, Seen>();

/**
 * A chat that is gone, or a clean routine run that is over: what it was shown,
 * and the tab it held, are not needed again. Says whether there was any. Not when a chat's pi is merely
 * stopped for being idle — it goes on in its own tab when it is started again,
 * and without the record it would be handed whichever tab is newest.
 */
export function forgetChat(chatId: string): boolean {
  return seen.delete(chatId);
}

/**
 * Lets go of the browser, as the half stops: the connection to it is dropped, and the tabs the agents work in stay
 * open in it, as the browser does, for a start after this to find (closing a browser connected over CDP only
 * disconnects). What each chat was shown went with the connection: a chat goes on in the newest tab.
 */
export async function disconnect(): Promise<void> {
  seen.clear();
  const open = browser;
  browser = null;
  await open?.close();
}

/** The tab a chat works in: the one it last used, else the most recent. */
async function pageFor(sessionId: string): Promise<Page> {
  const known = seen.get(sessionId);
  if (known && !known.page.isClosed()) return known.page;
  // A tab that was closed is not kept, whether or not the browser can be reached for another.
  seen.delete(sessionId);
  const b = await connect();
  const context = b.contexts()[0] ?? (await b.newContext());
  const pages = context.pages();
  const page = pages.length ? pages[pages.length - 1] : await context.newPage();
  seen.set(sessionId, { page });
  return page;
}

const metrics = (page: Page): Promise<Viewport> =>
  page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollY: Math.round(scrollY),
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
  }));

async function look(page: Page, options: { mode?: "a11y" | "index"; skip?: ReadonlySet<string> } = {}) {
  const [tree, viewport, title] = await Promise.all([
    page.ariaSnapshotJSON({ mode: "ai", boxes: true }) as Promise<AxChild[]>,
    metrics(page),
    page.title(),
  ]);
  return { tree, viewport, view: renderView(tree, viewport, { title, url: page.url() }, options) };
}

/** Shows the page, and remembers what was shown for the next diff. */
async function show(sessionId: string, page: Page, options: { mode?: "a11y" | "index"; skip?: ReadonlySet<string> } = {}, note = "") {
  const { view, viewport } = await look(page, options);
  seen.set(sessionId, { page, view, url: page.url(), scrollY: viewport.scrollY });
  return text(note ? `${note}\n\n${view.text}` : view.text);
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

/** Lets a page settle after an action: its load, then a moment for scripts to draw. */
async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
}

/** A ref as the model may write it — `e12`, `[e12]`, `ref=e12` — reduced to the ref. */
export function cleanRef(raw: unknown): string {
  const ref = bareRef(String(raw ?? ""));
  if (!REF_TOKEN.test(ref)) throw new Error(`"${raw}" is not a ref. Use one from the last snapshot, like e12.`);
  return ref;
}

/** The element a ref names, or a clear error when it is gone: never something else in its place. */
async function element(page: Page, raw: unknown) {
  const ref = cleanRef(raw);
  const locator = page.locator(`aria-ref=${ref}`);
  if ((await locator.count()) === 0) {
    throw new Error(`${ref} is no longer on the page: it changed or was removed. Take a fresh browser_snapshot and use the refs it shows.`);
  }
  return { ref, locator };
}

/**
 * An action, answered with what it changed. A new address or a new tab is
 * answered with a view of it; so is a change too big to be shorter as a diff.
 */
async function act(sessionId: string, what: string, fn: (page: Page) => Promise<void>) {
  const page = await pageFor(sessionId);
  let before = seen.get(sessionId);
  if (!before?.view || before.url !== page.url()) {
    const { view, viewport } = await look(page);
    before = { page, view, url: page.url(), scrollY: viewport.scrollY };
  }
  // Listening while the action and the settling run, and looking afterwards:
  // waiting a fixed time for a tab that almost never comes costs every action.
  let tab = undefined as Page | undefined;
  const context = page.context();
  const onPage = (p: Page) => void (tab ??= p);
  context.on("page", onPage);
  try {
    await fn(page);
    await settle(page);
  } finally {
    context.off("page", onPage);
  }
  if (tab) {
    await settle(tab);
    return show(sessionId, tab, {}, `${what}: it opened a new tab, which is where you are now.`);
  }
  if (page.url() !== before.url) return show(sessionId, page, {}, `${what}: the page is now ${page.url()}.`);
  const { view, viewport } = await look(page);
  const changes = diffViews(before.view!, view);
  seen.set(sessionId, { page, view, url: page.url(), scrollY: viewport.scrollY });
  if (changes === null) return text(`${what}: the page changed a lot.\n\n${view.text}`);
  return text(changes.length ? `${what}. What changed on screen:\n${changes.join("\n")}` : `${what}. Nothing on screen changed.`);
}

/** Keys as people write them ("cmd+l", "ctrl+shift+t") in Playwright's spelling. */
export function keyCombo(raw: string): string {
  const names: Record<string, string> = { cmd: "Meta", command: "Meta", meta: "Meta", ctrl: "Control", control: "Control", alt: "Alt", option: "Alt", shift: "Shift", esc: "Escape", enter: "Enter", return: "Enter", tab: "Tab", space: "Space", backspace: "Backspace", delete: "Delete", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", pageup: "PageUp", pagedown: "PageDown", home: "Home", end: "End" };
  return raw
    .split("+")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => names[k.toLowerCase()] ?? k)
    .join("+");
}

/**
 * What the model is told about these tools, written as for someone new to
 * them: what each does, what its arguments look like, what comes back and how
 * it can fail. What several tools share is said once, as a rule: promptGuidelines,
 * which pi puts in the system prompt only while a tool that has them is active,
 * and once however many do. So a rule goes on every tool it concerns, and stays
 * when one of them is switched off.
 */

const REF = string("Element ref from the latest view or browser_find, e.g. e12 (f1e5 inside a frame)");

/** The view's format, said once, on the tool that shows it. */
const VIEW_FORMAT =
  "Format: a header with title, URL and scroll position; then one line per element, indented by nesting: " +
  'role "name": text [ref] states, e.g. button "Save" [e12] disabled. A word with a ref in a sentence, like pricing[e30], is a clickable link. ' +
  "Cut text ends with (+N chars: get_text eN). The footer says how much is above and below.";

/** What the actions answer with: on the tools that act, and on browser_snapshot, which is not to be called after them. */
export const ACTIONS_RULE =
  "browser_click, browser_type, browser_select and browser_key answer with what changed (~ old → new, + appeared, - gone, or the new page if it navigated or opened a tab; " +
  '"Nothing on screen changed" = no visible effect): read that instead of taking another browser_snapshot.';

/** Where a ref comes from and what a gone one means: on every tool that gives or takes refs. */
export const REFS_RULE = "Browser refs come from browser_snapshot or browser_find; never guess one. A ref whose element is gone is refused: take a fresh browser_snapshot.";

/** The tools of the chat `sessionId`, registered in its pi (`portal.chats.extend`). */
export function browserTools(sessionId: string) {
  return (pi: any): void => {
    // One tab, one action at a time: a click and a typed word in parallel race each other. Every tool declares that
    // what it reads is outside content, and that its `url` is an address the agent chose (ToolGuard of the extension API).
    const tool = (definition: Record<string, unknown>) =>
      pi.registerTool({ executionMode: "sequential", ...definition, guard: { outside: true, reaches: ["url"] } });

    tool({
      name: "browser_navigate",
      label: "Go to",
      description:
        "Open a URL in the current tab. To follow a link on the page, use browser_click. " +
        "Answers with the new page's view; fails with the browser's error if it does not load.",
      promptSnippet: "Open a URL in the browser",
      parameters: object({
        url: string("Full URL with scheme, e.g. https://example.com/page"),
      }),
      async execute(_id: string, p: { url: string }) {
        const page = await pageFor(sessionId);
        await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(600);
        return show(sessionId, page);
      },
    });

    tool({
      name: "browser_back",
      label: "Back",
      description: "Go back one page in the current tab and show it. Fails when there is no page to go back to.",
      promptSnippet: "Go back to the previous page",
      parameters: object({}),
      async execute() {
        const page = await pageFor(sessionId);
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(400);
        return show(sessionId, page);
      },
    });

    tool({
      name: "browser_snapshot",
      label: "Look at the page",
      description: "Show the current tab's viewport (plus a margin) as text, with a ref for each element. " + VIEW_FORMAT,
      promptSnippet: "See what is on screen, as text with refs",
      promptGuidelines: [ACTIONS_RULE, REFS_RULE],
      parameters: object({
        mode: oneOf(["a11y", "index"], "a11y (default): everything in view, with text. index: only controls; shorter, for forms and navigating"),
      }, ["mode"]),
      async execute(_id: string, p: { mode?: "a11y" | "index" }) {
        return show(sessionId, await pageFor(sessionId), { mode: p.mode });
      },
    });

    tool({
      name: "browser_click",
      label: "Click",
      description: "Click an element by its ref: link, button, checkbox, tab, menu item. Refs only, not CSS selectors or text.",
      promptSnippet: "Click an element by its ref",
      promptGuidelines: [ACTIONS_RULE, REFS_RULE],
      parameters: object({
        ref: REF,
        double: boolean("Double-click; default false"),
      }, ["double"]),
      async execute(_id: string, p: { ref: string; double?: boolean }) {
        return act(sessionId, `Clicked ${cleanRef(p.ref)}`, async (page) => {
          const { locator } = await element(page, p.ref);
          await pointAt(page, locator, p.double ? "Double-click" : "Click");
          if (p.double) await Promise.all([press(page), locator.dblclick({ timeout: 10_000 })]);
          else await Promise.all([press(page), locator.click({ timeout: 10_000 })]);
        });
      },
    });

    tool({
      name: "browser_type",
      label: "Type",
      description: "Replace the text of a field or editable area by its ref; submit presses Enter after. Dropdowns: browser_select; single keys: browser_key.",
      promptSnippet: "Fill in a text field by its ref",
      promptGuidelines: [ACTIONS_RULE, REFS_RULE],
      parameters: object({
        ref: REF,
        text: string("The field's whole new text"),
        submit: boolean("Press Enter after; default false"),
      }, ["submit"]),
      async execute(_id: string, p: { ref: string; text: string; submit?: boolean }) {
        return act(sessionId, `Typed into ${cleanRef(p.ref)}`, async (page) => {
          const { locator } = await element(page, p.ref);
          // The field, never what goes in it: a password or a code would otherwise be on screen.
          await pointAt(page, locator, "Type");
          await typing(page, true);
          try {
            await locator.fill(p.text, { timeout: 10_000 });
          } finally {
            await typing(page, false);
          }
          if (p.submit) await Promise.all([press(page, "Press · Enter"), locator.press("Enter")]);
        });
      },
    });

    tool({
      name: "browser_select",
      label: "Choose",
      description:
        "Choose an option of a native dropdown (combobox, listbox) by its ref and the option's visible text. " +
        "For one built from buttons and lists, open it and use browser_click.",
      promptSnippet: "Choose an option in a dropdown",
      promptGuidelines: [ACTIONS_RULE, REFS_RULE],
      parameters: object({
        ref: REF,
        option: string("Option text exactly as shown"),
      }),
      async execute(_id: string, p: { ref: string; option: string }) {
        return act(sessionId, `Chose "${p.option}" in ${cleanRef(p.ref)}`, async (page) => {
          const { locator } = await element(page, p.ref);
          await pointAt(page, locator, "Choose", p.option);
          await Promise.all([press(page), locator.selectOption({ label: p.option }, { timeout: 10_000 })]);
        });
      },
    });

    tool({
      name: "browser_key",
      label: "Press keys",
      description: "Press a key or combination in the page: submit, close a dialog, move through a list, a shortcut. Text into a field: browser_type.",
      promptSnippet: "Press a key or a shortcut",
      promptGuidelines: [ACTIONS_RULE],
      parameters: object({
        key: string("Key or keys joined with +, e.g. Enter, Escape, shift+Tab, ctrl+a"),
      }),
      async execute(_id: string, p: { key: string }) {
        const combo = keyCombo(p.key);
        return act(sessionId, `Pressed ${combo}`, (page) => Promise.all([press(page, `Press · ${combo}`), page.keyboard.press(combo)]).then(() => {}));
      },
    });

    tool({
      name: "browser_scroll",
      label: "Scroll",
      description:
        "Scroll the current tab (one screen down by default) and show the new view; with ref, scroll that element into view instead. " +
        "What stayed pinned (a sticky sidebar) is named, not repeated. Says when already at the top or bottom.",
      promptSnippet: "See the next screen down or up",
      promptGuidelines: [REFS_RULE],
      parameters: object({
        direction: oneOf(["down", "up"], "Default down"),
        screens: number("Default 1, at most 10; 0.5 is half a screen"),
        ref: string("Element to scroll into view instead"),
      }, ["direction", "screens", "ref"]),
      async execute(_id: string, p: { direction?: "down" | "up"; screens?: number; ref?: string }) {
        const page = await pageFor(sessionId);
        const before = seen.get(sessionId);
        if (p.ref) {
          const { locator } = await element(page, p.ref);
          await locator.scrollIntoViewIfNeeded({ timeout: 10_000 });
          await pointAt(page, locator, "Scroll to");
        } else {
          const { width, height } = await metrics(page);
          const screens = Math.min(Math.max(p.screens ?? 1, 0.25), 10);
          await pointTo(page, width / 2, height / 2, p.direction === "up" ? "Scroll up" : "Scroll down");
          // At the middle of the page, so a scrolling panel under the pointer scrolls too.
          await page.mouse.move(width / 2, height / 2);
          await page.mouse.wheel(0, (p.direction === "up" ? -1 : 1) * height * 0.9 * screens);
        }
        await page.waitForTimeout(500);
        const now = await look(page);
        const skip = before?.view && before.url === page.url() ? pinned(before.view, now.view, now.viewport.scrollY - (before.scrollY ?? 0)) : new Set<string>();
        if (before && before.url === page.url() && before.scrollY === now.viewport.scrollY && !p.ref) {
          return show(sessionId, page, { skip }, p.direction === "up" ? "Already at the top." : "Already at the bottom: there is nothing further down.");
        }
        return show(sessionId, page, { skip });
      },
    });

    tool({
      name: "browser_find",
      label: "Find on the page",
      description:
        "Find elements anywhere on the page, in view or not, whose name or text contains all the words (any case). " +
        "Up to 15 matches, nearest first, each a view line with its ref and where it is (in view, or pixels above/below); act on one directly.",
      promptSnippet: "Find an element anywhere on the page by its words",
      promptGuidelines: ["Use browser_find to reach something off screen that you can name, instead of scrolling through the page to look for it.", REFS_RULE],
      parameters: object({
        query: string("Words to match, e.g. add to cart"),
      }),
      async execute(_id: string, p: { query: string }) {
        const page = await pageFor(sessionId);
        const { tree, viewport } = await look(page);
        const hits = findNodes(tree, p.query, viewport);
        return text(hits.length ? hits.join("\n") : `Nothing on the page matches "${p.query}".`);
      },
    });

    tool({
      name: "browser_get_text",
      label: "Read",
      description:
        "Read a section's full text by its ref (paragraph, article, table, list, thread, main area), e.g. where a view cut text short. " +
        "Plain text: headings #, list items -, table cells |; long text comes in pages of max_chars, each ending with the offset to continue from.",
      promptSnippet: "Read a section's full text by its ref",
      promptGuidelines: ["Use browser_get_text to read long text on a page, rather than scrolling through it or taking screenshots of it.", REFS_RULE],
      parameters: object({
        ref: string("Section ref, e.g. e40"),
        offset: number("From the previous page; default 0"),
        max_chars: number("Default 2000, 200 to 8000"),
      }, ["offset", "max_chars"]),
      async execute(_id: string, p: { ref: string; offset?: number; max_chars?: number }) {
        const ref = cleanRef(p.ref);
        const page = await pageFor(sessionId);
        const { tree } = await look(page);
        const node = findRef(tree, ref);
        if (!node) throw new Error(`${ref} is no longer on the page: it changed or was removed. Take a fresh browser_snapshot and use the refs it shows.`);
        return text(textPage(sectionText(node), ref, p.offset ?? 0, Math.min(Math.max(p.max_chars ?? 2000, 200), 8000)));
      },
    });

    tool({
      name: "browser_screenshot",
      label: "Screenshot",
      description:
        "A JPEG of the current tab's screen, or of one element by ref. A glass arrow in it (maybe labelled) is your cursor, not the page: " +
        "it points at your last action's target, so if it is elsewhere, that action hit the wrong element.",
      promptSnippet: "A picture of the screen, for layout and images",
      promptGuidelines: ["Use browser_screenshot only when layout, images or a canvas matter; browser_snapshot and browser_get_text are cheaper to read.", REFS_RULE],
      parameters: object({
        ref: string("One element to capture; the whole screen if omitted"),
      }, ["ref"]),
      async execute(_id: string, p: { ref?: string }) {
        const page = await pageFor(sessionId);
        const target = p.ref ? (await element(page, p.ref)).locator : null;
        const shot = target
          ? await target.screenshot({ type: "jpeg", quality: 70, timeout: 10_000 })
          : await page.screenshot({ type: "jpeg", quality: 70, timeout: 10_000 });
        return { content: [{ type: "image" as const, data: shot.toString("base64"), mimeType: "image/jpeg" }], details: {} };
      },
    });
  };
}

/** What Settings → Tools is told of them (`portal.tools.offer`): each one's name and description. */
export function offeredTools(): { name: string; description: string }[] {
  const tools: { name: string; description: string }[] = [];
  browserTools("")({ registerTool: ({ name, description }: { name: string; description: string }) => tools.push({ name, description }) });
  return tools;
}
