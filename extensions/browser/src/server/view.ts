/**
 * What the model sees of a page: the part in the viewport, as compact text.
 *
 * Built from Playwright's AI-mode aria snapshot (page.ariaSnapshotJSON with
 * mode "ai" and boxes), never from HTML. A local model has to read every token
 * a tool returns before it can answer, so the whole page — 120k tokens for one
 * long article — is the slow path. This keeps to the viewport plus a margin,
 * drops the wrappers that mean nothing (generic, rowgroup, nameless cells),
 * cuts long text with a pointer to get_text, and caps the total.
 *
 * Pure functions over the snapshot JSON, so all of it is tested without a
 * browser.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A node of ariaSnapshotJSON: an element, or a bare string for a text fragment. */
export type AxChild = AxNode | string;
export interface AxNode {
  role: string;
  name?: string;
  text?: string;
  ref?: string;
  cursor?: string;
  box?: Box;
  url?: string;
  placeholder?: string;
  children?: AxChild[];
  [state: string]: unknown;
}

export interface Viewport {
  width: number;
  height: number;
  /** How far the page is scrolled, and how tall it is: for "0–720 of 33,409 px". */
  scrollY: number;
  scrollHeight: number;
}

export interface ViewOptions {
  /** "a11y": everything in view. "index": only what can be clicked or typed into. */
  mode?: "a11y" | "index";
  /** Most characters returned; past it the rest is counted, not shown. About 3k tokens. */
  maxChars?: number;
  /** How much past the viewport still counts as in view, as a fraction of its height. */
  margin?: number;
  /** Longest text shown for one node before it is cut with a pointer to get_text. */
  textMax?: number;
  /**
   * Refs not to show again, with their insides: what stayed pinned on screen
   * through a scroll (a sticky sidebar), already read on the last view.
   */
  skip?: ReadonlySet<string>;
}

const DEFAULTS = { mode: "a11y" as const, maxChars: 12_000, margin: 0.25, textMax: 200 };

/** Roles something can be done with. */
const INTERACTIVE = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "spinbutton", "treeitem",
]);

/** Wrappers that carry no meaning of their own unless they are named. */
const STRUCTURAL = new Set(["generic", "none", "presentation", "group", "rowgroup", "section", "cell", "gridcell", "row", "paragraph", "list", "listitem", "table", "region", "article", "main", "navigation", "banner", "contentinfo", "complementary", "document", "form", "figure"]);

/** Structural roles worth a line of their own even unnamed: they tell the model what kind of thing it is reading. */
const OUTLINE = new Set(["list", "table", "navigation", "main", "form", "dialog", "alertdialog", "banner", "contentinfo", "complementary", "region", "article"]);

/** State flags shown on a line, as they are named in the snapshot. */
const FLAGS = ["checked", "disabled", "expanded", "pressed", "selected", "invalid", "active", "required"] as const;

export const interactive = (n: AxNode) => INTERACTIVE.has(n.role) || n.cursor === "pointer";

/** A string with something readable in it: "|" and "(" between links are layout, not text. */
const readable = (s: string) => /[\p{L}\p{N}]/u.test(s);

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const fmt = (n: number) => n.toLocaleString("en-US");

/** The flags and values a node is in, as " checked disabled level=2 value=…". */
function states(n: AxNode): string {
  const out: string[] = [];
  for (const f of FLAGS) {
    const v = n[f];
    if (v === true) out.push(f);
    else if (typeof v === "string" && v && v !== "false") out.push(`${f}=${v}`);
  }
  if (typeof n.level === "number") out.push(`level=${n.level}`);
  if (typeof n.value === "string" && n.value) out.push(`value="${clip(n.value, 80)}"`);
  if (n.placeholder) out.push(`placeholder="${clip(n.placeholder, 60)}"`);
  return out.length ? ` ${out.join(" ")}` : "";
}

/** Roles read as part of the sentence around them rather than on a line of their own. */
const INLINE = new Set(["link", "emphasis", "strong", "code", "mark", "subscript", "superscript", "time", "deletion", "insertion", "generic"]);

/** Text with elements inside it, like a paragraph with links: its inline children belong in the sentence. */
const mixed = (n: AxNode) => (n.children ?? []).some((c) => typeof c === "string" && readable(c));

/** A child that reads as part of its parent's sentence: an inline element holding only text and other such elements. */
function inlinable(c: AxChild): c is AxNode {
  return typeof c !== "string" && INLINE.has(c.role) && (c.children ?? []).every((k) => typeof k === "string" || inlinable(k));
}

/** A footnote marker, "[12]": never what anybody reads a paragraph for. */
const FOOTNOTE = /^\[\s*(\d+|[a-z]|citation needed)\s*\]$/i;

