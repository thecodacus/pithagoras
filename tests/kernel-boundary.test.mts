import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { brand } from "../core/web/src/brand.ts";
import { isTab, SETTINGS_GROUPS, TAB_IDS, TABS } from "../core/web/src/settings-tabs.ts";

const WEB = path.resolve(import.meta.dirname, "../core/web");
const read = (file: string) => readFileSync(path.join(WEB, file), "utf8");
function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* sources(full);
    else if (/\.tsx?$/.test(name)) yield full;
  }
}

/** The code of a file, without its comments: a comment may name what the code no longer does. */
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:'"`])\/\/.*$/gm, "$1");

test("the shell asks the kernel for the chat list, a chat and what is done to them, and not the portal", () => {
  const shell = code("src/App.tsx");
  // What the shell may still ask itself: who is signed in, and whether there is a model to talk to.
  const own = /\bapi\.(\w+)/g;
  const asked = [...shell.matchAll(own)].map((m) => m[1]);
  assert.deepEqual([...new Set(asked)].sort(), ["allModels", "authStatus"]);
  assert.ok(!/new EventSource/.test(shell));
  assert.ok(!/\bsetEvents\b|\bsetSessions\b|\bsetUiQueue\b/.test(shell));
});

test("nothing but the kernel opens a chat's stream", () => {
  for (const file of sources(path.join(WEB, "src"))) {
    if (file.endsWith(path.join("kernel", "wire.ts"))) continue;
    assert.ok(!/new EventSource\(/.test(readFileSync(file, "utf8")), `${path.relative(WEB, file)} opens a stream of its own`);
  }
});

test("the chat does not ask the questions the kernel asks, nor call what they guard", () => {
  const chat = code("src/components/Chat.tsx");
  assert.ok(!/confirmDialog/.test(chat));
  assert.ok(!/\bapi\.(trustFlagged|deleteMessage|setMode|switchVersion|editMessage)\(/.test(chat));
});

test("the chat view takes its chat's row and two things only the frame knows, and reads and does the rest through the kernel", () => {
  const chat = code("src/components/Chat.tsx");
  const props = chat.slice(chat.indexOf("export function Chat({"), chat.indexOf("}) {", chat.indexOf("export function Chat({")));
  // What it is handed: no events, no flags of the stream, none of the eleven callbacks it was handed before.
  const handed = [...props.matchAll(/^\s{2}(\w+)\??[:,]/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(handed)].sort(), ["onClientCommand", "onOpenNavigation", "parentTitle", "session"]);
  assert.match(chat, /useKernel\(\)/);
  assert.match(chat, /useChat\(session\.id\)/);
  assert.match(chat, /useComposer\(session\.id\)/);
  // The draft, the pictures and the commands are the composer's, not the view's.
  assert.ok(!/import \{[^}]*\b(drafts|pending|api)\b[^}]*\} from/.test(chat), "the chat view imports the portal or the box's stores itself");
  assert.ok(!/\b(drafts|pending|api)\./.test(chat));
});

test("the parts of the chat that need a picture's address, an answer to the agent or a setting go through the kernel, not the portal's API", () => {
  for (const file of ["TranscriptRow", "CallFiles", "ChatPictures", "VoiceConversation", "VoicePictures", "QuestionCard"]) {
    assert.ok(!/\bapi\b/.test(code(`src/components/${file}.tsx`).replace(/import type[^;]*;/g, "")), `${file} calls the portal itself`);
  }
  assert.ok(!/\bapi\.(setConfig|compact)\(/.test(code("src/components/ComposerBar.tsx")));
  assert.ok(!/\bapi\.(setConfig|compact)\(/.test(code("src/components/ContextPill.tsx")));
});

test("the mode picker, the chat list and the sessions page leave the questions to the kernel", () => {
  assert.ok(!/confirmDialog/.test(code("src/components/ModePicker.tsx")));
  assert.ok(!/confirmDeleteSession/.test(code("src/components/SessionsPage.tsx")));
  assert.ok(!/confirmDeleteSession/.test(code("src/components/Sidebar.tsx")));
  // The row's delete button does not ask either: what it calls does.
  assert.ok(!/confirmDeleteSession\(/.test(code("src/components/SessionActions.tsx").replace(/export function confirmDeleteSession[\s\S]*?\n}\n/, "")));
});

test("the portal's name and picture are read from the one brand module", () => {
  const html = readFileSync(path.join(WEB, "index.html"), "utf8");
  const manifest = JSON.parse(readFileSync(path.join(WEB, "public/manifest.webmanifest"), "utf8"));
  // What a page reads before any module has loaded says the same.
  assert.match(html, new RegExp(`<title>${brand.name}</title>`));
  assert.match(html, new RegExp(`apple-mobile-web-app-title" content="${brand.name}"`));
  assert.equal(manifest.name, brand.name);
  assert.equal(manifest.short_name, brand.name);
  assert.ok(manifest.icons.some((i: { src: string }) => i.src === brand.icon));
  for (const file of sources(path.join(WEB, "src"))) {
    if (file.endsWith("brand.ts") || file.includes(`${path.sep}locales${path.sep}`)) continue;
    const text = code(path.relative(WEB, file));
    assert.ok(!text.includes(brand.icon), `${path.relative(WEB, file)} names the picture itself`);
    assert.ok(!/<h1[^>]*>\s*Pithagoras\s*<\/h1>/.test(text), `${path.relative(WEB, file)} draws the name itself`);
    assert.ok(!/\|\|\s*"Pithagoras"/.test(text), `${path.relative(WEB, file)} falls back to the name itself`);
  }
});

test("Settings has one list of tabs: the rail, the route and the search all read it", () => {
  assert.equal(TAB_IDS.length, new Set(TAB_IDS).size);
  assert.deepEqual(TAB_IDS, SETTINGS_GROUPS.flatMap((g) => g.tabs.map((t) => t.id)));
  assert.equal(TABS.length, TAB_IDS.length);
  for (const id of TAB_IDS) assert.ok(isTab(id));
  assert.ok(!isTab("nope"));
  const modal = code("src/components/ConfigModal.tsx");
  // The rail is drawn from the list; the dialog only adds an icon to each.
  assert.match(modal, /SETTINGS_GROUPS\.map/);
  assert.ok(!/\{ id: "authentication", label:/.test(modal));
});