/** An inline child as it reads in the sentence; one that can be clicked keeps its ref, as `word[e12]`. */
function inlineText(c: AxNode): string {
  const kids = c.children ?? [];
  const words = (kids.length ? join(kids.map((k) => (typeof k === "string" ? k : inlineText(k)))) : c.name || c.text || "").trim();
  if (FOOTNOTE.test(words) || FOOTNOTE.test(c.name ?? "")) return "";
  return interactive(c) && c.ref && words ? `${words}[${c.ref}]` : words;
}

/**
 * Pieces of text joined as they read. Playwright trims each piece, so the
 * spaces between them are put back — but not before punctuation, or after an
 * opening bracket, so "transformer" "-based" is "transformer-based" and
 * "(" "RAG" ")" is "(RAG)".
 */
function join(pieces: string[]): string {
  let out = "";
  for (const raw of pieces) {
    const p = raw.replace(/\s+/g, " ").trim();
    if (!p) continue;
    const glue = !out || /[(\[\/"“‘-]$/.test(out) || /^[,.;:!?)\]%’”'\-–—/]/.test(p) ? "" : " ";
    out += glue + p;
  }
  return out;
}

/**
 * The text a node holds directly: its own text, or its string children with
 * any inline elements among them read in place. Joined as the page has them,
 * so "transformer" and "-based" stay "transformer-based".
 */
function ownText(n: AxNode): string {
  const pieces = n.text && readable(n.text) ? [n.text] : [];
  const inline = mixed(n);
  for (const c of n.children ?? []) {
    if (typeof c === "string") {
      if (readable(c) || /^[,.;:!?)(\-–—]+$/.test(c.trim())) pieces.push(c);
    } else if (inline && inlinable(c)) pieces.push(inlineText(c));
  }
  return join(pieces);
}

/** A URL without its query and fragment: tracking parameters are most of a long one. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url.replace(/[?#].*$/, "");
  }
}

/** What a node says, for telling whether it only repeats something already shown. */
const says = (n: AxNode) => (n.name || ownText(n)).toLowerCase();

/** One line for a node, with its text cut where it is long. */
function line(n: AxNode, depth: number, textMax: number): string {
  const name = n.name ? ` "${clip(n.name, 120)}"` : "";
  let text = ownText(n);
  if (n.name && text === n.name) text = "";
  let more = "";
  if (text.length > textMax) {
    more = ` (+${fmt(text.length - textMax)} chars: get_text ${n.ref ?? ""})`;
    text = text.slice(0, textMax).trimEnd() + "…";
  }
  // A link's name says where it goes; its URL is only worth the tokens when it has no name.
  const url = n.url && !n.name && !text ? ` → ${clip(shortUrl(n.url), 80)}` : "";
  const ref = n.ref ? ` [${n.ref}]` : "";
  return `${"  ".repeat(depth)}${n.role}${name}${text ? `: ${text}` : ""}${more}${ref}${states(n)}${url}`;
}

/** Whether a node earns a line: something to do with it, a name, text, or a shape worth knowing. */
function earnsLine(n: AxNode): boolean {
  if (interactive(n) || n.name) return true;
  if (ownText(n)) return true;
  if (!STRUCTURAL.has(n.role)) return Boolean(n.ref) || n.role !== "img";
  // An outline role without a ref is not on screen: a collapsed menu's list.
  return OUTLINE.has(n.role) && Boolean(n.ref);
}

/** A line a view showed: what diffs are made of. */
export interface Shown {
  ref?: string;
  /** The line without its indent. */
  line: string;
  /** The ref of the shown line it sits under ("" at the top), and its place among those under it. */
  parent: string;
  index: number;
  depth: number;
  box?: Box;
}

export interface View {
  text: string;
  /** Things with a line of their own above and below the window, for "N more below". */
  above: number;
  below: number;
  shown: Shown[];
}

/**
 * The page as the model reads it: a header, the nodes in view, and how much
 * there is above and below. Capped at maxChars.
 */
export function renderView(
  tree: AxChild[],
  viewport: Viewport,
  meta: { title: string; url: string },
  options: ViewOptions = {},
): View {
  const { mode, maxChars, margin, textMax } = { ...DEFAULTS, ...options };
  const skip = options.skip ?? new Set<string>();
  const skipped: string[] = [];
  const shown: Shown[] = [];
  const siblings = new Map<string, number>();
  const top = -viewport.height * margin;
  const bottom = viewport.height * (1 + margin);
  const lines: string[] = [];
  let used = 0;
  let above = 0;
  let below = 0;
  let capped = 0;

  const where = (b: Box | undefined, inherited: number): number => {
    if (!b) return inherited;
    if (b.y + b.height < top) return -1;
    if (b.y > bottom) return 1;
    return 0;
  };

  const push = (n: AxNode, depth: number, parent: string): boolean => {
    const text = line(n, depth, textMax);
    if (used + text.length + 1 > maxChars) {
      capped++;
      return false;
    }
    lines.push(text);
    used += text.length + 1;
    const index = siblings.get(parent) ?? 0;
    siblings.set(parent, index + 1);
    shown.push({ ref: n.ref, line: text.trimStart(), parent, index, depth, box: n.box });
    return true;
  };

  // `context` is what the nearest shown ancestor says: a child that only repeats part of it
  // ("100" and "Go to comments" under link "100 Go to comments") adds nothing.
  const walk = (n: AxChild, depth: number, inherited: number, context = "", parent = "") => {
    if (typeof n === "string") return;
    const at = where(n.box, inherited);
    if (at === 0 && n.ref && skip.has(n.ref)) {
      skipped.push(n.name || n.role);
      return;
    }
    const repeats = !interactive(n) && context !== "" && says(n) !== "" && context.includes(says(n));
    const counts = mode === "index" ? interactive(n) : earnsLine(n);
    if (at !== 0) {
      if (counts && (n.box || inherited !== 0)) at < 0 ? above++ : below++;
    } else if (mode === "index") {
      if (interactive(n)) push(n, 0, "");
    } else if (earnsLine(n) && !repeats) {
      push(n, depth, parent);
      depth++;
      context = says(n);
      parent = n.ref ?? parent;
      // Its links and emphasis were read into its line.
      if (mixed(n)) {
        for (const c of n.children ?? []) if (!inlinable(c)) walk(c, depth, at, context, parent);
        return;
      }
    }
    for (const c of n.children ?? []) walk(c, depth, at, context, parent);
  };
  for (const n of tree) walk(n, 0, 0);

  const pct = viewport.scrollHeight > 0 ? Math.round(((viewport.scrollY + viewport.height) / viewport.scrollHeight) * 100) : 100;
  const header = [
    `Page: ${clip(meta.title || "(untitled)", 120)} — ${clip(meta.url, 160)}`,
    `View: ${fmt(viewport.scrollY)}–${fmt(viewport.scrollY + viewport.height)} of ${fmt(viewport.scrollHeight)} px (${Math.min(pct, 100)}%), ${viewport.width}×${viewport.height}${mode === "index" ? ", interactive elements only" : ""}`,
  ];
  const footer: string[] = [];
  if (skipped.length) footer.push(`(Still on screen and unchanged, not repeated: ${skipped.map((s) => clip(s, 40)).join(", ")}.)`);
  if (capped) footer.push(`… ${fmt(capped)} more in view not shown (capped): use find, get_text, or mode "index".`);
  if (above) footer.push(`↑ ${fmt(above)} more above.`);
  if (below) footer.push(`↓ ${fmt(below)} more below: scroll down, or find what you need.`);
  if (!lines.length && !capped) lines.push("(nothing in view)");
  return { text: [...header, "", ...lines, ...(footer.length ? ["", ...footer] : [])].join("\n"), above, below, shown };
}

/**
 * What stayed pinned through a scroll: lines at the top of both views, at the
 * same place on screen, although the page moved under them. A sticky sidebar
 * or header — read on the last view, and not worth reading again.
 */
export function pinned(before: View, after: View, scrolled: number): Set<string> {
  if (Math.abs(scrolled) < 1) return new Set();
  const was = new Map(before.shown.filter((s) => s.ref && s.box).map((s) => [s.ref!, s]));
  const out = new Set<string>();
  for (const s of after.shown) {
    const old = s.ref ? was.get(s.ref) : undefined;
    if (old && s.depth === 0 && s.box && old.box && Math.abs(s.box.y - old.box.y) < 1 && old.line === s.line) out.add(s.ref!);
  }
  return out;
}

/** Whether a change touched too much to be told as a diff: then the whole view is sent instead. */
const DIFF_MAX_LINES = 40;

/**
 * What an action changed, as the lines that are new, gone or different, or
 * null when the page changed too much for a diff to be shorter than a view.
 *
 * Matched by ref. An element whose name changes gets a new ref ("Save" e5
 * becomes "Saved" e10), so what is left over on both sides is paired by where
 * it sits — same parent, same place — and told as one change.
 */
export function diffViews(before: View, after: View): string[] | null {
  const key = (s: Shown) => `${s.parent}#${s.index}`;
  const beforeByRef = new Map(before.shown.filter((s) => s.ref).map((s) => [s.ref!, s]));
  const afterRefs = new Set(after.shown.filter((s) => s.ref).map((s) => s.ref!));
  const out: string[] = [];
  const added: Shown[] = [];
  for (const s of after.shown) {
    const old = s.ref ? beforeByRef.get(s.ref) : undefined;
    if (!old) added.push(s);
    else if (old.line !== s.line) out.push(`~ ${old.line}  →  ${s.line}`);
  }
  const removed = before.shown.filter((s) => !s.ref || !afterRefs.has(s.ref));
  const removedAt = new Map(removed.map((s) => [key(s), s]));
  for (const s of added) {
    const old = removedAt.get(key(s));
    if (old && old.line.split(/[ :"]/)[0] === s.line.split(/[ :"]/)[0]) {
      removedAt.delete(key(s));
      if (old.line !== s.line) out.push(`~ ${old.line}  →  ${s.line}`);
    } else out.push(`+ ${s.line}`);
  }
  for (const s of removedAt.values()) out.push(`- ${s.line}`);
  return out.length > DIFF_MAX_LINES ? null : out;
}

/** Find the node with this ref, or undefined. */
export function findRef(tree: AxChild[], ref: string): AxNode | undefined {
  for (const n of tree) {
    if (typeof n === "string") continue;
    if (n.ref === ref) return n;
    const inner = n.children && findRef(n.children, ref);
    if (inner) return inner;
  }
  return undefined;
}

/** Roles that start a new line when a section's text is read. */
const BLOCK = new Set(["heading", "paragraph", "listitem", "row", "blockquote", "caption", "term", "definition", "separator", "article", "section", "region", "figure"]);

/**
 * All the text under a node, as prose: blocks on lines of their own, a row's
 * cells separated by " | ". For get_text, which pages through it.
 */
export function sectionText(node: AxNode): string {
  const out: string[] = [];
  const walk = (n: AxChild) => {
    if (typeof n === "string") {
      if (readable(n)) out.push(n.trim());
      return;
    }
    const block = BLOCK.has(n.role);
    if (block) out.push("\n");
    if (n.role === "heading") out.push("#".repeat(Number(n.level) || 2) + " ");
    if (n.role === "listitem") out.push("- ");
    const kids = n.children ?? [];
    if (n.text) out.push(n.text);
    else if (n.name && !kids.some((c) => typeof c !== "string" || readable(c))) out.push(n.name);
    kids.forEach((c, i) => {
      if (n.role === "row" && i > 0) out.push(" | ");
      walk(c);
    });
    if (block) out.push("\n");
  };
  walk(node);
  return out
    .join(" ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A page of a section's text, with where it is in the whole and how to read on. */
export function textPage(text: string, ref: string, offset = 0, max = 2000): string {
  const start = Math.max(0, Math.min(offset, text.length));
  let end = Math.min(text.length, start + max);
  // At a word boundary, so a page does not end halfway through a word.
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    const newline = text.lastIndexOf("\n", end);
    const at = Math.max(space, newline);
    if (at > start + max * 0.8) end = at;
  }
  const body = text.slice(start, end);
  if (start === 0 && end === text.length) return body || "(no text)";
  const next = end < text.length ? `; get_text ${ref} offset=${end} for more` : "; end of text";
  return `${body}\n\n(chars ${fmt(start)}–${fmt(end)} of ${fmt(text.length)}${next})`;
}

/**
 * The nodes anywhere on the page whose name or text has every word of the
 * query, best first: what is in view, then the nearest. Each with where it is,
 * so the model knows whether to scroll or act on it straight away.
 */
export function findNodes(tree: AxChild[], query: string, viewport: Viewport, limit = 15): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: { n: AxNode; distance: number }[] = [];
  const walk = (n: AxChild) => {
    if (typeof n === "string") return;
    const hay = `${n.name ?? ""} ${ownText(n)} ${n.placeholder ?? ""}`.toLowerCase();
    if (n.ref && (interactive(n) || earnsLine(n)) && words.every((w) => hay.includes(w))) {
      const b = n.box;
      const distance = !b ? Infinity : b.y + b.height < 0 ? -(b.y + b.height) : b.y > viewport.height ? b.y - viewport.height : 0;
      hits.push({ n, distance });
    }
    (n.children ?? []).forEach(walk);
  };
  tree.forEach(walk);
  // The deepest match for the same words is the useful one: the link, not every wrapper around it.
  hits.sort((a, b) => a.distance - b.distance || Number(interactive(b.n)) - Number(interactive(a.n)));
  return hits.slice(0, limit).map(({ n, distance }) => {
    const b = n.box;
    const where = distance === 0 ? "in view" : !b ? "not on screen" : b.y < 0 ? `${fmt(Math.round(distance))} px above` : `${fmt(Math.round(distance))} px below`;
    return `${line(n, 0, 120)} — ${where}`;
  });
}
