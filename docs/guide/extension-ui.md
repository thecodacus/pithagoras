# Building an extension

An extension is an ordinary pi package that also brings something to the
portal: a panel beside a conversation, a page in the sidebar, routes of its
own on the server, tools for the agent that share what those routes know, a
theme. It is installed, switched and removed like any other package
([Extensions](/guide/extensions)), and it is loaded as it is: nothing of it is
compiled into the portal.

This page takes you from an empty folder to a working extension, then lists
everything the portal hands one. The snippets are taken from a complete
example, `tests/fixtures/extensions/notes`: it is not shipped, and the portal's
tests check the framework with it.

## The three halves

A package can have any of these. Each is optional.

| Half | Named in `package.json` | Runs | Lives | For |
| --- | --- | --- | --- | --- |
| pi extension | `pi.extensions` | Inside a chat's pi | One per chat, while the chat's agent is up | Tools, commands, what is kept with the conversation |
| Browser half | `pithagoras.client` | In the portal's page | While the page is open | Everything drawn |
| Server half | `pithagoras.server` | In the portal's own process, or a process of its own ([`isolated`](#a-server-half-in-a-process-of-its-own)) | Once, for all chats | Routes, processes, what must be there when no chat is running |

Which one a piece of work belongs in follows from when it has to be there. A
chat left alone for twenty minutes has its agent let go, and where pi runs in a
container (`EXECUTOR=container`) it is not in the portal's process at all. So
listing a folder's files, a terminal's shell, or a page that shows every chat's
notes belongs in the server half. A tool the agent calls belongs in pi, either
in the package's pi extension or [added by the server half](#tools-that-share-the-server-half-s-state).

## Your first extension

Three files. No build step.

```
hello/
├── package.json
└── web/
    ├── client.js
    └── client.css
```

```json
{
  "name": "hello",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": {},
  "pithagoras": { "client": "./web/client.js", "style": "./web/client.css" }
}
```

```js
// web/client.js
export default function (portal) {
  const { React } = portal;
  const h = React.createElement;

  function Hello({ chat }) {
    // What the agent has run in its shell, read from the chat as the page has it.
    const runs = portal.chats.use(chat.id, (feed) => feed.items.filter((item) => item.kind === "tool" && item.name === "bash"));
    return h("div", { className: "hello" },
      h("p", null, `${runs.length} commands run in ${chat.title}`),
      runs.map((run) => h("pre", { key: run.id }, `$ ${run.args.command}\n${run.output ?? ""}`)));
  }

  portal.slots.register("chat.panel", { id: "hello", title: "Hello", component: Hello });
}
```

```css
/* web/client.css */
.hello { padding: 12px; color: rgb(var(--fg)); font-size: 13px; }
.hello pre { border: 1px solid rgb(var(--line)); border-radius: 8px; padding: 8px; }
```

Install it in **Settings → Extensions → Discover → Install by name** by its path
(`/absolute/path/to/hello`). A **Hello** button appears in every chat's header.
Open it, ask the agent to run something, and the command and its output appear
in your panel as they happen.

While you work on it:

| You changed | To see it |
| --- | --- |
| A file of the browser half | Reload the page, or install the folder again by its path for every open page |
| A file of the server half, its `chats.extend` factories among it | Install the folder again by its path |
| The pi extension | Install the folder again by its path, or `/reload` in one chat: its `.ts` files, and its `.js` files where the package is not `"type": "module"`. Its other files need a restart of the portal |

pi installs a folder by reference, so installing it again copies nothing: it
starts the server half again where a file of it changed, swaps the browser half
into every open page where a file of it changed, and reloads the open chats, a
chat that is working at its next step (see
[a chat that is working](/guide/extensions#a-chat-that-is-working)). What a
chat could not load, such as a factory of `chats.extend` that throws, is said
in that chat. Which files are a half's, and what still needs a restart of the
portal, is in [What is loaded, and when](#what-is-loaded-and-when).

## The package

```json
{
  "name": "my-extension",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./index.ts"] },
  "pithagoras": {
    "client": "./web/client.js",
    "style": "./web/client.css",
    "server": "./server.js",
    "themes": [{ "id": "dusk", "name": "Dusk", "dark": { "accent": "#ff79c6" } }]
  }
}
```

- **`name`** is what everything goes by: the entries it registers, its
  messages, its addresses (`/api/x/<name>/…`, `/x/<name>/<page>`). An npm name,
  with or without a scope.
- **`pi`** is what the package brings pi: its extensions, skills, prompts and
  themes, as any pi package names them. A Pithagoras extension is a pi package,
  installed with `pi install`, so it always has the key, empty when it brings
  pi nothing (`"pi": {}`). Without the key and without pi's own folders
  (`extensions/`, `skills/`, `prompts/`, `themes/`), pi takes the package's
  folder for an extension, cannot load it, and does not start.
- **`client`** is a JavaScript module for the browser. The folder it is in is
  the package's web folder: the portal serves that folder, and nothing else of
  the package, to whoever is signed in. So the module has a folder of its own;
  one at the package's root is not loaded. Pictures and further modules in the
  folder are fetched relative to it (`new URL("./logo.svg", import.meta.url)`),
  and a heavy part can be loaded when first needed with `import("./big.js")`.
- **`style`**, in the same folder, is a stylesheet loaded with it.
- **`server`** is a JavaScript module for Node, anywhere in the package.
- **`isolated`**, `true`, runs the server half in a process of its own, where
  a loop that never ends or memory that grows without end ends that process
  and not the portal's. A package installed from an extension's data folder
  always runs so, however it was installed: see
  [A server half in a process of its own](#a-server-half-in-a-process-of-its-own).
- **`themes`** are [colours in place of the portal's own](#themes), with no
  code at all.

Both modules are loaded as they are: plain JavaScript, or the output of your
own build.

## The browser half

Its default export is called once, with the portal. It may return a function,
called when the extension is taken out of the page; what it registered goes
with it either way.

| `portal.` | |
| --- | --- |
| `React` | The portal's own React. Components are made with it, so that their hooks work |
| `slots.register(slot, entry)` | Puts an entry into a [slot](#slots). Returns what takes it out |
| `chats.use(chatId, pick?)` | A hook: [the chat as the page has it](#the-chat-s-events) |
| `chats.on(chatId, handler)` | The same outside a component |
| `chats.useEvents(chatId)` | A hook: any chat's events by its id, streamed while the component is drawn, as the page streams the chat on screen: `{ events, status, loading, missing }`. For drawing another chat beside the one on screen, such as a [child chat](#child-chats)'s run with `ui.Transcript`. The latest part of a long one; nothing without an id |
| `panels` | [Any panel of the chat on screen](#panels-and-commands), by name |
| `commands` | [What can be asked of an extension by name](#panels-and-commands) |
| `api.json(url, init?)` | A request as the portal's own are made |
| `api.url(path)` | The address of a route of the package's [server half](#the-server-half) |
| `server.on(handler)` | What the server half [says to this page](#telling-the-pages-open-on-a-chat) |
| `t(text, vars?)`, `locale` | [Its texts in other languages](#other-languages) |
| `theme` | [Themes](#themes): add one, switch to one, follow the one in effect |
| `ui` | [The portal's building blocks](#looking-like-the-portal) |
| `navigate(path, options?)` | Goes to a page of the portal: `/s/<chat id>`, `/x/<package>/<page id>`, `/settings/x/<package>`. With `{ replace: true }`, in the place of the page shown in the browser's history, not as a step of its own |
| `useLocation()` | A hook: the page's address, `{ path, search }`, drawn again when it changes, Back and Forward included ([a page that keeps what it shows in its address](#a-page)) |
| `extension`, `version` | The package's name; the version of this interface, `1` |

### Components

A component is a function made with `portal.React`. Without a build that
means `React.createElement`, as above. With a build, write TypeScript and JSX
and import React as usual: see [Writing it in TypeScript](#writing-it-in-typescript).
Either way it is the portal's React, never a second one: two Reacts in one page
do not share hooks.

The portal wraps each component so that it is drawn again only when what it is
handed changes. The chat around it is drawn again with every token of a reply;
your panel is not, unless it [asks for something that changed](#the-chat-s-events).

### Writing it in TypeScript

`@pithagoras/extension-api` is the contract between the portal and an
extension, and what an extension written in TypeScript and JSX is built with:

- its types are what the portal gives (`Portal` for the browser half,
  `ServerPortal` from `@pithagoras/extension-api/server` for the server half),
  and the portal itself is checked against them when it is built;
- `@pithagoras/extension-api/build` bundles `src/client.tsx` into the module
  the portal loads, `web/client.js`, with the stylesheet the code imports beside
  it (`web/client.css`) and each `import()` as a chunk fetched only when it is
  asked for.

```js
// build.mjs
import { buildExtension } from "@pithagoras/extension-api/build";
await buildExtension({ dir: import.meta.dirname });
```

```json
{
  "pi": {},
  "pithagoras": { "client": "./web/client.js", "style": "./web/client.css" },
  "scripts": { "build": "node build.mjs" },
  "devDependencies": { "@pithagoras/extension-api": "^0.2.0", "esbuild": "*" }
}
```

```tsx
// src/client.tsx
import { useState } from "react";
import type { Portal } from "@pithagoras/extension-api";
import "./client.css";

export default function (portal: Portal) {
  function Counter() {
    const [count, setCount] = useState(0);
    return <button onClick={() => setCount(count + 1)}>Count {count}</button>;
  }
  portal.slots.register("chat.panel", { id: "counter", title: "Counter", component: Counter });
}
```

The bundle has no React of its own. `react`, `react/jsx-runtime` and
`react-dom` are the portal's: it hands them to every extension before it loads
any extension's module, and the build points those imports there. Any other
package the code imports is bundled into it. The build drops the types
without checking them: `tsc --noEmit`, run before `node build.mjs`, checks
them, with the TypeScript, type packages and `tsconfig.json` that
[Extensions in their own repository](#extensions-in-their-own-repository)
gives. What the build makes is not kept in this repository's git: the
portal's own build makes it. An extension of your own is built in the folder
it is installed from, published built, or committed built to be installed
from git, as that section shows.

A part that is large and not always needed goes in a chunk of its own, fetched
when it is first drawn. Load it with `portal.ui.lazy`, not React's `lazy`: a
chunk that cannot be fetched (the extension was updated after the page was
opened) is then said so by `ui.PartFailed` with a way to reload, as the
portal's own parts are.

```tsx
// In the module's default export: the terminal's Shell tab and its emulator.
const Shell = portal.ui.lazy(() => import("./Shell"), "Shell");
// Drawn in Suspense, inside ui.ErrorBoundary with ui.PartFailed as its fallback.
```

The server half can be written in TypeScript as well: `server` names its
module, and the build bundles it into `server.js` beside `package.json`, with
the packages it imports left to be imported where it runs (a native one cannot
be bundled).

```js
await buildExtension({ dir: import.meta.dirname, tailwind: true, server: "src/server.ts" });
```

`extensions/terminal` and `extensions/git` in the repository are extensions
written this way; Git builds its server half and its utilities too.

### Looking like the portal

The page's colours are variables holding the three numbers of a colour, so
`rgb(var(--fg))`, and likewise `--canvas`, `--surface`, `--raised`, `--line`,
`--fg-muted`, `--fg-subtle`, `--fg-faint`, `--accent`, `--accent-fg`, `--ok`,
`--warn`, `--danger`, and `--terminal` with `--terminal-fg` for a terminal's
ground and text. A stylesheet written with them follows the theme, the
portal's own or [one an extension brought](#themes). Give your class names a
prefix of your own: the stylesheet is the page's.

While the portal's [animations](/guide/interface#animations) play (the switch in
Settings → This browser is on, and the system does not ask for less motion),
`<html>` has `data-motion="fancy"`, and it has none while they do not. Put a
flourish of your own under it, and it follows the switch as the portal's do:

```css
:root[data-motion="fancy"] .my-screen { animation: my-screen-in .6s ease-out backwards; }
```

`portal.ui` is what the portal's own pages are made of:

| | |
| --- | --- |
| `Markdown` | Markdown as the conversation draws it. A link is a button that asks before it opens the address in a new tab; `components={{ a }}` draws the links instead, with the `href` and `children` of each (one to a page of the extension's own, opened there) |
| `Select`, `Switch`, `SwitchRow`, `Segments`, `Field` | Controls and their labels |
| `PageHeader`, `Stat`, `Section`, `CollapsibleSection` | The card at the top of a page, and sections under it |
| `Empty`, `ErrorBanner`, `WarnBanner`, `LoadFailed` | Nothing to show; something wrong; could not be fetched, with a retry |
| `RowsSkeleton`, `SkeletonGroup` | Placeholders while something loads |
| `ErrorBoundary`, `PartFailed` | A part that fails to draw, failing alone |
| `StatusDot` | A chat's state as a dot |
| `ToolLink`, `ImagePreview` | A link on a call's card; a picture as the conversation shows one a tool makes ([a tool's call](#a-tool-s-call)), which `pictureId` marks for a viewer's `anchor` to find |
| `Transcript` | A conversation drawn from its events as the chat draws its own: `events` (a chat's, as `portal.chats.use` has them, `portal_prompt` for what was asked), `running` while it is still written, `chat` for an extension's own card of a tool (`chat.tool`) to be drawn as in that chat, `empty` while there is nothing yet. The rows only: the box that scrolls them is yours ([beside the conversation](#beside-the-conversation)) |
| `TrayChip`, `Ring`, `Shimmer` | A chip in the running tray as the portal draws a job there (`icon?`, `label`, `detail?`, `since?` counted from, `title?`, `onClick?`); the ring that spins beside what runs; text that shimmers while it goes on |
| `ImageViewer` | The portal's picture viewer, over the page: the `pictures` to step through, each `{ id, src, alt, caption?, fileName?, from? }` (`from` the `id` of the picture it was edited from), opened at `startId`, with zoom, Open in a new tab and Download. `actions(picture)` are more buttons beside Close for the picture shown, and `anchor(id)` the element focus goes back to when it closes |
| `Modal` | A dialog over the page, as the portal's own (`title`, `subtitle?`, `footer?`, `wide?`): Escape and a click beside it close it, after asking when `unsaved` says something typed in it is not saved |
| `DetailsGroup` | A group of settings that folds, as Settings' own: its `title`, and a `summary` of what is set in it while it is folded. Settings' search opens it when what it finds is in it |
| `useUnsavedDraft(unsaved)` | A hook: this part of a dialog (a page in Settings, a `Modal`) holds something typed and not saved, so closing the dialog asks first |
| `confirm(options)` | A question asked over the page; resolves true for yes |
| `classes` | The look of the portal's fields and buttons as class names: `input`, `inputSmall`, `codeArea`, `button`, `primary`, `primarySmall`, `ghost`, and `viewerButton` and `iconButton`, the buttons over a picture and in a viewer's head (`aria-pressed` is drawn as chosen) |
| `copyText(text)` | Copies, over plain HTTP as well |
| `asksBeforeDeleting()` | Whether the person wants to be asked before something is deleted (Settings → This browser): ask first when it is true |
| `storage.local`, `storage.session` | The browser's storage, which never throws |
| `useFollowBottom`, `useNow`, `tabKeys` | A box that follows its end; the time, each second; arrow keys for a row of tabs |
| `useLeaveRef(how)` | A hook: the ref for the one element a part draws, so that when it goes a picture of it leaves as the portal's own do, `how` saying as what: `"dialog"`, `"menu"`, `"panel"`, `"row"`, `"message"`, `"page"`, or `"gone"` for something that no longer exists. It plays only while the person has [the animations](/guide/interface#animations) on. `how` may be a function, asked as the element goes, that says `null` for not this time |

`portal.format` writes numbers, dates and times the page's language's way
(`number`, `date`, `dateTime`, `time`), and how long something has run as the
chat says it: `format.elapsed(seconds)`, "42s", "3m 05s".

The portal's own utility classes (Tailwind) exist only for what the portal
itself uses, so do not rely on one being there. Style your markup in your own
stylesheet, or have the build make the utilities your code uses: with
`tailwind: true`, `buildExtension` reads `src/` for class names and adds the
utilities they are to `web/client.css`, after your own rules. They are made
with the portal's preset, `@pithagoras/extension-api/tailwind`, so
`bg-surface`, `text-fg-muted`, `border-line`, `bg-accent`, `text-danger`,
`rounded-xl` and `shadow-pop` are the portal's colours, rounding and shadow and
follow the theme. Tailwind's reset of the page is left out: the page has the
portal's. The utilities reach only your own parts: the portal draws each part
you register inside an element marked with your package's name
(`data-extension`, laid out as if it were not there), and the build scopes each
utility to it. The portal's utilities go by the same names, and yours, coming
after them, would otherwise win over its own on every page (a `.flex` over an
`md:hidden`). What you draw through React's `createPortal` (a viewer over the
whole page, say) is not inside that element, so put it in one of your own, for
your utilities to reach it:

```tsx
createPortal(<div data-extension={portal.extension} style={{ display: "contents" }}>{viewer}</div>, document.body);
```

Inside your parts the same order holds: a utility your code uses comes after
all of the portal's, so where a `ui.classes` string has it beside a variant for
a wider screen (`h-10 sm:h-9`), yours wins over that variant on a button of
yours with the class, at every width. Write such a size another way
(`size-10`, `h-[2.5rem]`); the build finds class names in comments too.

tailwindcss and postcss are then the extension's to install, beside esbuild.

## Slots

A slot is a place in the portal with a name. Every entry has an `id`, which
names it among your package's entries in that slot, and a `component`. `order`
puts it before entries with a higher one, or none.

| Slot | Where | Entry | The component is given |
| --- | --- | --- | --- |
| `chat.panel` | Beside the conversation, docked, floated and sized like Files and Git | `title`, `icon?`, `header?`, `actions?`, `useButton?`, `name?`, `bleed?` | `chat`, `channel`, `panels`, `close()`, `panel` |
| `chat.header.action` | The chat's header, before the panels' buttons | | `chat`, `channel`, `panels` |
| `chat.tool` | A call of one tool in the conversation, in place of the portal's card | `tool` (its name), `tile?` (drawn small on its card in voice mode), `describe?` (what that card says of it) | `chat`, `channel`, `panels`, `call`, `card` |
| `chat.tool.action` | On the portal's card of a call, under what it returned, when the card is opened; with `head`, beside the card's head, folded or not | `tool?` (a name or a pattern; every call without it), `head?` | `call`, `cut`, `panels` |
| `chat.composer.above` | Above the message box | | `chat`, `channel`, `panels` |
| `chat.tray` | The running tray above the message box, before the chat's jobs and statuses: chips for what you have going in the chat | | `chat`, `channel`, `panels` |
| `chat.model.menu` | A row in the chat's model menu, under the models | | `chat`, `models` (those the menu lists, each `{ provider, id, name? }`) |
| `chat.overlay` | Over the chat, placed by you | | `chat`, `channel`, `panels` |
| `chat.background` | Nowhere: there while the chat is on screen, drawing nothing | | `chat`, `channel`, `panels` |
| `voice.window` | A window in voice mode, placed and sized like the portal's own | `title`, `icon?`, `place?`, `maximizable?`, `keepLoaded?`, `useAutoOpen?`, `useButton?`, `opensFor?`, `describe?` | `chat`, `channel`, `panels`, `close()`, `opened`, `maximized`, `maximize()`, `restore()` |
| `voice.avatar` | The agent in voice mode, where the orb is, for each agent whose avatar it was chosen as in the Avatar dialog | `title`, `description?` | `agent`, `mode`, `levels`, `still`, `orb` |
| `nav.page` | A page at `/x/<package>/<id>`, with an entry in the sidebar | `title`, `icon?`, `useShown?` | |
| `settings.page` | Your package's page in Settings, at `/settings/x/<package>`, above the fields the portal found for it | `title?` and `icon?`: its entry in Settings' list, in place of the package's name and the mark every extension has; `search`: what Settings' search finds on it, each `{ title, section?, words? }`, `section` being the heading it goes to | |

`chat` is `{ id, title, workspace }`. `channel` reaches
[your pi extension in that chat](#talking-to-your-pi-extension). `panels` is
your own panels there: `isOpen(id)`, `open(id, params?)`, `close(id)`. `icon`
is a component that draws an `<svg>`; the portal sizes it.

A component in a chat is made anew for each chat, so its state is that chat's.

### A panel

Two panels fit beside a conversation. A third closes the one open longest,
whoever brought it.

```js
portal.slots.register("chat.panel", {
  id: "notes",
  title: "Notes",
  icon: NoteIcon,
  component: NotesPanel,
  // In the panel's head, where its title would be: tabs, a count.
  header: NotesTabs,
  // In the panel's head, before its close button.
  actions: NotesActions,
  // A hook, called as the chat's header is drawn: how its button is for this chat.
  useButton: ({ chat }) => {
    const count = useCount(chat.id);
    return { hidden: false, live: false, title: count ? `Notes (${count})` : "Notes" };
  },
});
```

`useButton` may return `hidden` (no button until there is something to open:
the subagent extension's Subagents button is like this), `live` (a dot that
says something in it is running) and `title`.

`bleed: true` is for a panel whose body is filled by what it draws, a frame or
another program's screen, as the browser's is: its body is black from edge to
edge and does not scroll, so nothing of the portal's surface shows around it or
while it loads.

```js
// Another program's screen in a frame, with a Fullscreen in the panel's head.
portal.slots.register("chat.panel", {
  id: "screen",
  title: "Screen",
  bleed: true,
  actions: ({ panel }) => h("button", { onClick: () => panel.fullscreen() }, "Fullscreen"),
  component: () => h("iframe", { src: portal.api.url("/screen/"), style: { flex: 1, border: 0 } }),
});
```

The body, `header` and `actions` are each handed `panel`, the panel's say over
itself:

| `panel.` | |
| --- | --- |
| `params` | What it was last opened with: `panels.open("notes", { draft })` |
| `state`, `setState(next)` | Shared by the body and what is in the head, and kept while the panel is open: which tab is shown |
| `keep(true)` | It is not the one closed to make room for a third: there is something in it that would be lost |
| `guardClose(fn)` | Asked before it is closed by hand; it stays open if `fn` answers false. `null` to stop asking |
| `open(name, params?)` | Opens another panel from this one, as `portal.panels.open` does, but this one is not the one closed to make room for it: Git opening a file it lists in Files |
| `fullscreen()` | Shows the panel, its head and body, on the whole screen, where the browser lets a page, as the browser's Fullscreen does: the panel beside it stays where it is. Escape gives it its place back, and closed, it leaves the screen. A browser allows it only for something the person did, a click, and only while the panel is open: otherwise nothing happens |

```js
// A note being written would be lost.
React.useEffect(() => {
  panel.keep(writing);
  panel.guardClose(writing ? () => portal.ui.confirm({ title: "Discard the note you were writing?", confirmLabel: "Discard", danger: true }) : null);
}, [writing]);
```

### A tool's call

```js
portal.slots.register("chat.tool", { id: "note", tool: "note", component: NoteCall });

function NoteCall({ call, panels, card }) {
  // While it runs, and when it failed, the portal's own card says it best.
  if (call.status !== "done") return card;
  return h("div", { className: "pn-call" }, String(call.input.text), h("button", { onClick: () => panels.open("notes") }, "Open Notes"));
}
```

`call` is `{ name, callId, status, input, output, details, files, since,
interrupted }`: what the tool was called with, what it has returned so far as
text, its result's `details`, and the [files it gave](#files-a-tool-gives) once
it ended, each `{ path, kind, title?, from?, url }`. `since` is when it started
running, as `Date.now()` counts, for how long it has taken; `interrupted` is set
when the run ended with the call still open, which never said how it came out.
`card` is the portal's own card for the call, with those files drawn under it,
to return as it is or to draw beside something of your own. A card that leaves
`card` out draws the files its own way, from `url`.

A picture the call gave also has `open()`, which opens the chat's picture
viewer at it, with the conversation's other pictures to step through.
`ui.ImagePreview` draws a picture as the conversation draws one a tool makes:
the place it will be in while it is made (`state: "making"`, with `elapsed`
seconds), the picture once it is there, or why it is not. Given the file, it
shows it and opens the viewer when clicked:

```js
function PictureCall({ call, compact }) {
  const picture = call.files?.find((f) => f.kind === "picture");
  const state = call.status === "running" ? "making" : picture ? "done" : "failed";
  const elapsed = call.since && Math.floor((Date.now() - call.since) / 1000);
  return h(portal.ui.ImagePreview, { state, file: picture, title: String(call.input.prompt ?? ""), elapsed, reason: call.interrupted ? "Interrupted" : call.output, compact });
}
portal.slots.register("chat.tool", {
  id: "picture",
  tool: "make_picture",
  component: PictureCall,
  tile: (props) => h(PictureCall, { ...props, compact: true }),
  describe: (call) => ({ label: portal.t("Making a picture"), detail: String(call.input.prompt ?? "") }),
});
```

`tile` is drawn small on the call's card in voice mode, in place of the mark
that says how it stands (`ui.ImagePreview` takes `compact` for that size), and
`describe(call, chat)` is what that card says of the call, `{ label, detail? }`,
in place of the portal's words for a tool it does not know ("Using make
picture"). Media's cards say "Making a picture" and what it is of. A card with
nothing of its own to draw but those words can return `card` as it is.

### An action on a call's card

Where the portal's own card is right for a call and you only have something to
add to it ("Open in the terminal"), register an action for the tool. It is
drawn on the card, under what the call returned, once the card is opened, in
the conversation and wherever else the portal draws the card.

```js
portal.slots.register("chat.tool.action", {
  id: "open",
  tool: /^(bash|shell)$/,
  component: ({ call, cut }) =>
    call.callId ? h(portal.ui.ToolLink, { onClick: () => portal.panels.open("my-shell", { callId: call.callId }) }, cut ? "Show all of it" : "Open in My shell") : null,
});
```

`cut` says whether the card shows only the end of the output, and `chat` is
the chat whose conversation the card is in: a card elsewhere, such as in a
subagent's run, has none, for an action that is only about the chat's own
calls. `ui.ToolLink` is the portal's own look for a link on a card. Draw
nothing for a call you have nothing for. The `panels` the component is given are your own, by id;
`portal.panels` reaches any panel by name, as `my-shell` above is reached by
the `name` its `chat.panel` entry gave it.

A way in that should not wait for the card to be opened goes beside the card's
head instead, with `head: true`: there with the card folded, as a small pill.
The subagent extension's *Watch* is one, on any call that started a subagent,
so it leaves out `tool` and draws nothing on the others:

```js
portal.slots.register("chat.tool.action", {
  id: "watch",
  head: true,
  component: ({ call, chat, panels }) => {
    const id = portal.chats.use(chat?.id ?? "", (feed) => agentFor(feed, call.callId));
    return id ? h(portal.ui.ToolLink, { onClick: () => panels.open("agents", { id }) }, call.status === "running" ? "Watch" : "Open") : null;
  },
});
```

### Beside the conversation

Two more places in the chat are for what an extension has going there.

**The running tray** (`chat.tray`), just above the message box, holds chips
before the chat's background jobs and statuses: one for each thing at work,
which opens where it is shown. `ui.TrayChip` draws one as the portal draws its
own, with the time counting from `since`. Draw nothing while nothing is going:
the tray is shown only while something in it is drawn.

```js
portal.slots.register("chat.tray", { id: "running", component: ({ chat, panels }) => {
  const running = portal.chats.use(chat.id, runningOnes);
  return running.map((one) => h(portal.ui.TrayChip, { key: one.id, label: one.name, detail: one.doing, since: one.since, onClick: () => panels.open("mine", { id: one.id }) }));
} });
```

**The model menu** (`chat.model.menu`) has a row of yours under the chat's
models: something else of the chat's that runs on a model. It is given the
chat and the models the menu lists. The menu draws it as it opens, so fetch
what it shows with the chat (a [`chat.background`](#a-part-that-only-listens)
entry), not then: a row that arrives a moment later pushes the menu about.

`ui.Transcript` draws a conversation from its events as the chat draws its own
— what was asked, the replies and their thinking, each call on its card,
compactions — for one that runs beside the chat, such as a subagent's. Hand it
the events in the shape a chat's are (a prompt as `portal_prompt`); the box
that scrolls it is yours, with `ui.useFollowBottom` to keep it at its end.

### A window in voice mode

A `voice.window` has a button in voice mode's toolbar. More fields say how it
behaves beside the portal's own windows:

- `place`: `"side"` or `"middle"`, where it goes when it has the choice, as the
  terminal's window goes to the side and the browser to the middle. Without it,
  it takes whichever place is left, as Files does.
- `useAutoOpen(props)`: a hook, called while voice mode is on in a chat. It
  returns a count, and the window opens each time the count grows: the number
  of commands the agent ran, say, from `portal.chats.use`.
- `useButton(props)`: a hook, called as the toolbar is drawn, while the window
  is open too (it has no button then): how the window's button is for this
  chat, as a panel's `useButton` says it in the chat's header. `hidden` leaves
  the button out while the window is closed (no button
  until there is something to see: the browser's is there only while a browser
  runs), `live` puts a dot on it that says something in it is running, and
  `title` is what it says when pointed at. A hidden window still opens for
  `useAutoOpen`, for a card `opensFor` says it is for, and for a shortcut.
- `opensFor(call, chat)`: whether the card of a call in voice mode opens this
  window when it is tapped. It is asked for the calls the portal's own windows
  are not for: a file's, a shell call's or a page's, which have none of the
  portal's, open the window that says it is for them (Files', the terminal's,
  Browser's). `chat.workspace` tells a path in the chat's folder from one
  elsewhere.
- `describe(call, chat)`: what the card of such a call says, `{ label, detail? }`,
  in place of the portal's words for a tool it does not know ("Using canvas
  write"): Canvases' cards say "Writing in a document" and its title. The
  `describe` of the tool's own [`chat.tool` entry](#a-tool-s-call), where it has
  one, is asked first.
- `maximizable`: its head gets a Maximize button, as the browser's has. The
  window then fills the stage, over the other windows and above the dock,
  until it is restored: by its button, by Escape, by being minimized, or by
  another window opening. Your component is told `maximized`, and can call
  `maximize()` and `restore()` itself.
- `keepLoaded`: once it has opened, it stays while it is minimized, hidden and
  out of reach, so a frame or a stream in it is not loaded again each time it
  opens. Without it, a minimized window is gone until it opens again.

Your component is told `opened`: what it was opened for, the last time it was,
a new object each time. `{ by: "person" }` with its button, `{ by: "work" }`
for what `useAutoOpen` counted, `{ by: "call", call }` for the card of a call
that was tapped, and `{ by: "open", params }` for your own
`windows.open(id, params)` in a shortcut. Files' window shows the file of a
tapped card this way, and the file the agent just changed when that is what
brought it up.

```js
portal.slots.register("voice.window", {
  id: "shell",
  title: "Terminal",
  place: "side",
  useAutoOpen: ({ chat }) => portal.chats.use(chat.id, (feed) => feed.events.filter((e) => e.type === "tool_execution_start" && e.payload.toolName === "deploy").length),
  opensFor: (call) => call.name === "deploy",
  component: Shell,
});
```

Escape pressed in a frame of your window's never reaches the stage: the frame
has the key. If your window can be maximized and shows a page of the same
origin, listen for Escape in the frame and restore the window there:

```js
function Viewer({ maximized, restore }) {
  const latest = React.useRef({ maximized, restore });
  latest.current = { maximized, restore };
  const hear = (frame) =>
    frame.contentWindow.addEventListener("keydown", (e) => {
      if (e.code === "Escape" && latest.current.maximized) latest.current.restore();
    }, true);
  return h("iframe", { src: portal.api.url("/view/"), onLoad: (e) => hear(e.currentTarget) });
}

portal.slots.register("voice.window", { id: "viewer", title: "Viewer", place: "middle", maximizable: true, keepLoaded: true, component: Viewer });
```

### An avatar in voice mode

A `voice.avatar` entry is something an agent can be drawn as in voice mode, in
place of the orb. Each agent's Avatar dialog (the palette on its avatar, on the
**Agents** page) has a row **Shown as** that lists the orb and every entry by
its `title` and `description`, both translated as a `title` is. An agent that
chose yours is drawn with your component wherever the portal shows its avatar:
on the voice stage, in the dialog's preview, on its card and on its page. The
orb is drawn in its place wherever yours cannot be: your package is not
installed, is switched off or has not loaded yet, it no longer registers that
entry, or your component throws or its chunk cannot be fetched. That failure is
shown in **Settings → Extensions**, and the agent keeps its choice. Do not
catch your own errors to draw something else: throwing is what brings the orb
back.

What is chosen is kept for the agent as `<package>/<id>`, at most 256
characters together. Keep an entry's `id` the same across versions, and the
agents that chose it keep it; register one entry for each thing there is to
choose (one for each character a person added, say), and take one out again with
what `register` returned when it is gone. Registering is live: the dialog lists
an entry as soon as it is registered.

Your component is given:

- `agent`: `{ id, name }`, the agent it is drawn for.
- `mode`: what voice mode is doing. `input` while the person is heard,
  `output` while the reply is played, `thinking` while the agent is at work and
  nothing is played (the stage says Transcribing, Thinking, Preparing your
  reply or Compacting context, and also for a moment between two phrases of one
  reply), `muted` while the microphone is off and nothing else goes on, and
  `idle` otherwise. While muted and at work, it is `thinking`.
- `levels`: `levels.current.input` and `levels.current.output`, from 0 to 1,
  what the microphone hears and what is played now. They change many times a
  second and your component is not drawn again for them: read them in an
  animation frame of your own, through `levels` each time. The object in
  `current` is replaced at times (when voice mode stops, and on every frame of
  the dialog's made-up voice), so one you kept no longer moves. Smoothing them
  is yours.
- `still`: `true` for a picture of the agent rather than voice mode: its card
  on the Agents page and the avatar on its page. `mode` is `idle` and the
  levels stay 0. Draw it once and keep nothing running for it: the Agents page
  shows one for every agent, and a browser keeps only about 16 WebGL contexts
  for a page, so draw a picture there rather than a live context.
- `orb`: the portal's orb for the same agent, in the same mode and with the
  same levels, to draw while you have nothing of your own to draw yet (a model
  still loading, a drawing context that was lost).

It is drawn in the orb's box, which is square and fills its parent. That box
changes size without your component being made again: up to 380 pixels in the
middle of the stage, `min(300px, 34%)` beside a window, 100 in its dock and 64 in its
dock on a phone, its width animated over 0.7 seconds. Follow it with a
`ResizeObserver` and apply the size inside your own animation frame, as the
orb does, or it flickers while it moves. On the stage you may draw past the
box, as the orb's glow does, by 3/14 of its size on each side. Off the stage
the box is the whole of the dark square it is drawn on, and what is past it is
cut: 112 pixels on the agent's card, where its name is just under it, 64 on its
page, and in the dialog's preview 220 beside the dialog's choices, or the
dialog's width above them on a phone. Pause while it is out of
view (an `IntersectionObserver`), and read
`matchMedia("(prefers-reduced-motion: reduce)")` for reduced motion: there is
no prop for it. Free what you hold (a GL context, its textures) when the
component is unmounted: when voice mode ends, the chat changes, the dialog
closes, another avatar is saved, or your package goes away.

With push-to-talk on, the person holds the avatar to talk. The box takes no
pointer events, and a press on something of yours that does take them still
reaches the box: do not stop it there.

A heavy part (a drawing library) goes in a chunk of its own with `ui.lazy`; the orb
is drawn while it is fetched.

```js
function Square({ mode, levels, still }) {
  const canvas = React.useRef(null);
  // Read in the frame, as the levels are: a new mode does not start the drawing again.
  const now = React.useRef(mode);
  now.current = mode;
  React.useEffect(() => {
    const el = canvas.current;
    const ctx = el.getContext("2d");
    let frame = 0, size = 0, seen = true, level = 0;
    const resized = new ResizeObserver(([entry]) => { size = Math.round(entry.contentRect.width * Math.min(devicePixelRatio, 2)); });
    const shown = new IntersectionObserver(([entry]) => { seen = entry.isIntersecting; if (seen && !frame) frame = requestAnimationFrame(draw); });
    const draw = () => {
      frame = 0;
      // Sized here, in the frame it is drawn in, not as the observer says it.
      if (size && el.width !== size) el.width = el.height = size;
      const { input, output } = levels.current;
      level += (Math.max(input, output) - level) * 0.3;
      const side = el.width * (0.4 + 0.5 * level);
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.fillStyle = now.current === "thinking" ? "#82bcff" : "#c9a2ff";
      ctx.fillRect((el.width - side) / 2, (el.height - side) / 2, side, side);
      // A picture is drawn once it has its size, and then left.
      if (seen && (!still || !size)) frame = requestAnimationFrame(draw);
    };
    resized.observe(el);
    shown.observe(el);
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); resized.disconnect(); shown.disconnect(); };
  }, [levels, still]);
  return h("canvas", { ref: canvas, style: { position: "absolute", inset: 0, width: "100%", height: "100%" } });
}

portal.slots.register("voice.avatar", { id: "square", title: "Square", description: "A square that follows the voice", component: Square });
```

### A page

A `nav.page` is at `/x/<package>/<id>`, with an entry in the sidebar. The
entries of every extension are together in one group, **Extensions**, after
the portal's own pages and before **Audit**, which stays last. The group folds
like a folder, is remembered per browser, and is held open while one of its
pages is showing. On the folded sidebar it is one puzzle button, before the
one for Audit, that opens a menu of the pages. With no page, there is neither.
`useShown()` is a hook, called as the sidebar is drawn:
whether the entry is listed now. Use it for a page whose service is not set
up, as the browser's page is not listed before there is a browser. Until it
returns `true` the entry is not listed; the page is at its address either way.

A page that keeps what it shows in its address (a filter, so that a link keeps
it and Back goes through it) reads the address with `portal.useLocation()`,
which draws it again whenever the address changes, Back and Forward included,
and changes it with `portal.navigate`. Each change is then a step in the
browser's history; one that should not be, such as taking out a part of the
address that has been read, is made with `{ replace: true }`:

```js
function Gallery() {
  const { path, search } = portal.useLocation();
  const show = new URLSearchParams(search).get("show") ?? "all";
  const choose = (next) => portal.navigate(next === "all" ? path : `${path}?show=${next}`);
  // …
}
```

[Media](/guide/media)'s page, at `/x/pithagoras-media/media`, keeps its
gallery's filters so. Your package's page in Settings is at
`/settings/x/<package>`, and `portal.navigate("/settings/x/<package>")` opens
Settings there, from a page that says something is not set up.

### A part that only listens

`chat.background` is for what must happen while the chat is on screen whether
or not a panel is open: opening your panel when there is something to see.

```js
portal.slots.register("chat.background", { id: "watch", component: ({ chat, panels }) => {
  React.useEffect(() => portal.server.on((chatId, data) => {
    if (chatId === chat.id && data.type === "created") panels.open("canvas", { id: data.id });
  }), [chat.id, panels]);
  return null;
} });
```

## The chat's events

`portal.chats.use(chatId, pick?)` is a hook that gives a component the chat as
the page has it:

| | |
| --- | --- |
| `events` | The chat's own events as they came: pi's (a message as it streams, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `agent_start`, `agent_end`) and the portal's (`portal_*`). Each is `{ seq, type, at, payload }` |
| `items` | The conversation made of them, as the portal draws it: messages, tool calls with their output, notices |
| `calls` | The tool calls that have not ended, oldest first: the ones the model is writing now, and the ones it has written that are running. Each is `{ name, callId, status, input, output?, details? }`, as a `chat.tool` card's `call` is (see [below](#a-call-as-the-model-writes-it)) |
| `call(callId)` | A call of the conversation by its id, ended or not: to follow one from `calls` to how it came out |
| `running` | The agent is at work |
| `status` | How the chat stands: `"idle"`, `"running"`, or stopped by `"error"` or by hand (`"interrupted"`). After those two, a call that has not ended will not |
| `loading` | The conversation is still being fetched |
| `background` | What runs in the chat besides the conversation, asked of the portal while the chat is on screen: `{ supported, jobs, statuses, widgets }`. `jobs` are the commands the agent left running, each `{ key, command, state, startedAt, pids, hasOutput, attached }`; `statuses` and `widgets` are what pi's extensions show in its footer |
| `refreshBackground()` | Asks for `background` again at once: after a job was stopped (`POST /api/sessions/<chat>/background/<key>/stop`) or the finished ones cleared (`…/background/clear`) |

A tool call among `items` is `{ kind: "tool", id, name, callId, status, args,
output, details }`, with `status` going from `"running"` to `"done"` or
`"error"` and `output` growing as the tool reports. That is all a terminal
needs to show what the agent runs:

```js
const shell = (feed) => feed.items.filter((item) => item.kind === "tool" && item.name === "bash");

function AgentTerminal({ chat }) {
  const runs = portal.chats.use(chat.id, shell);
  return runs.map((run) => h("pre", { key: run.id }, `$ ${run.args.command}\n${run.output ?? ""}`));
}
```

::: tip Say what you use
A chat changes with every token of a reply. With `pick`, the component is
drawn again only when what it picked is no longer the same (the same value, or
a list or object of the same values). Without it, with every change. The panel
above is not drawn again while the agent writes its answer, only when a shell
call starts, reports or ends.
:::

Of a long conversation `events` and `items` hold the latest part, and more as
the person scrolls back. `portal.chats.on(chatId, handler)` is the same outside
a component, for a module that keeps something of its own from the chat.

### A call as the model writes it

A call in `calls` has `status: "writing"` while the model is still writing it:
its `input` is its arguments as far as they have come, a string cut where it has
come to, read again a few times a second rather than with each token, so that a
long one costs no more as it grows. It has not run yet, and may never (a call
the chat refuses ends at once). Once the model has written it, it is `"running"`
with all of its arguments, and it leaves `calls` when it ends, with what it
answered in `call(callId)`. A call through the lazy tools' gateway is the call of
the tool it calls.

That is all it takes to show what the agent is writing before the tool runs, as
Documents does (`extensions/docs/web/client.js`): the tool saves when it runs,
and until then the draft is the page's alone.

```js
const writing = (chat) => portal.chats.use(chat, (feed) => feed.calls.filter((call) => call.name === "note_write"));

function NoteDraft({ chat }) {
  return writing(chat.id).map((call) => h("pre", { key: call.callId }, String(call.input.text ?? "")));
}
```

It happens only in a page that has the chat open, from the stream the page has
anyway: nothing of it is done where nobody looks (a channel, a routine).

## Talking to your pi extension

What is drawn in a chat has a `channel` to the package's own pi extension in
that chat. On the pi side it is pi's event bus (`pi.events`), so the extension
needs no dependency on the portal, and outside it nobody is listening.

| Channel | Direction | Payload |
| --- | --- | --- |
| `pithagoras:v1:ui:send` | pi extension → its browser half | `{ extension, data }` |
| `pithagoras:v1:ui:receive` | browser half → pi extension | `{ extension, data }` |

`extension` is the package's name; every extension in a chat shares the bus,
so take only what carries yours. `data` is yours to define, and anything that
is JSON.

```ts
// index.ts
const NAME = "my-extension";

export default function (pi) {
  let notes = [];
  const tell = () => pi.events.emit("pithagoras:v1:ui:send", { extension: NAME, data: { type: "notes", notes } });

  pi.events.on("pithagoras:v1:ui:receive", (message) => {
    if (message?.extension !== NAME) return;
    if (message.data.type === "ready") tell();
  });
}
```

```js
// web/client.js, in a component
React.useEffect(() => {
  const off = channel.on((data) => data.type === "notes" && setNotes(data.notes));
  channel.send({ type: "ready" });
  return off;
}, [channel]);
```

Nothing sent either way is stored, and what the extension sends reaches only
the pages open on the chat just then. So a component asks where things stand
when it is drawn (the `ready` above), and the extension keeps its state where
pi keeps a conversation's: `pi.appendEntry()` for what the model should not
see, a tool result's `details` for what follows the branch.

### Slash commands

A slash command is the pi extension's to register (`pi.registerCommand`), as
in any pi package, and the portal's palette lists it with the rest. When the
command should do something in the page, its handler says so to the browser
half, which is there to hear it whether or not a panel is open:

```ts
// index.ts
pi.registerCommand("notes", {
  description: "Open this chat's notes",
  handler: async () => pi.events.emit("pithagoras:v1:ui:send", { extension: NAME, data: { type: "open" } }),
});
```

```js
// web/client.js
portal.slots.register("chat.background", { id: "commands", component: ({ channel, panels }) => {
  React.useEffect(() => channel.on((data) => data.type === "open" && panels.open("notes")), [channel, panels]);
  return null;
} });
```

`channel.send` starts the chat's agent if it had been let go, so a panel
opened on such a chat reaches its extension after a moment. What an extension
sends on its own clock does not count as use of the chat. `channel.send`
rejects where the chat's agent does not run in the portal's process, which is
every executor but `EXECUTOR=host`; no agent is started there to find that
out. For anything that must work there too, use
the server half.

## The server half

```js
// server.js
export default function (portal) {
  portal.router.get("/notes", (req, res) => res.json({ chats: allNotes() }));
  return () => { /* called when the package goes, or the portal stops */ };
}
```

It is loaded once, into the portal's own process, and stopped and started
again when the package is installed, removed, updated or switched. It runs
with the portal's rights, as the package's pi extension does. It is an ES
module (`"type": "module"` in `package.json`, or a `.mjs` file).

It has fifteen seconds to start and five to stop; one that takes longer is
given up on, with the reason beside the package in Settings → Extensions, and
nothing else waits for it. One that crashes, an error of its code that nothing
catches or a call of `process.exit()`, is stopped and held off, and the portal
and its chats go on: see [When the server half crashes](#when-the-server-half-crashes).
The first time the portal starts it, its files are loaded as Node loads
modules: anything else in the portal's process that imports one of them has the
same module. Each time it is started at another revision after that, after a
file of it changed (see [What is loaded, and when](#what-is-loaded-and-when)),
its files are read again, as modules of that revision's own: its module, and
every file of its module's folder that it imports by a relative address (`./`,
`../`) or a `file:` URL, as far down as the imports go.
Started again at the same revision (switched off and on, or after what it
builds on started again), it runs the modules already loaded: its default export
is called again, and what its modules keep at their top level is as it was.
What it imports by a bare name (its dependencies in `node_modules`, Node's own
modules), a file outside its module's folder, and a CommonJS file (a `.cjs`
file, a `.js` file of a package that is not `"type": "module"`, or anything
loaded with `require()`), imported or required, are read once for as long as
the portal runs, as Node reads modules: after an update that changes those,
restart the portal.

| `portal.` | |
| --- | --- |
| `router` | An Express router: the package's routes, at `/api/x/<package>/…`, behind the portal's login |
| `http.json()`, `http.raw()`, `http.text()` | Body parsers, for the routes that want one |
| `http.upgrade(handler)` | WebSocket upgrades under the package's routes |
| `http.endWithLogin(end)` | Ends a long response, such as a stream, when the login it was opened under ends (the password changed, single sign-on was set up anew), so what it showed is not shown to whoever signs in next. Returns what stops the watching, for a response that ended by itself |
| `http.send(req, res, file, options?)` | [Sends a file](#sending-a-file) opened by `files.open` as the portal sends its own: a version, the part a player asks for, or to be saved |
| `chats.get(id)`, `chats.list()` | A chat: `{ id, title, workspace, status, mode?, parent?, listed? }`. `list` leaves out the [child chats](#child-chats) made to be found by their id alone |
| `chats.folder(id)` | The folder the chat's pi works in, on this disk |
| `chats.inFolder(folder)` | The sessions of every kind that work in a folder: tasks, and also routine runs, Agent-page and channel conversations and heartbeats, which `chats.list()` leaves out and which have the package's tools in their pi. One for each agent that has some there (what an agent can reach is the same from each of its sessions; none is removed, and a stored path can be a link an agent made) |
| `chats.send(chatId, data)`, `chats.onOpen(fn)` | [Telling the pages open on a chat](#telling-the-pages-open-on-a-chat) |
| `chats.on("started" \| "stopped" \| "deleted" \| "finished", fn)` | A chat's pi started or stopped; the chat was deleted; or it is finished: the run it was started for is over, and the portal stopped its pi for good, as for a routine run in a session of its own. A person who goes on with the chat starts its pi again (`started`). A pi stopped for being idle is not finished: it starts again with the next message |
| `chats.onEvent(fn)` | Everything a chat's pi says, as it says it |
| `chats.tell(chatId, data)` | To the package's own pi extension in a chat (`pithagoras:v1:ui:receive`) |
| `chats.extend(factory)` | [Tools that share this module's state](#tools-that-share-the-server-half-s-state) |
| `tools.offer(fn)`, `chats.reload()` | [Tools that follow the settings](#tools-that-follow-the-settings): which of them it offers now, and the open chats given the change |
| `tools.exceptions(names)` | [Who has its tools](#who-has-its-tools): the chats and routines where those tools are not what the default says |
| `chats.offers(chatId, tool)` | How the chat's model is offered a tool now: `"direct"`, `"lazy"` (through the `tools` tool) or nothing (switched off, out of reach, or the chat's pi not running here). In a chat whose mode works through the code tool ([Code mode](/guide/sessions#modes)), `"direct"` means that a script calls the tool by its name, with no streamed arguments of its own |
| `chats.hold(chatId)` | Keeps the chat's pi from being let go for being idle, or reloaded, while work goes on; returns what lets it go |
| `chats.create(options)`, `chats.children(parent)`, `chats.prompt(chatId, message, options?)`, `chats.abort(chatId)`, `chats.remove(chatId)` | [Child chats](#child-chats): a chat of a chat, to give part of its work to, run until it answers, stopped and deleted |
| `sandbox.run(chatId, argv, options?)`, `sandbox.spawnAs(chatId)`, `sandbox.on()` | [Running things as the chat's agent](#running-things-as-the-chat-s-agent) |
| `sandbox.personEnv()` | The portal's environment for a process the person starts, such as a shell of their own: without the mark the agent's processes carry, so it is not listed as a job the agent left running |
| `files.inside(base, rel)` | A path checked to be inside a folder |
| `files.list`, `read`, `readBytes`, `write`, `create`, `rename`, `unsaved`, `remove`, `removeFile`, `renameFile`, `makeFolder`, `folder`, `identity`, `sweepTemp`, `open` | [A chat's folder](#a-chat-s-folder), read and changed with the portal's own checks |
| `folders.list()`, `folders.allowed(path)`, `folders.label(path)`, `folders.on("removed", fn)` | [The folders the agents work in](#the-folders-the-agents-work-in), what one is called, and when the portal deletes one |
| `git.at(folder)` | [git and gh in a folder](#git-in-a-chat-s-folder), run as the portal runs its own |
| `dataDir()` | [A folder of the package's own in the portal's data folder](#where-it-keeps-things), closed to everyone but the portal, by its real path |
| `handoffs.take(name)`, `handoffs.done(name)` | [What an upgrade left](#what-an-upgrade-left-for-it) when something the portal did itself became an extension's |
| `models.of(chatId?)`, `models.endpoint(provider, id)`, `models.list()` | [The models the chats use](#models): the one a chat is on, where a model is asked and with which key, and the providers set up by their address |
| `mcp.get(name)`, `mcp.set(name, entry, options?)` | [An MCP server](#mcp-servers) in pi's mcp.json, and whether the chats have its tools now |
| `memory.hold({ label, rule, on })` | [Holding the agent's memory](#the-agent-s-memory) in place of its MEMORY.md |
| `audit.record(entry)` | [A row in Audit](#a-row-in-audit) for something it did, under its name |
| `provide(factory)`, `extensions.use(name)` | [Building on another extension](#building-on-another-extension): what it gives the extensions that build on it, and what one it builds on gives it |
| `extensions.install(folder, options?)`, `extensions.remove(name)`, `extensions.status(name, options?)` | [Extensions it installs](#extensions-it-installs) from its own data folder, loads again and removes; and where an installed extension stands |
| `voice.provide(provider)`, `voice.choose(chosen)`, `voice.chosen()` | [Voice providers](#voice-providers): recognising and speaking for voice mode, with the voices it has; making it voice mode's source, and whether it is |
| `modes.provide(mode)` | [A chat mode](#chat-modes) the person can start a chat in |
| `log(text)`, `extension`, `executor`, `version` | A line in the portal's log; the package's name; how pi is run here; `1` |

### A server half in a process of its own

```json
"pithagoras": { "server": "./server.js", "isolated": true }
```

With `"isolated": true` the server half runs in a Node process of its own,
started for it by the portal. It is given the same `portal`, and each call it
makes that needs the portal (`chats.get`, `chats.send`, `modes.provide`, a
registration) is made in the portal's process, with the portal's own checks.
Its routes, upgrades and tools are handed on to its process and answered
there; `files`, `git` and `http.send` work in its process.

A package installed from an extension's own data folder (`dataDir()`) always
runs so, whether the extension installed it ([`extensions.install`](#extensions-it-installs))
or the person installed that folder by its path in Settings: an extension
writes such a package, maybe for an agent, and what it runs must not be able to
stop the portal.

What it protects the portal from:

- Code that never yields. The portal asks the process every second whether it
  can answer; one that has not answered for 10 seconds (a loop that never ends,
  a long synchronous call) is ended. A process that is busy but yields answers,
  and is never ended for being busy.
- Memory that grows without end. Its heap is capped at 512 MB (V8 ends a process
  that goes over), and on Linux one whose memory, as the system counts it, goes
  over 1 GB is ended. The kernel ends it, and what it started, first should the
  machine run out of memory.
- A crash of its own: an uncaught error, a rejection nobody heard, a call of
  `process.exit()`, a native addon that crashes, a signal.
- What it started: its process is a group of its own, and the whole group is
  ended with it.

Each of these is its crash, held as [any server half's](#when-the-server-half-crashes):
a request its routes had not answered is answered with `503` and the crash, a
tool's call that was pending answers at once with the crash and the half's last
lines, and it stays off until another revision is installed or it is switched
off and on. Its process is given a lower priority than the portal's, so a busy
half leaves the portal its share. A half that starts again at any revision is a
new process, which reads all of its files anew: see
[What is loaded, and when](#what-is-loaded-and-when).

What it cannot have, or has otherwise:

1. `provide`, and `voice.provide`, `voice.choose` and `voice.chosen`, throw.
   Nothing can build on such a half: one that requires it does not start,
   and one that has it as `optional` starts without it. It may build on an
   extension in the portal's process: `extensions.use` gives it the same
   object, whose functions each return a promise. A function it passes them
   (a callback) is called across; one in what they answer cannot cross.
2. In `chats.extend`, the `pi` a factory is given has `registerTool`, `on`,
   `registerCommand`, `sendMessage` and `sendUserMessage`, and nothing else of
   pi. It registers only while the factory runs, and the factory's promise is
   waited for, for five seconds at most: one that throws or takes longer is
   that chat's load error. A tool's `execute` is given no `ctx`, nor are its
   handlers and commands. A tool's definition is data: `renderCall` and
   `renderResult` are left out, and any other function in it
   (`prepareArguments`, say) is refused by name, and so is a tool named as one
   of pi's own (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`), which
   would take that tool's place in every chat. An event or an argument that
   cannot be copied fails that call.
3. What the portal asks of it at any moment, the tools it offers now
   (`tools.offer`) and whether it holds the agent's memory (`memory.hold`'s
   `on`), is worked out in its process and can be a second behind.
4. What a page that opens a chat is told first (`chats.onOpen`) reaches the
   page after the stream's first events, within two seconds or not at all.
5. A request's `req.socket`, `req.ip`, `req.secure` and `req.protocol` are
   those of the local connection the portal hands it on by, and its
   `req.originalUrl` and `req.baseUrl` are as its own routes see it: the path
   below `/api/x/<package>` (`/where?a=1`) and `""`, where in the portal's
   process they are the whole path and `/api/x`.
6. After it is started again, a chat that has not loaded since still has its
   tools of the process before: a call of one fails until that chat's next
   step, which has the new ones.
7. `extensions.install`, `remove` and `status`, and every call answered later,
   reject for a wrong argument where the half in the portal's process would
   throw.

It is no security boundary. The process is the portal's user, with the
portal's environment, and reaches what the portal reaches: it keeps an
accident from stopping the portal, not code that means to. Only the server half
runs apart: the browser half runs in the person's page, and a pi extension
(`pi.extensions`) in every chat's pi, in the portal's process. Outside Docker,
a process stuck in a loop can outlive a portal that was itself killed with
`SIGKILL`; under Compose (`init: true`) it goes with the container.

Each such half costs about 20 MB of memory of its own while it is idle (about
55 MB as the system counts a process, with what it shares with every Node
process), about 100 ms more to start, about 0.3 ms more for each request to its
routes, and about 30 µs more for each call that is answered at once, such as
`chats.get` (measured on Linux, Node 22).

### Routes

```js
portal.router.get("/chats/:id/files", (req, res) => {
  const folder = portal.chats.folder(req.params.id);
  res.json(portal.files.list(folder, String(req.query.path ?? "")));
});
// A body is read only where a route asks for it.
portal.router.post("/chats/:id/notes", portal.http.json(), (req, res) => { /* req.body */ });
// A route that takes a file reads the body itself, and saves it with portal.files (not req.pipe into a path built from the
// folder and a name: that follows a link the agent left there).
portal.router.post("/chats/:id/upload", async (req, res) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    if ((size += chunk.length) > 1024 * 1024) return res.status(413).json({ error: "At most 1 MB" });
    chunks.push(chunk);
  }
  const folder = portal.chats.folder(req.params.id);
  res.json(portal.files.write(folder, String(req.query.name), Buffer.concat(chunks), { create: true }));
});
```
A file that may be bigger than 1 MB, and has to be streamed to disk, has no call
in `portal.files` yet; do not build its path yourself, see
[A chat's folder](#a-chat-s-folder).

Routes are written from the package's own root. From the browser half,
`portal.api.url("/chats/a/files")` is their address and `portal.api.json` asks
as the portal's own requests do: JSON back, an `ApiError` with what was said
for one refused, and a login that has gone told to the page. The rest of a
path reaches your routes as it was written, to be read once: a file called
`what?.md` asked for as `what%3F.md` is `req.params.name === "what?.md"`.

A route can stream as well: write `text/event-stream`, or take an upgrade with
`portal.http.upgrade((req, socket, head) => …)`, which the portal has already
checked for the login and for the page it comes from. An answer held open is
ended when the portal's password changes, as the portal's own streams are.

### Where it keeps things

What a server half keeps for a chat it keeps where the chat's pi works: in the
chat's folder, `portal.chats.folder(id)`. The agent can read what is there, it
moves with the project, and it is gone when the folder is. Give it a folder or
a name of your own, check every path that came from outside with
`portal.files.inside`, and read and change what the agent may have written
there with `portal.files` (see [A chat's folder](#a-chat-s-folder)).

```js
const file = portal.files.inside(portal.chats.folder(chatId), `.my-extension/${chatId}.json`);
```

Several chats can work in one folder, so name what is one chat's by the chat.

What the portal itself must run on, and an agent must not be able to change, is
kept elsewhere: `portal.dataDir()` is a folder of the package's own in the
portal's data folder (`extension-data/<package>`, made when it is first asked
for, mode 0700). With the [sandbox](/guide/sandbox) on, the portal runs as
root and the agents run as users of their own: a git repository or a database
in a chat's folder is one an agent could change (a setting git reads, a file
SQLite opens) under the portal's rights, and one in this folder is not. It is
not part of the project: it is not copied with it and not deleted with it, so a
package that keeps something for a project here also has to know which project
that is (a folder can be moved, or deleted and made again).

```js
const store = path.join(portal.dataDir(), folderId);   // the portal's alone: nobody else can read or change it
```

It is given by its real path, whether or not the data folder is reached
through a link, so it can be the `base` of [`portal.files`](#a-chat-s-folder)
as a chat's folder is: `files.open(portal.dataDir(), "images/a1b2c3.png")`
opens a file of it with the same checks, to send with
[`http.send`](#sending-a-file).

[Documents](/guide/documents#where-the-history-is-kept) keeps its history there,
and [Media](/guide/media) its store, `media.db`, the pictures and clips made on
its page, and the small copies its galleries show.

#### What an upgrade left for it

When something the portal did itself becomes an extension's, the upgrade that
takes it out of the portal leaves what it had (its records, its settings, its
files) in the portal's data folder, under a name for what it was (`media`), for
whichever extension takes it up. Nothing of it is lost while none does: an
extension can be installed long after the upgrade, or never, and what was left
waits for it.

`portal.handoffs.take(name)` moves what was left under `name` into the
package's own folder, `<dataDir>/handoff-<name>`, and gives that folder's path;
nothing when nothing was left. The first package that asks has it, whole. It
stays there until `handoffs.done(name)` removes it, so a start that stopped
half way through reading it (the portal stopped, a disk was full) is given it
again by the next `take`. Read it so that reading it twice does no harm: move
in a file only where it is not there yet, put in a record only where one of its
id is not, and say `done` once all of it is in your own store.

```js
const dir = portal.handoffs.take("media");
if (dir) {
  const { rows } = JSON.parse(fs.readFileSync(path.join(dir, "images.json"), "utf8"));
  const put = db.prepare("INSERT OR IGNORE INTO images (id, path, prompt) VALUES (?, ?, ?)");
  db.transaction(() => rows.forEach((r) => put.run(r.id, r.path, r.prompt)))();   // a row that is there is left as it is
  portal.handoffs.done("media");
}
```

What is in it, and in what format, is said by the portal's upgrade that left
it. A name is small letters, digits, dots, dashes and underscores, from a
letter or a digit, at most 64. [Media](/guide/media) takes `media`, which
schema 7 left when Media became an extension: its rows, its settings, the
pictures and clips of its page and the copies made of them
(`extensions/media/src/server/handoff.ts` reads it). [Browser](/guide/browser)
takes `browser`, which schema 8 left: the browser's settings, its password among
them, and the profile of the machine's own Chrome
(`extensions/browser/src/server/handoff.ts`). [Voice](/guide/voice-service)
takes `voice-service`, which schema 9 left: the GPU chosen on its page, a setup
still to come up, whether its speech model is let go of once voice mode no
longer uses it, the voice settings and the voice library with its recordings
(`extensions/voice/src/server/handoff.ts`). [Voice servers](/guide/voice-servers)
takes `voice-addresses`, which the same schema left: the speech recognition and
speech synthesis addresses of the person's own
(`extensions/voice-servers/src/server/handoff.ts`).
[Understory](/guide/features#memory-understory) takes `understory`, which
schema 10 left: its four settings, the token its container was made with among
them (`extensions/understory/src/server/handoff.ts`).

### A chat's folder

Reading and changing what is in a chat's folder goes through `portal.files`,
not through `fs`. These are the portal's own functions (`workspace-files.ts`),
the ones it uses for uploads and pictures, and [Files](/guide/files) is built
on them. They are given to every server half because doing this by hand is
easy to get wrong in a way that is a hole, not a bug:

- **The agent writes there, links included.** A path a page sends is checked as
  text (no `..`, no way out by an absolute path) and again where every link
  along it really leads. `fs.readFile(path.join(folder, rel))` follows a link
  the agent left, `notes.md → /data/portal.db` say, to wherever it points.
- **A server half has the portal's rights, which can be more than the agent's.**
  With the [sandbox](/guide/sandbox) on, the portal runs as root and the agent
  as a user of its own. A file the agent cannot read, the portal can, and so
  can a server half that is led to it.
- **A check and an open are two steps.** Between them the agent can put a link
  where the file was, or where a folder on the way to it was, and the portal,
  which may be root, would then read, make or remove a file where the link leads.
  A file is opened without following a link in its last place (`O_NOFOLLOW`), and
  what is sent is read from what was opened, never by opening the path again. The
  folder it is in is held open too, walked down from the chat's folder one part at
  a time and never through a link, and the file is read, made and put in place in
  that folder, whatever happens to the path meanwhile. That holds on Linux, where a
  held folder can be named as `/proc/self/fd/<n>` (and a folder the portal may
  search but not read still works: it is walked through with `O_PATH`, and only
  its sync is left out); where there is no `/proc`
  (macOS) a folder on the way can still be swapped between the check and the
  call, and so the portal gives nothing it makes away there (below). A pipe left
  there does not hold the server, and a device is not read.
- **The agent can rename things.** With the [sandbox](/guide/sandbox) on, a folder or file the agent may not
  enter is root's alone (`root:root`, mode 0700 or 0600), and the sandbox closes a subtree only by its top folder:
  what is inside keeps the group's rights. The agent writes in its chat's folder, and a rename there needs only the
  right to write in that folder, so it can rename that folder to the name of one your half reads as root on its
  behalf (`documents`), or move that file into it, and your half would hand it what it could not read itself. Where
  your half keeps something under a name the agent can choose, pass `likeParent: true` and the ids of the chats whose
  agents work in the folder as `chats` (`folder`, `identity`, `list`, `read`, `readBytes`, `open`, `write`,
  `makeFolder`, `removeFile`, `renameFile`, `sweepTemp`): the folder, and the file in it, must be something every one of those
  agents could use itself. That is told as the kernel would tell it for the user and the groups the sandbox runs
  each as (its own and the sandbox group), from the owner, group and mode of what is held: the owner's bits if the
  agent's user owns it, else the group's if the group is one of the agent's, else everyone's. Who owns it says
  nothing (a project is root's too). Every folder of the path from `/` down to the folder must be one the agents may
  search, and none may be a link (a path that is a link now was swapped). What is read from a folder (`folder`,
  `list`, `read`, `readBytes`, `open`) needs the agents to read and search it, what is changed in it (`write`,
  `makeFolder`, `removeFile`, `renameFile`, `sweepTemp`) to write in it and search it, a folder that is held to (`identity`) both,
  and a file that is read (or replaced) to be readable by them; in a sticky folder (mode 1777) what is taken away,
  renamed or replaced must be their own. Otherwise the call is refused (`invalid`). It is checked on the folders as
  they are held, so it cannot be swapped in between. The agents are the ones of `chats`, not found from the folder's
  path, which the agent can lead into another agent's home with a link: the sandbox runs a chat's agent by the
  workspace stored for it, and so does this. Name every session that works in the folder (`chats.inFolder(folder)`: not
  the tasks of `chats.list()` alone, since the tools are in a routine run's, a conversation's and a heartbeat's pi too) and,
  for a call made for an agent, the session it comes from, always, whatever its own folder leads to by then. No chat
  named, or one that is not known, is a refusal while the sandbox is on. With the sandbox off the agent is the portal's own user, and nothing is refused. POSIX ACLs are not read
  (Node cannot, and the sandbox sets none): only the mode bits are asked, so an ACL a person put on a folder or file
  of a chat is not seen.
- **A save is put in place whole.** It is written beside the file and renamed
  over it, so a full disk leaves the file as it was, not empty. It keeps the
  file's mode and its owner, so a file the portal saved as root is still the
  agent's to change. With `expected`, the time the file was read at, a file
  the agent changed since is refused (`conflict`) rather than written over. A
  file with a second name (a hard link, which may be outside) is left alone.
- **A delete or a rename changes the link, not what it leads to**, never the
  folder itself, and a folder holding git work that exists nowhere else (changes
  not committed, commits no remote has, stashes) is refused (`unsaved`, with
  what it holds) unless `discard` says so. `unsaved(base, rel)` asks first, for
  a question that names it. Both are done in the folder the entry is in as it is
  held, not by its path, and `remove` holds it after git has answered: a folder
  it deletes is opened from the one it is in without following a link and
  emptied through what was opened, each folder in it the same way, so a link an
  agent puts where a folder was, at any depth, goes as the link it is and what
  it leads to stays.
- **A file of your own that you delete or rename goes by `removeFile` and
  `renameFile`, not by `remove` and `rename`.** Those two take one plain file and
  nothing else (a link or a folder is `invalid`, where `remove` takes the link or
  all of the folder), and are done in the folder as it is held, not by its path:
  the file goes from the folder that was checked, whatever its path leads to by
  then. `removeFile` is an `unlink` of the name, which never follows a link (what
  is swapped onto the name goes, and what it leads to stays) and never removes a
  folder (`EISDIR`: nothing is lost, where a recursive remove by path takes the
  folder and all in it). `renameFile` makes the new name a second name of the file
  (a hard link) and then takes the old one away: the system refuses the link in
  the call itself if something has the new name (`exists`, whatever the agent made
  there since the look), where `rename` puts the file over it; a name swapped for
  something else between the look and the call is `conflict`, and nothing is
  renamed. A crash between the two halves leaves one file with two names, never
  none. If the old name cannot be taken away, the new one is given up again,
  but never when it is the file's only name (a folder took the old name just
  before): the file is not deleted for that, and the rename stands. A new name
  that the file system does not tell from the old one (only capitals, or the
  form of a letter, differ: macOS, Windows, a casefold folder) is the old name
  itself, so it is `exists`. Where hard links cannot be made (a file system
  without them, or `protected_hardlinks` for a file that is not the portal's own)
  it is a rename after a look, with a short gap for a file that is made at the
  new name in between. `direct` and `alone` are options of both, as of `open`, and so are `likeParent` and `chats`
  (the folder must be one the agents could write in).
  `expect: { dev, ino }` is one of both as well: the folder the file is in must
  be that one, by its device and inode (what `stat` says of the folder, as numbers,
  text or bigint), or the call is `conflict` and touches nothing. A half that
  deletes or renames in a folder it decided on earlier keeps the identity of that
  folder and passes it: the check is made on the descriptor of the folder the
  call works in, so another folder swapped onto the path meanwhile (one the agent
  may not write in, which the portal, as root, could) is never changed.
- **A save lasts.** After the rename the folder is synced too, so a crash
  right after leaves the new file, not the old one. An upload and a file the
  portal makes are synced the same way.
- **Limits:** a file over 1 MB is not read or saved as text, and a folder with
  more than 2,000 entries is listed in part (`truncated`), cut before each is
  looked at, so a huge folder does not hold the thread every chat is served on.

`base` is a folder from `chats.folder`, `rel` the path the page sent. A refusal
throws an error with a `code`: `invalid`, `missing`, `conflict`, `exists`,
`too_large`, `failed` or `unsaved`. Answer it by that code rather than by its
sentence:

```js
const STATUS = { invalid: 400, missing: 404, conflict: 409, exists: 409, too_large: 413, failed: 500, unsaved: 409 };
portal.router.put("/chats/:id/file", portal.http.json(), (req, res) => {
  try {
    const folder = portal.chats.folder(req.params.id);
    res.json(portal.files.write(folder, String(req.query.path), req.body.content, { expected: req.body.mtime }));
  } catch (e) {
    if (e.code in STATUS) res.status(STATUS[e.code]).json({ error: e.message, code: e.code });
    else res.status(500).json({ error: "Could not save it" });
  }
});
```

What reads a whole folder, such as an archive, takes it from `files.folder`,
checked; a download is sent from the descriptor `files.open` gives. Files'
server half (`extensions/files/src/server.ts`) is a complete example.

**Bytes, and telling a file changed.** `read` gives text, and says "binary"
for a file with null bytes. For a file that is not text, or must come back
exactly as it was, `readBytes` gives a `Buffer`, and `write` takes one (a file
is still at most 1 MB). Both, and `open`, tell `change` and `mtime` as they
were when the file was opened; `write` answers with those of the file it wrote.
`change` is a text to keep and compare for equality, nothing more: it differs
when the file was written in place (its times) and when another file was put
there by a rename (its inode), so a page of notes can tell "unchanged" from
"changed" without reading the file. `head` reads only the start of a file
(`head: 0` none at all, for its `change`), and `open` keeps a descriptor that
reads the file as it was opened, whatever is put in its place after.

```js
const stamp = portal.files.readBytes(folder, "notes.md", { head: 0 }).change;   // no bytes read
if (stamp !== saved.change) {
  const { bytes, change } = portal.files.readBytes(folder, "notes.md");
}
```

For a file that is to be exactly what its name says, `direct` and `alone` are
options of `open` and `readBytes` (`direct` of `write` and `folder` too).
`direct` refuses a name that a link led somewhere else (even to another file in
the folder, which `inside` follows without a word), or that is a way, not a
name; a half that keeps its files in a folder of its own name in the chat's
folder asks `folder(base, "documents", { direct: true })` and is told when that
is a link. `alone` refuses a file with a second name. A refusal is `invalid`.

**What the portal makes is the agent's to edit.** A file that `write` makes
(not one it replaces), a folder that `makeFolder` makes and a file that is
uploaded have the mode, the owner and the group of the folder they are made in
(a file 0644, and group-writable where the folder is), and a folder is given
that through itself, never by its path, so that a link put in its place by the
agent meanwhile gets nothing. A new folder is made closed to everyone but the portal
and is given its mode and owner only if it is still the one that was made: `mkdir`
and the open of the new folder are two calls by its name, and an agent that writes
in the folder can swap another folder of it onto that name in between, so one that
holds anything, or is on another file system, is left alone and the name is
`exists`. The owner and the mode are the held folder's own,
read from its descriptor, and a file or a folder is given away only once it is
known to be in the chat's folder (Linux), so that a folder the agent swapped for
a link cannot make the portal, as root, hand the agent a file anywhere else. With
the sandbox on, the portal is root and the agent another user: what the portal made as
root would not be the agent's to change otherwise. Where the portal may not give
a file away (it is not root and the folder is someone else's), it stays its own,
in the group it can: it is group-writable only if that group is the folder's. A
portal on a system without `/proc` gives nothing away.

**Which folder it is.** A half that holds to a folder (Documents deletes and renames only in the folder it
holds to) needs to tell it from another that was put at the same path. `files.identity(base, rel)` is the folder's
device and inode as text (`{ dev, ino }`), read from the folder as it is held, so that it is the folder the checks
were made on and not what its path leads to by then. Two folders never have the same pair at once, a folder that
is moved keeps it and one that is deleted and made again does not; a number can be given to the next folder
made, so it says that a folder is the one it was while it exists, not for ever. It takes `direct` and
`likeParent` and `chats`: a folder the agent could not use is not given an identity, so a half that holds to what it is
given never holds to one the sandbox closed to the agent. Pass the identity as `expect` to `removeFile` and
`renameFile`.

**Temporary files.** A save writes `.<name>.<12 hex>.tmp` beside the file until
it is renamed. One that was cut off stays. `sweepTemp(base, rel)` removes those
older than a minute (`olderThanMs` to change that) and says which: a save of
the portal's or of another half that is under way has such a file too, and the
age is what keeps it. Do not match the names and remove them yourself.

A refusal for the system's own reasons is `failed`, and says which on the error:
`e.errno` is `ENOSPC`, `EACCES`, `EROFS` and so on, and `e.cause` the error
itself, for a server half that words a full disk differently from a missing right.

[Documents](/guide/documents) is built on these: its files are read with
`readBytes`, written with `write` (`create` for a new document, `direct`) and
told changed by `change`; its folder is found with `folder`, made with
`makeFolder` and listed with `list`; its leftovers are swept with `sweepTemp`; a
document is deleted with `removeFile` and renamed with `renameFile`
(`direct`, `alone`, `likeParent` with `chats`, and `expect` for the documents folder it keeps the identity of, which it
takes with `identity`).

**Watching a chat's folder** is not in `portal.files`. A watch reads nothing and
changes nothing, so it has none of the dangers above: it only tells that
something happened, and a half that then looks does so through `portal.files`.
What a watch needs is the extension's own (when a folder made again counts as
another, what to fall back on when the system cannot watch), so use `fs.watch`
on the folder `portal.files.folder` gave you, and look when it says so.

What a server half makes for the person, a picture say, is kept with
`files.create(base, rel, name, bytes)`: a new file in the folder `rel`, written
beside its place and put there whole, never over one that is there. A name
that is taken gets a number, `cat (2).png`, and the path it was given is
returned.

`files.open(base, rel)` also says what the file is by its first bytes rather
than its name: `mimeType` is set for a picture (PNG, JPEG, GIF, WebP) or a
clip a browser plays (WebM, MP4), and absent for anything else. What a package
takes is its own to decide: a gallery refuses a file that has no `image/` type,
and a picture larger than it shows.

#### Sending a file

`http.send(req, res, file, options)` sends what `files.open` opened as the
portal sends its own pictures and clips: with its type, a policy that keeps it
from running anything in the page, a version the browser revalidates (304), and
the part a player asks for (`Range`), so a long clip starts at once and can be
moved around in. `cache` is the `Cache-Control` (`private, no-cache` unless
said); with `download`, a file name, the file is sent to be saved and never
shown, and so is a file that is no picture or clip. The file is closed once sent.

```js
portal.router.get("/chats/:id/picture", (req, res) => {
  try {
    const file = portal.files.open(portal.chats.folder(req.params.id), String(req.query.path));
    if (!file.mimeType?.startsWith("image/")) {
      fs.closeSync(file.fd);
      return res.status(400).json({ error: "That is not a picture" });
    }
    portal.http.send(req, res, file, { cache: "private, max-age=3600" });
  } catch (e) {
    res.status(e.code === "missing" ? 404 : 400).json({ error: e.message, code: e.code });
  }
});
```

### The folders the agents work in

`folders.list()` is every folder the agents work in, each once by its real
path: every agent's home (`kind: "agent"`, named after its agent, `home` for
the first, which the sidebar calls Home), every project (`kind: "project"`,
named by its place under the workspace root), and every other folder a chat
of any kind works in (`kind: "chat"`). A gallery of what the agents made looks
through these. `folders.allowed(path)` says whether a folder, by its real
path, is one of the kind they work in, the only kind to serve what they made
from.

`folders.label(folder)` is what the person calls a folder, by its real path,
whether or not `list` has it now: `{ name, home? }`, its agent's name for an
agent's home (`home` for the first), its place under the workspace root for a
folder inside it, and its last part otherwise. It is for a folder something
was kept for after the last chat in it went: Media's gallery names the folder
of a deleted chat's pictures so.

`folders.on("removed", (folder) => …)` is told when the portal deletes one: a
project with its folder, or an agent with its home. `folder` is where it really
was, as `list` named it, for what was kept of it to go too. A server half that
was not running then, because it was switched off, removed and installed again,
or failed to start, is told when it next starts, once for each folder, as soon
as its default export is done. One that starts for the first time is told of
none deleted before: it kept nothing of them.

### Telling the pages open on a chat

```js
// server.js
portal.chats.onOpen((chatId) => ({ type: "count", count: read(chatId).length }));   // to a page as it opens the chat
portal.chats.send(chatId, { type: "count", count: notes.length });                  // to every page open on it, now
```

```js
// web/client.js, as the module is called
const counts = new Map();
portal.server.on((chatId, data) => {
  if (data.type === "count") counts.set(chatId, data.count);
});
```

It rides the chat's own event stream, so it costs no connection, and nothing
of it is stored. `onOpen` is what makes it hold together: each time a page
connects to a chat, the first time or after its connection dropped, it is told
where things stand, then each change. Listen for it as your module is called,
as above, and keep what you hear in the module: the page's stream opens before
the extensions are loaded, and what came for yours meanwhile is handed over, in
order, once it has been called. A component that only starts listening when it
is drawn has missed what came before. A module that comes into the page while
a chat is already open (the package was just installed, switched on or
updated) is told what `onOpen` says for that chat then. What is said must be
JSON: something that cannot be written as it is left out, with a line in the
portal's log.

### Tools that share the server half's state

A tool the agent calls is registered in the chat's pi. Made in the server
half, it holds what the server half holds:

```js
const canvases = new Map();

portal.chats.extend((pi, chat) => {
  pi.registerTool({
    name: "canvas_create",
    label: "Create a canvas",
    description: "…",
    parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    async execute(_id, params) {
      const canvas = create(chat.id, params.title);          // the same store the routes read
      portal.chats.send(chat.id, { type: "created", id: canvas.id });
      return { content: [{ type: "text", text: `Created ${canvas.id}` }], details: { id: canvas.id } };
    },
  });
});
```

The factory is pi's own extension API, called for every chat as its pi loads.
Its tools are listed under Settings → Tools in a group named after your
package, the same group as your package's pi extension's, and that group is
what a lazy mark or a name given to it holds to. They are listed while your
package is installed and switched on, also while its server half has crashed or
could not start; switched off or uninstalled, it registers none, and they are
left out of every list, with what was switched for them kept for when it is
back. Installing your package reloads the open chats, so a chat whose pi was
running has them from its next step. A factory that throws is that chat's load error: nothing your package
adds to its pi is there, and the chat says why. One whose promise fails later
is only in the [log](/guide/settings#logs).
A server half is plain Node, though: what it imports is its own package's
dependencies, not what pi lends its extensions. So a tool's parameters are
written as a JSON schema, as above, unless the package depends on `typebox`
itself.
It is there only where pi runs in the portal's process (`portal.executor` is
`"host"`). `portal.chats.onEvent((chatId, event) => …)` hears everything a
chat's pi says, a tool call's arguments as they stream included, and what the
package's own pi extension sends its browser half arrives there as
`{ type: "portal_extension_ui", extension, data }`.

To follow a call of your tool as the model writes its arguments (Canvases
shows a document being written), ask `portal.chats.offers(chatId, tool)` how
the tool is offered first: a call by a name it is not offered under is refused
and never runs, so its text is nobody's. A call of a lazy tool comes as a call
of the `tools` tool, with yours in its arguments. In a chat in
[Code mode](/guide/sessions#modes) a call of your tool comes inside the code
tool's: a script makes it, and nothing of its arguments is streamed.

What the model is to be told of a tool goes in its description, or in pi's
`promptGuidelines`, in every turn while the tool is on. What only a spoken
turn needs (a long report goes in a document, and only a line of it is said)
goes in `voiceGuidelines`, which the portal adds to its voice rule while the
tool is on, once however many tools have the same line:

```js
pi.registerTool({ name: "canvas_write", /* … */ voiceGuidelines: ["Write the full report in a canvas and give only a brief spoken summary."] });
```

A tool that does something a person should choose to allow (Docker's tools
run containers on the portal's machine) is registered with
`offByDefault: true`. The first time the portal sees it, it is switched off by
default in Settings → Tools, and it is off in every chat, from the first
message of the first chat that has it, until somebody switches it on there or
by default. After that it is a default like any other: one switched on by
default stays on. It works for a tool of any package's pi extension too, in a
chat whose pi runs in the portal's own process (the host executor, where
`chats.extend` works); a chat run in a container of its own does not read it.

```js
pi.registerTool({ name: "docker_run", /* … */ offByDefault: true });
```

#### What the guard holds a tool to

A tool says what the [guard](/guide/security) is to hold it to in `guard` on
its definition, read at each call, for a tool of `chats.extend` and of any
package's pi extension alike, in a chat whose pi runs in the portal's own
process. A tool that declares no `guard` is trusted as your extension is: what
it returns is not marked as outside content, and of the rules after a suspected
prompt injection only `read-credentials` holds it, as it holds every tool, where
its `path` or `file_path` argument names a place secrets are kept. A name like a
browser's holds a tool to the browser's rules, whether or not it declares
anything (see below).

- `outside: true`: what it returns is outside content, such as a page, a mail
  or a file somebody else wrote. It comes to the model wrapped as data, between
  markers with a random id the content cannot close, and a result that looks
  like it tries to instruct the agent is flagged and holds the conversation to
  the rules after a suspected prompt injection. The paragraph saying that such
  content is data and never instructions is the portal's, said once in the
  prompt while any tool that declares `outside` is on or lazy, so the tool does
  not carry it.
- `reaches`: the names of its parameters that hold an address the agent chose,
  a URL or a host. Each value a call has in them, text or each text of a list,
  is held to the list of sites in **Settings → Guard**, where an empty list is
  any site. A call with an address off the list is refused, and recorded in
  Audit as `refused`; each address a call goes to is recorded as `browsed`.
  Only those parameters are read, from the call's own arguments.
- `acts`: the rules after a suspected prompt injection that every call of it
  is the shape of, by their names: `pipe-to-shell`, `write-to-path`, `upload`,
  `read-credentials`, `publish`, `persist`, `delegate`. Once the conversation
  has read a flagged result, a call is held as a command that rule catches: the
  primary user is asked about that one call where they are there to answer, and
  it is refused everywhere else (see [Asked or refused](/guide/security#asked-or-refused)).
  No approval for somebody else is asked for or spent on it, and a routine that
  is exempt from the rule runs it, which Audit records. Before that it runs. A
  name that is no rule's is left out, and said in the portal's log.
- `files`: the names of its parameters that hold the files a call works on,
  each declared as text or a list of text (Media's `edit_image` names `path`
  and `paths`, one picture or a list as its settings say). A call is approved
  for each of those files and for nothing else of it: a rule for a folder
  allows the call when it allows every file, and the action asked for is each
  file's path, one to a line. Every other tool is approved on its command, its
  path or its arguments whole, and a command, a tool server's tools and the
  `tools` tool never are on files. `approvalFiles` beside `guard` is the older
  spelling, and is still read.

```js
pi.registerTool({
  name: "fetch_page",
  parameters: { type: "object", properties: { url: { type: "string" }, save: { type: "array", items: { type: "string" } } } },
  guard: { outside: true, reaches: ["url"], files: ["save"] },
  /* … */
});
pi.registerTool({ name: "send_report", /* … */ guard: { acts: ["upload"] } });
```

The declaration's type is `ToolGuard`, from `@pithagoras/extension-api/server`.
An MCP server's tools declare nothing. What one returns is outside content
unless its server is counted as your own in **Settings → Guard**. A tool named
like a browser's (`browser` at the start or after `_` or `.`, and followed by
`_` or `.`: `browser_navigate`, `playwright_browser_click`) is held to the
browser's rules by its name, a server's or an extension's, declared or not:
what it returns is outside content, and a call is held to the list of sites for
its `url`, and Audit. The [Browser](/guide/browser) extension's tools declare
`outside` and `reaches: ["url"]`, and have such names too.

#### Tools that follow the settings

Where which tools there are follows the package's settings (image generation
once somebody has said where pictures are made, say), the factory registers
only those, and `tools.offer` says the same to the portal: Settings → Tools
then lists them before any chat has reported them, and leaves out the ones it
remembers that are not offered now. After a change, `chats.reload()` loads the
idle chats again, for each to have the tools as they are now; one that is
working is reloaded at its next step, as for a package switched on.

```js
const offered = () => (settings().endpoint ? [{ name: "make_picture", description: "Make a picture from a description." }] : []);
portal.tools.offer(offered);
portal.chats.extend((pi) => {
  for (const tool of offered()) pi.registerTool({ ...definitions[tool.name] });
});
// Once the person has saved the settings:
await portal.chats.reload();
```

Media's tools are built this way (`extensions/media/src/server/pi/tools.ts`):
`show_image` is always there, `generate_image` and `edit_image` while their
endpoint is set up, and `generate_video` and `show_video` while video
generation is; a save of its settings that changes which there are, or the
shape of `edit_image`, reloads the idle chats.

#### Who has its tools

A page that says who may use its tools asks the portal where they are not
what the default says. `tools.exceptions(names)` answers for those tools, by
name, as the switches have them now: `byDefault`, whether a chat that has
never said anything about them has any of them on; `chats`, those that have
them otherwise, by their own switches or by their agent's, project's or
[mode's](/guide/sessions#modes), newest first, each `{ id, title, kind }` and
each the opposite of `byDefault`; and `routines`, those whose own switches give
their runs another answer than a routine that sets nothing would have in the
same place, by name, each `{ slug, name, allowed }` with the answer its runs
have. A routine that sets nothing has each tool as a chat in its place has it.
The switches themselves stay in Settings → Tools, beside each chat's composer
and on each routine's page. Browser's page says who may drive the browser this
way.

```js
portal.router.get("/who", (_req, res) => res.json(portal.tools.exceptions(["page_open", "page_read"])));
// { byDefault: true, chats: [{ id: "a1", title: "Shopping", kind: "task" }], routines: [{ slug: "nightly", name: "Nightly", allowed: true }] }
```

### Files a tool gives

A tool says it gave the person a file the same way whoever made it, the
portal or an extension, in a pi extension or a server half: its result's
`details` has `files`, each a path in the chat's folder, with a title if it
has one and the files it was made from (`from`) if it is a changed copy.

```js
return {
  content: [{ type: "text", text: "Plotted the sales: plots/sales.png" }],
  details: { files: [{ path: "plots/sales.png", title: "Sales by month" }] },
};
```

Everything else a tool answers is text. When the call ends, the portal looks
at each file's bytes, not its name: a PNG, JPEG, GIF or WebP is a picture, a
WebM or MP4 a clip, and any other file in the folder a file to save. One that
is not there, is outside the folder or is reached through a link out of it is
left out. What it found is on the end of the call, and everything goes by it:

- The chat draws them under the call's card: a picture, which opens in the
  [viewer](/guide/sessions#looking-at-a-picture), a clip in its player, and
  any other file as a link that saves it.
- The viewer steps through the pictures with the rest of the chat's, and one
  made `from` a picture shown before is tied to it.
- Voice mode's **Pictures** window shows the pictures.
- A [channel](/channels/writing-a-channel) sends pictures and clips on as they
  are given, and names any other file in the reply.

A picture in the agent's own words is not a file a call gave: one it writes in
Markdown loads only from the portal (a clip of the chat's, written the same
way, plays), and one from anywhere else is not fetched, so that a page the
agent read cannot have the browser send something somewhere else.

### Running things as the chat's agent

With the [sandbox](/guide/sandbox) on, each agent runs as a user of its own.
A server half runs as the portal. For what it does on a chat's behalf:

```js
const { code, stdout, stderr } = await portal.sandbox.run(chatId, ["git", "status", "--short"]);
// Or start a process yourself, as the chat's agent: `argv` goes before your command.
const { argv, env } = portal.sandbox.spawnAs(chatId);
const [command, ...args] = [...argv, "bash", "-il"];
const shell = spawn(command, args, { env, cwd: portal.chats.folder(chatId) });
```

`run` starts in the chat's folder and never throws for a command that fails.
With the sandbox off both are the portal's own user, and `argv` is empty.

### git in a chat's folder

A chat's folder is one its agent can write, and so is a repository in it: its
config can name a program for git to run (a filter, an fsmonitor hook, a
signature's gpg) that would run as the portal. `portal.git.at(folder)` runs
git as the portal runs its own: no prompt, editor or pager, no colour, and,
for a step that only reads, none of those programs and no index lock for the
agent's own `git add` to find held. A step that writes is git as someone would
type it in the folder, hooks and filters included. Two writes to one
repository at once trip over its lock, so queue your own (the Git extension
runs one at a time per repository).

```js
const repo = portal.git.at(portal.chats.folder(chatId));
const { stdout } = await repo.run(["status", "--porcelain=v2", "-z"]);
await repo.run(["commit", "-F", "-"], { input: message, writes: true });
const { stdout: pulls } = await repo.gh(["pr", "list", "--json", "number,title"]);
```

A step that fails rejects with an `Error` that has a `status`: 409 with git's
own words, 504 for one stopped for taking too long, 501 where git or gh is not
installed. `ok` lists exit codes that are answers rather than failures,
`timeout` and `max` bound a step (20 seconds for reading and three minutes for
writing; 16 MB of output). What reading turns off is looked up once for each
handle: make one for each request rather than keeping it.

### Models

A server half that asks a model itself, outside a chat's pi, asks the ones the
person set up, with their keys, through `portal.models`:

```js
// The model of the chat that asked; without a chat, the one new chats start on.
const model = await portal.models.of(chatId);
const { api, baseUrl, headers, key } = await portal.models.endpoint(model.provider, model.id);
if (api === "openai-completions") {
  const answer = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { ...headers, ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" },
    body: JSON.stringify({ model: model.id, messages }),
  });
}
```

- `of(chatId?)` is the model a chat is on now: the one its pi has, where it
  runs here, else the one stored for it, which is the default where it names
  none. Without a chat, it is the one new chats start on. Nothing for a chat
  that is not known, or where no model is chosen.
- `endpoint(provider, id)` is where a model pi knows is asked: what it speaks
  (`api`, as pi says it), its address (`baseUrl`, with no slash at the end,
  or `""` where pi has none), the `headers` its provider adds, and its `key`,
  where it has one. The key is not in `headers`: a request carries it as its
  `api` takes a key, as `authorization: Bearer <key>` for
  `openai-completions`. It rejects for a model pi does not know.
- `list()` is the providers set up by their address in pi's models.json, each
  `{ provider, api?, baseUrl?, models }` with its models' ids. The services pi
  has built in, signed in with a key or an account, are not listed;
  `endpoint` reaches their models all the same.

The key is the person's: send it to that model's own address and nowhere else.
Where the provider's key is a command pi runs (`!…`), `keyFromCommand` is true:
`key` is what the command gave this time, fit for a request now
and not for keeping where it outlives the request, such as a container's
environment. [Understory](/guide/features#memory-understory) asks `of` and
`endpoint` in "the chat's" mode, and does not write a command's key into its
container.

### MCP servers

An extension whose tools are an MCP server's (a service of its own that speaks
MCP, say) writes the server into pi's mcp.json with `portal.mcp.set`.
pi-mcp-adapter then makes its tools the chats', named `<server>_<tool>`, and
they are switched in Settings → MCP and Settings → Tools as any server's are.

```js
// Switched on from the extension's own page.
await portal.mcp.set("notes", { url: "http://127.0.0.1:3900/mcp", lifecycle: "lazy", directTools: true }, { trusted: true });
portal.mcp.get("notes");   // { entry: { url: …, lifecycle: "lazy", directTools: true }, on: true }
// Switched off.
await portal.mcp.set("notes", undefined);
```

- `get(name)` is the server of that name, `{ entry, on }`, or nothing where
  there is none or the file cannot be read. `on` says the chats have its tools
  now: it is there, not switched off (`disabled`), and pi-mcp-adapter is
  installed and on. The file is read again only when it, or pi's settings,
  changed, so `get` can be asked each time a prompt is built. `entry` is a
  copy.
- `set(name, entry)` writes the entry in place of what is there under that
  name; to keep what the person added to it by hand, read it with `get` first.
  The file is for the portal's user alone (mode 0600), as an entry may hold a
  token. Writing an entry installs pi-mcp-adapter, in the version the portal
  pins, where it is not installed, and switches it on where it is off.
  `set(name, undefined)` removes the server. Either way the open chats are
  loaded again, as `chats.reload` does, to have the change, and `set` answers
  what that does: `{ reloaded, waiting }`, for a page that says how many chats
  have it now and how many at their next step. Installing the
  adapter waits for the server halves to follow what is installed, this one's
  start among them: call `set` when the person switches the server on, not
  while the half starts.
- `trusted: true` says the person counts what its tools return as their own
  words, which the guard then neither wraps nor checks (see
  [Prompt injection](/guide/security#marking-untrusted-output)). The name is
  added to the trusted servers in Settings → Guard, where it is shown and the
  person can take it out. Say it only for the extension's own service, on the
  person's word on its page. `set(name, undefined)` takes the name out of the
  trusted servers again: Settings → Guard lists only the servers there are, and
  a server given that name later has to be trusted anew.
- It rejects while mcp.json cannot be read, which is the person's to fix in
  Settings → MCP (nothing is written over it), for a name that is not letters,
  digits, dots, dashes and underscores, and for an entry the adapter would not
  take: one with none, or more than one, of `url`, `command` and `socket`.

Understory (`extensions/understory`) writes its server so, trusted, when it is
switched on from its page in Settings.

### The agent's memory

An extension that keeps the agent's memory, notes the agent reads and writes
through tools of the extension's, says so with `portal.memory.hold`. While it
holds it, a chat with the person the agent works for does not read the agent's
MEMORY.md and is told the extension's `rule` in its place: two memories would
drift apart, and the file would be the stale one. The file stays where it is,
and is read again once the extension lets the memory go.

```js
portal.memory.hold({
  label: "Notes",
  rule: "Your long-term memory is in the notes_* tools, not a MEMORY.md file. Look things up with notes_search before relying on what you think you know.",
  on: () => portal.mcp.get("notes")?.on === true,
});
```

- `on()` says whether it holds the memory now. It is asked each time a chat's
  prompt is built: keep it quick, and give a boolean. One that throws, or
  answers anything but `true`, holds nothing then. A chat that is open has the
  change once it is loaded again (`chats.reload`).
- `rule` is said only in a chat with the person: a colleague or a guest never
  reads MEMORY.md, and is told nothing of a memory in its place.
- The agent's home and a plain folder have it. A project linked to an agent has
  it unless the project does without it (its switch in Projects); a blank
  project, which has no agent, never has it.
- One extension holds the memory: the first that asks. One that asks while
  another holds it is refused, with a line in the portal's log that says which
  holds it. It is let go when the extension's server half stops; one that asks
  after that, from a timer it left or a start the portal gave up on, holds
  nothing.
- What holds it is said by its `label`: `GET /api/features/flags` answers
  `memory: { held, by }`, and an agent's setup (`GET /api/agents/:id/setup`)
  `memory: "extension"` with `by`.

Understory (`extensions/understory`) holds the memory so, while its server is
on.

### A row in Audit

An extension that does something the person should be able to look back on, such
as installing code, writes it into **Audit**, beside the guard's decisions, with
`portal.audit.record`:

```js
portal.audit.record({ subject: "moon 0.1.0 · 3f2a9c41d0be · extensions/moon", reason: "Installed", chatId: chat.id });
```

- The row is of the kind **Extension**, and names the extension, by its
  package's name, as the tool. The kind is fixed: an extension cannot write a
  row that reads as one of the guard's (`refused`, `allowed-by-approval`,
  `trusted`).
- `subject` is what it was done to, a name or a path, shown as it is. An empty
  one is a TypeError. It is cut at 2,000 characters, as every row's subject is.
- `reason` is a short text in English. Audit shows it through the extension's
  own translations (`portal.locale.add` in its browser half), as it does a
  mode's texts.
- `chatId` is the chat it was done for, kept as it is given. The chat is not
  looked up, so one deleted since is still named by its id, as the guard's rows
  name one.

### Building on another extension

An extension can give others something to build on, as a library does: a
Docker extension that runs containers, say, for the extensions that need one.
The one that gives it says what it gives with `portal.provide`, and those that
build on it name it in their package.json and ask for it with
`portal.extensions.use`.

```js
// pithagoras-docker: what each extension that builds on it gets, its own, by its name.
portal.provide((consumer) => dockerFor(consumer.name));
```

```json
{
  "name": "pithagoras-browser",
  "pithagoras": {
    "server": "./server.js",
    "requires": { "pithagoras-docker": "^1.0.0" }
  }
}
```

```js
// pithagoras-browser
const docker = portal.extensions.use("pithagoras-docker");
await docker.images.ensure("lscr.io/linuxserver/chromium:latest");
await docker.containers.create("pithagoras-browser", { Image: "lscr.io/linuxserver/chromium:latest", HostConfig: { RestartPolicy: { Name: "unless-stopped" } } });
await docker.containers.start("pithagoras-browser");
```

[Docker for extensions](/guide/docker) is the one the portal ships. A service
container an extension runs through it uses Docker's `unless-stopped` restart
policy, as Browser's, Voice's and Understory's do, so that it comes back after
the host restarts and stays stopped when the person stops it
([When the machine restarts](/guide/docker#when-the-machine-restarts)).

- **`requires`**: the extensions it cannot work without, each with the versions
  it takes (a semver range). Without one of them, or with one in a version it
  does not take, it does not start, and Settings → Extensions says why ("It
  needs pithagoras-docker (^1.0.0), which is not installed, or is switched
  off"). Installed from Settings → Extensions, it brings them with it: see
  [Installing what it requires](#installing-what-it-requires).
- **`optional`**: the ones it uses when they are there. It starts without them,
  and `use` gives nothing then, or while one is there in a version it does not
  take.
- **Order.** An extension starts after all it builds on, and is stopped before
  them. When one it builds on is started anew (updated, switched off and on,
  installed or removed, for an optional one), so is it, after it: it never
  holds on to what a provider that is gone gave it. One that is not affected is
  left running.
- **Each its own.** The function given to `provide` is called once for each
  extension that asks, with its name, and what it returns is that one's alone:
  a provider keeps apart what each does with it. `use` gives the same thing each
  time it is asked.
- **What can go wrong** is said where the person looks: a provider that fails
  to start keeps those that require it from starting ("whose server half could
  not start"), and extensions that build on one another in a circle start none
  of them.
- `use` may only name an extension in `requires` or `optional`: the portal
  starts and restarts an extension by what it says it builds on.

This is for server halves. A provider's routes are its own, as any extension's
are: a page asks its own server half, which asks the provider.

#### Installing what it requires

Someone who installs an extension that requires others, from Settings →
Extensions, is first told what that brings with it, and asked. Each extension it
requires that is not there as it needs it is listed, with what is done for it:

- one that comes with the portal (its own `extensions` folder) by that name is
  installed from there. npm is never asked for a name the portal ships, as
  anyone can publish a package under it there;
- otherwise one on npm by that name, in a version the range takes, is installed
  from npm by the range (`npm:my-engine@^1.0.0`), so that an update keeps it
  within the range. The question says that what comes from npm runs inside pi
  with the agent's rights;
- one installed and switched off is switched on;
- one installed, or in the portal's folder, in a version the range does not
  take, and one found nowhere, are said, and nothing is done for them. The
  extension can be installed all the same, and waits for them, saying so as
  above.

What those require is looked at too, each once, and a circle ends. One required
by two, where the version the first leaves is not one the second takes, is said
for the second. On yes, each is installed or switched on before what needs it,
the extension last, and the page says which it has come to. One that fails stops
the rest, and says why; what was installed before it stays. With all it requires
there, nothing is asked.

This is known beforehand for an extension that comes with the portal and for a
package on npm, whose registry has the package.json of each version. A git URL
or a folder of the server's is read only once it is installed: nothing is
installed with it, and it waits as above until what it requires is there.
Before anything is installed, Discover says what one that comes with the portal
requires ("Needs pithagoras-docker").

### Extensions it installs

An extension can install a package it wrote itself, load it again after a
change, and remove it: a mode in which the agent makes extensions, say, takes a
copy of what the agent wrote into a folder of its own, and installs the copy.
`portal.extensions.install`, `remove` and `status` do what Settings →
Extensions does, for a folder in the extension's own data folder.

```js
const copy = path.join(portal.dataDir(), "made", "moon");
// … the package written into `copy`, and checked …
const installed = await portal.extensions.install(copy, { note: "Moon phases · extensions/moon" });
if (installed.server && !installed.server.running) portal.log(`moon: ${installed.server.crash?.error ?? installed.server.failure}`);

// Later: where it stands, with the lines it said since the last look, and what a chat could not load of it.
const status = await portal.extensions.status("moon", { chatId, since });

await portal.extensions.remove("moon");
```

- **Only from its own `dataDir()`.** The folder must be inside it, followed
  through links: a folder anywhere else, or a link in `dataDir()` that leads out
  of it, is refused with a TypeError, and so is a folder with no package.json or
  no valid npm name in it. The portal loads only what no agent can write, and
  `dataDir()` is the portal's alone (0700). A folder an agent can write,
  installed as it is, would let any chat that can write there change code that
  runs in the portal, with no install in between. So an extension copies what it
  is given into its own folder, checks the copy, and installs that.
- **A name of its own.** A name that one of the portal's own extensions has
  (those in its `extensions` folder) is refused, and
  so is one that a package installed from another folder has. Of two packages of
  one name, the portal loads the first: the second would be installed and never
  run. A name the portal gives one of its own extensions in a chat's pi
  (`sandbox`, `guard`, `voice-first`, `cross-model-thinking`, `tools-gateway`,
  `routines`, `ask-question`, `ask-primary`, `report`, `codemode`,
  `heartbeat`) is refused too: pi files what a server half adds to a chat under
  its package's name, as it files those, and the package would pass for the
  portal's own.
- **One at a time.** Installs and removals made through these calls, by every
  extension, run one after another, each whole, from its checks to the end. An
  install in Settings is not one of them, and checks no names.
- **The same folder again is the reload.** Installed again after its files
  changed, it stays one package, and each of its halves is loaded again at its
  new revision, as installing the same folder in Settings does (see
  [What is loaded, and when](#what-is-loaded-and-when)). After every install the
  open chats are loaded again, an idle one at once and one that is working at
  its next step: the model's next request has the new tools.
- **An off switch stays off.** A package the person switched off in Settings
  stays off when it is installed again: `enabled` says so, and its server half
  does not start.
- **What `install` answers** is what `status` says once it is installed, with
  how many open chats were loaded again (`reloaded`) and how many are working and
  take it at their next step (`waiting`).
- **What `status` says** (`ExtensionStatus`): its name, version and spec;
  whether it is switched on; where it came from (`installedFrom`); for its server
  half, whether it runs, why not, the crash it is held off for (see
  [When the server half crashes](#when-the-server-half-crashes)), and its latest
  lines, up to 200, oldest first, with what looks like a secret taken out; what a
  page said last failed of its browser half; and, asked with `chatId`, what that
  chat could not load of it at its last load (`loadErrors`: a factory of its
  server half that threw, a tool whose name another had), which is empty while
  that chat's pi is not running. Each line has an `id`: give the last one as
  `since` to have only the lines after it. Nothing for a name that is not
  installed. It answers for any installed extension, not only for one this
  extension installed.
- **In Settings → Extensions** a package in an extension's data folder says
  **From** that extension, however it was installed: with this call, or by its
  path in Settings. Where the extension installed it itself, the note it gave is
  under it, shown as it is, and pointing at the pill says when.
- **`remove`** takes only a package whose folder is in this extension's own data
  folder, and is what Remove in Settings does: the open chats are loaded again.
  The files stay; they are the extension's, in its folder. Removing it in
  Settings drops its note as well.
- **Not while it starts, nor once it stopped.** `install` and `remove` reject at
  once when they are called before the half's default export has returned, or
  after its server half stopped: the server halves follow an install, and they
  would wait for this one. Call them from a route, a tool or a timer. `status`
  can be asked at any time.

### Voice providers

An extension can be [voice mode](/guide/voice)'s source: it recognises speech
for voice mode and dictation, speaks the replies, and names the voices it speaks
with, through a service it runs or one it reaches. It offers this with
`portal.voice.provide`. The person chooses it on the extension's own page, which
calls `portal.voice.choose`, and can stop using it there or in **Settings →
Defaults → Voice mode**. Voice mode has one source, the one chosen last.
[The voice service](/guide/voice-service) and
[Voice servers](/guide/voice-servers) are two.

```js
portal.voice.provide({
  label: "My speech",
  // What it offers now; nothing while it cannot be used.
  state: () => (running ? { speaks: true, voices: [{ id: "warm", name: "Warm", builtIn: true }] } : undefined),
  // The words said in one recording.
  async transcribe(wav, { purpose, signal }) {
    const form = new FormData();
    form.set("file", new Blob([wav], { type: "audio/wav" }), "recording.wav");
    const answer = await fetch("http://127.0.0.1:8188/inference", { method: "POST", body: form, signal });
    if (!answer.ok) throw new Error(`The recogniser answered HTTP ${answer.status}`);
    return (await answer.json()).text;
  },
  // One phrase, as 24 kHz audio.
  async speak(text, { voice, signal }) {
    const answer = await fetch("http://127.0.0.1:7862/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: text, voice: voice ?? "warm", response_format: "pcm" }),
      signal,
    });
    if (!answer.ok) throw new Error(`The speech engine answered HTTP ${answer.status}`);
    return new Response(answer.body, { headers: { "content-type": "audio/pcm", "x-sample-rate": "24000" } });
  },
  // Voice mode began, or stopped, being used anywhere.
  async use(inUse) {
    await (inUse ? loadModel() : unloadModel());
  },
});
```

- **`label`** names it where the portal names voice mode's source (Settings →
  Defaults → Voice mode, an agent's voice menu), in the person's language from
  the extension's own texts (`portal.locale.add`), as a Settings page's title
  is.
- **`state()`** says what it offers now: `{ speaks, voices }`, or nothing while
  it cannot be used. It is asked at each request and as each prompt is built:
  keep it quick, and give a value, not a promise. `speaks: false` is recognition
  alone: dictation works, voice mode is not offered, and replies are not spoken.
  `voices` are `{ id, name, builtIn? }`, what an agent's voice is chosen from on
  the Agents page. A `name` is shown as it is, unless `builtIn` is true: a voice
  the provider has of itself, whose name is its own English text, is shown
  through the extension's translations, and a voice the person added is shown by
  the name they gave it. An answer of another shape counts as nothing, and so
  does a throw; the log says which.
- **Not running.** While `state()` answers nothing, or the server half is not
  running, voice mode answers 503, "Voice mode listens and speaks through
  `<name>`, which is not running: install or start it in Settings → Extensions,
  or stop using it in Settings → Defaults → Voice mode", and uses nothing else.
- **`transcribe(wav, { purpose, signal })`** gives the words said in `wav`, one
  recording: a 16 kHz mono 16-bit WAV of at most 12 MB. `purpose` is
  `"dictation"` for the message box's microphone and `"voice"` for voice mode,
  for a provider that sends them to different places. The portal trims what it
  gives.
- **`speak(text, { voice, signal })`** speaks one phrase of at most 600
  characters in `voice`, an id from `state().voices` (the agent's own), or its
  own choice where `voice` is undefined or an id it no longer has. It answers an
  ok `Response` whose body is either `audio/pcm` (mono, 24 kHz, signed 16-bit
  little-endian; an `x-sample-rate` header, where there is one, says `24000`),
  which the portal passes on to the page as it arrives, or `audio/wav` (mono,
  24 kHz, 16-bit PCM), which it reads whole, checks and sends on as PCM. Anything
  else, a WAV at another rate say, is refused with a message naming the label,
  and the portal cancels the answer's body, so that a stream behind it stops.
  Nothing is resampled.
- **What they throw** is what the page shows, as a 502: say it so that the
  person knows what to do. `signal` ends when the page gives up on the request
  (the person spoke over the reply, ended voice mode or closed the tab), or after
  two minutes; the portal stops waiting then either way, so pass it on to what
  you call.
- **`use(inUse)`**, which may be left out. Every voice session holds a lease
  while it is on: each tab renews it every 25 seconds, and one not renewed for
  75 runs out. The provider chosen is told `true` at the first lease and
  `false` once the last has ended or run out, not at each lease; `true` again
  where the person chose it while voice mode was in use, or its server half
  was started anew. Where another source is chosen while voice mode is in use,
  or none, it is told `false` at the next renewal. `true` is awaited as voice
  mode begins: what it throws is said on the page, and voice mode does not
  start. What it throws for `false` is logged. Each call has 120 seconds, as
  long as a speech model may take to load; one that has not settled by then
  counts as failed, so that it holds up no voice session.
- **`choose(true)`** makes the extension voice mode's source, and so switches
  voice mode on; **`choose(false)`** stops it being the source where it is, and
  voice mode then has none. Neither changes anything else of voice mode's
  settings. The source decides where the person's voice goes, so `choose`
  answers what they ask for on the extension's own page, such as using it once
  it is installed, or an uninstall. **`chosen()`** says whether this extension
  is the source now, for its page to say so and offer **Stop using**.
- **One for each package.** `provide` again replaces the one before, and it
  goes when the server half stops. A choice of it stays: voice mode says it is
  not running until it is back, or the person stops using it.

The portal keeps no address, engine, language or recording of a source's: how
an engine is spoken to, and in which language, is the provider's own. Voice
mode asks for the source at each request, so a change is used at once. The
voice controls that are open read the settings again as Settings closes, so
they follow a source chosen on the extension's page there (whether its replies
are spoken, say) without a reload.

### Chat modes

A chat can be started in a [mode](/guide/sessions#modes): how it works, chosen
above the message box before its first message and fixed once it has one. An
extension offers a mode with `portal.modes.provide`, and does what the mode
means in its own `chats.extend` factory, which finds the chat's mode on
`chat.mode`:

```js
const DEPLOY = portal.modes.provide({
  id: "deploy",
  label: "Deploy mode",
  description: "The agent can ship what it builds to your servers.",
  confirm: "The agent can deploy to your servers from this chat without asking each time. Use it for work you would deploy yourself.",
});

portal.chats.extend((pi, chat) => {
  if (chat.mode !== DEPLOY) return;
  pi.registerTool({ name: "deploy_run", /* … */ });
});
```

- **What it returns** is what a chat in the mode stores, `"<package>/<id>"`,
  which `chat.mode` is in its chats (and in `chats.get` and `chats.list`). A
  chat in Standard mode has no `mode`; one in a mode of the portal's has its
  name (`"code"`), and one in a mode the person made `"custom/<id>"`. `id` is
  lower-case letters, digits and `-`, starting with a letter or a digit, one the
  package does not offer already;
  `label`, `description` and `confirm`, where there is one, are texts. Anything
  else throws a `TypeError`, and so does a package called `custom`, whose modes
  would be taken for the person's own.
- **What the mode does is the extension's.** A mode has no tools of its own:
  the factory registers what the mode's chats have, and can add to their prompt
  as any pi extension can; it leaves the other chats as they are. It is called
  each time a chat's pi starts, and a chat's mode is fixed once it has said
  something, so it decides once, and a tool of the mode's needs no check at
  each call.
- **Where it is offered.** The picker lists the portal's own modes first, then
  the ones the person made ([Modes you make](/guide/sessions#modes-you-make)),
  and the extensions' last, in the order they were offered. Modes are offered in
  the chats the person starts on the portal's pages and the conversations on an
  agent's page, where pi runs in the portal's own process (`portal.executor` is
  `"host"`): not to a routine's run, a heartbeat, a chat that came through a
  channel, or a colleague's chat. Leaving a mode means a new chat; `/new` and
  `/clear` start one in Standard mode, and a subagent works in it too, unless the
  person switched off **Subagents work in the chat's mode** (see
  [Subagents](/guide/features#the-mode-a-subagent-works-in)).
- **It goes with the server half.** When the half stops (switched off,
  removed, or crashed), the mode leaves the picker. A chat started in it keeps
  it, and its header says it is not available; from its next load it has
  nothing of the extension's, as the factory is gone, and it has the mode again
  once the extension is back. One that offers a mode after its half has
  stopped, from a timer it left or a start the portal gave up on, offers
  nothing, with a line in the log.
- **`confirm`** is asked in the portal's dialog, with a yes or no, before a
  chat is put in the mode, and a yes is kept in [Audit](/guide/sessions#audit)
  as *Mode chosen*, with the mode's label and what the chat stores. The mode is
  shown in the warning colour in the picker and in the chat's header. It warns
  the person; it is no gate: `PUT /api/sessions/:id/modes` takes
  `confirmed: true` from whoever sends it, and a browser half runs with the
  person's login.
- **Its texts are English**, as the server half writes them, and shown in the
  page's language through the extension's own texts, which its browser half
  gives with `portal.locale.add`: give their German there, and mark the same
  English with a `msg()` of your own so that your texts' check finds it, as
  for a panel's title.

[Creator mode](/guide/creator-mode), which comes with the portal, is a mode
worked out this way: its tools and its skill (given through pi's
`resources_discover`) only in its chats, and its texts in German
(`extensions/creator/src`).

### Child chats

A server half can give part of a chat's work to a chat of its own: a child
chat. It is a chat like any other. The portal starts its pi in its parent's
folder, with the guard, the sandbox, the tool switches and its mode, and it
keeps a transcript of its own, which the person opens at `/s/<id>`. The half
sends it a message, waits for the run to end, and has the last thing it said:

```js
portal.chats.extend((pi, chat) => {
  pi.registerTool({
    name: "look_it_up",
    /* … */
    async execute(_id, { question }) {
      const child = portal.chats.create({ parent: chat.id, title: "Look it up", listed: false });
      const run = await portal.chats.prompt(child.id, question);
      return { content: [{ type: "text", text: run.status === "done" ? run.answer : `It ${run.status}: ${run.error ?? ""}` }] };
    },
  });
});
```

- **`create({ parent, title, mode?, model?, listed? })`** makes it and returns
  it as a `Chat`, with `parent` set. Listed, it shows under its parent's row in
  the sidebar and on the Sessions page, as a
  [sub-chat](/guide/sessions#sub-chats), and its parent's row says when it
  works or waits for the person. `listed: false` keeps it out of the chat
  lists (and `chats.list()`): it is found by its id alone, or by
  `chats.children(parent)`, which gives the children of a chat that the package
  made, listed or not, oldest first: a half that lost its own record of them
  finds them there to stop or remove them. Without a `mode`, the child is in
  its parent's, so a mode that took tools away does not stop at a child; one
  that is named is the half's own choice (`"standard"` for none), as a chat
  stores it ([Chat modes](#chat-modes)), and a mode that asks the person first
  only where its parent is in it. A child in another mode than its parent's
  still has the tools its parent's mode took away, switched off as its own. The
  parent's own mode, named, is the same as none, and is refused if it is not
  there for a child. `model` is a `{ provider, id }`; without one it starts on
  the model (and effort) of another mode that is named, or else on its parent's. It throws, and says why, for a parent that is not there, is a
  child itself (one level only) or is a heartbeat (which is held to reading by a
  role of its own that a child would not carry), for no title, and for a model
  or a mode it cannot have.
- **It stands where its parent stands.** It takes its parent's role and the
  person the parent last heard from, so the guard holds each call to the person
  who asked, and the tools the person switched off or on in the parent. It is
  held to them as they stand now: a tool switched off in the parent since is off
  in the child before its next message, and one switched on in the parent later
  is not given to it. A dialog
  it opens, and a question the guard asks, are drawn on its own page, where its
  parent's would be: for a child of a chat of the portal's pages (or of the
  agent's page) nobody may be looking, so say where it waits; for a child of a
  conversation on a channel or of a routine run, where nobody can answer, the
  guard refuses for the child too, as it does for its parent.
- **`prompt(chatId, message, { steer? })`** resolves once the run that takes
  the message in has ended, with `{ status, answer, marked?, error? }`: `status` is
  `"done"`, `"stopped"` (by `abort`, by the person's Stop, or because the chat
  was deleted) or `"error"`. `answer` is the last thing it said. `marked` is
  there when the guard had marked the child (it read something that looked like
  a prompt injection): the parent is marked then too, so the guard's rules for a
  marked chat hold what it does with the answer. The mark is in the guard that
  runs now: to keep it when the guard is made again (the chat is reloaded or
  the portal restarted), hand the answer on in a tool result or a message that
  starts with `<<<untrusted:` and 16 hexadecimal digits, `>>> (suspected prompt
  injection: ` and a sign in lowercase words, `)`, which the guard reads in the
  chat's history as it reads a result it flagged itself (the subagent
  extension's `flagged.ts` writes it, and the person can trust it like
  that one). Sent while it
  works, a message waits for the run to end, as the person's does; with
  `steer`, it is taken after the step the run is on, and both prompts resolve
  as that run ends. A run that fails resolves as an error, and so does a
  command the child's speaker may not run; `prompt` throws only for a chat that
  is not a child the package made, or a message with no words. A command the
  speaker may run (`/compact`) is no message of the chat: `prompt` resolves as
  `done` at once, with no answer, when it started no run, or when the run it
  started ends.
- **`abort(chatId)`** stops its run, as the person's Stop does.
  **`remove(chatId)`** deletes it, its run stopped first; its transcript and
  files go, and `chats.on("deleted")` hears it once. While its parent is being
  deleted `remove` throws: the parent's delete takes the child.
- **The package that made a child** alone prompts, stops or removes it. The
  person can do all three on its own page.
- **It goes with its parent.** Deleting the parent deletes its children, each
  heard as `deleted`; a run of one is stopped first. While a child works, its
  parent counts as busy in the background: its pi is not let go for being idle
  or loaded again, and a message in it cannot be edited until the child is
  done. A portal that restarts marks a child it cut off *interrupted*, as any
  chat.
- **Beside its parent**, a browser half draws a child's run from its own
  events, `portal.chats.useEvents(child.id)` with `ui.Transcript`, and opens it
  with `portal.navigate("/s/" + child.id)`. The subagent extension does, and
  names the child on its [protocol](/guide/extensions#the-subagent-protocol)
  start (`chat`).
- **In a process of its own** (`"isolated": true`), `create` is answered at
  once (`children` too) and the others later, as the other calls are.

## Panels and commands

`portal.panels` is the panels of the chat on screen, any of them, by name:
`isOpen(name)`, `open(name, params?)`, `close(name)`, which asks what the panel
asks before it is closed by hand (`guardClose`). `has(name)` says whether
there is a panel by that name at all, and `useHas(name)` is the same as a
hook, drawn again when an extension comes or goes: Git offers "Open in Files"
only where there is a Files, which may be switched off or replaced. Every
panel beside a chat is an extension's: `<package>/<id>`, and also the `name`
it gave itself, if any. That is how one extension's panel takes the place of
another's that went by the name. Of two extensions that name a panel alike,
the one first in the slot's order has the name: a lower `order` first, then
the one whose extension comes first in the list of installed extensions.

Extensions a fresh portal installs go by names too. Files is `files` and takes
`{ path }`, a file in the chat's folder to show. The terminal is `terminal`
and takes `{ callId }`, a command of the agent's to bring into view, or
`{ job }`, a background job to follow. Git is `git`, and Canvases `canvas`;
neither takes anything. [Browser](/guide/browser), which comes with the portal
and is installed by hand, is `browser`, and takes nothing. So is
[Subagents](/guide/features#watching-a-subagent), `agents`, which takes
`{ id }`, a subagent to show.

The `title` of a panel, a voice window or a page is drawn in the page's
language as your own `t` would say it: give its German in `locale.add`, and
mark it with a `msg()` of your own so that your texts' check finds it.

A command is something an extension says it can be asked to do, for another
extension or the portal to ask by name. Start the name with your package's.
Should two extensions say the same name, the one first in the list of installed
extensions answers to it, and the other does once that one is gone.

```js
portal.commands.register("my-files.reveal", (path) => portal.panels.open("my-files/files", { path }));
// Elsewhere, in another extension:
if (portal.commands.has("my-files.reveal")) portal.commands.run("my-files.reveal", "src/index.ts");
```

### What the portal asks of extensions

Where the portal has a click that belongs to an app, it runs a command by a
name any extension can register, and offers the click only while one does:

| Command | Given | Asked when |
| --- | --- | --- |
| `jobs.show` | `{ chat, job }`: the chat's id and the job's key | A job in the running tray above the message box is clicked |

While none does, a job in the tray is listed and opens nothing. The terminal
extension registers it, and shows the job on its Background tab.

## Keyboard shortcuts

A shortcut of your extension's is listed in Settings → Shortcuts with the
portal's own, under your package's name, and changed or reset there the same
way. Voice-mode shortcuts work while voice mode is on, except while someone is
typing.

```js
portal.shortcuts.register({
  id: "shell",
  label: "Show or hide the terminal",
  scope: "voice",
  default: { code: "KeyT" },
  run: ({ chat, windows }) => (windows.isOpen("shell") ? windows.close("shell") : windows.open("shell")),
});
```

`default` is a physical key (`KeyboardEvent.code`) with `ctrl`, `alt`, `shift`
or `meta`, or null for none. A key the portal or an extension before
yours in the list of installed extensions has already is not taken from it: your shortcut has none until someone
chooses one. `run` is given the chat on screen and your own voice windows by
their ids. It returns false when it had nothing to do, and the key goes on to
whatever else wants it. The label is translated as your other texts are
([Other languages](#other-languages)).

## Other languages

English is what your code says, as it is for the portal. Add what each text is
in another language, and ask for a text with `portal.t`:

```js
portal.locale.add("de", { Notes: "Notizen", "Pin a note…": "Notiz anheften…", "{n} notes": "{n} Notizen" });

function Panel() {
  portal.locale.use();   // drawn again when the language changes
  return h("h3", null, portal.t("{n} notes", { n: 3 }));
}
```

A text you did not add falls back to the portal's own where it has it
("Loading…", "Remove"), and to what you wrote otherwise.

For a count, `portal.tp(n, one, other)` writes `{n}` the language's way and
picks the form; a language gives its forms under the English plural. Where
one English word means two things, `portal.tc(text, context)` tells them
apart, keyed as `text` and `context` with `\u0004` between them. And
`portal.tx(text, parts)` puts something drawn (a `<kbd>`, a link) where the
text has `{name}`:

```js
portal.locale.add("de", {
  "{n} commits": { one: "{n} Commit", other: "{n} Commits" },
  "Open\u0004state": "Offen",
  "Press {key} to send": "Mit {key} senden",
});
portal.tp(count, "{n} commit", "{n} commits");
portal.tc("Open", "state");
portal.tx("Press {key} to send", { key: h("kbd", null, "Enter") });
```

`portal.format.number(n)`, `.date(d)`, `.dateTime(d)` and `.time(d)` write
numbers and times as the page's language does.

## Themes

A theme is a set of colours in place of the portal's own, for dark, for light,
or for both. A package can be nothing else: name them in `package.json`, and
there is no code to write.

```json
{
  "name": "my-theme",
  "keywords": ["pi-package"],
  "pi": {},
  "pithagoras": {
    "themes": [
      {
        "id": "dusk",
        "name": "Dusk",
        "dark":  { "canvas": "#1b1626", "surface": "#241e33", "fg": "#f4f0fa", "accent": "#ff79c6", "terminal": "#15111e" },
        "light": { "canvas": "#faf7ff", "accent": "#a83282" }
      }
    ]
  }
}
```

Each colour goes by the portal's name for what it is for, and is written as
`"#rrggbb"` or as three numbers (`"27 22 38"`):

| | |
| --- | --- |
| `canvas`, `surface`, `raised` | The page; what sits on it; what sits on that |
| `line` | Borders and rules |
| `fg`, `fg-muted`, `fg-subtle`, `fg-faint` | Text, and its three quieter tones |
| `accent`, `accent-fg` | What is chosen or pressed, and text on it |
| `ok`, `warn`, `danger` | Done; careful; wrong |
| `terminal`, `terminal-fg` | A terminal's ground and its text. Dark in either mode unless a theme says otherwise |

What a theme does not say stays the portal's, so a theme can be one colour.
Keep text readable on what it sits on: the portal's own tones are each 4.5:1 or
better on every surface.

Installed, the theme is offered in **Settings → This browser → Appearance →
Colours**, beside Light, Dark and Match the system. The choice is kept in the
browser with its colours, so on the next load it is painted before the app and
long before any extension is loaded: there is no flash of the portal's own
colours first. When the package is removed or switched off, the portal's own
are back.

The browser half can do the same in code, and can be a theme changer: a
control of its own that switches the portal between themes, its own or any
other package's.

| `portal.theme.` | |
| --- | --- |
| `register({ id, name, dark?, light? })` | Adds a theme, like one named in `package.json` |
| `list()` | The themes there are: `{ id, name, extension }`, with `id` as `<package>/<id>` |
| `current()` | The theme in effect, or `null` for the portal's own colours |
| `set(id)` | Switches to a theme, or to the portal's own with `null` |
| `use()` | A hook: `{ mode, theme }`, light or dark and the theme in effect |

```js
portal.slots.register("chat.header.action", { id: "theme", component: () => {
  const { theme } = portal.theme.use();
  return h("button", { onClick: () => portal.theme.set(theme ? null : "my-theme/dusk") }, theme ? "Portal colours" : "Dusk");
} });
```

`extensions/themes` in the repository is the example of an extension that is
only themes: seven of them (Forest, Ocean, Rose, Amber, Mono, Dusk and Warm),
each a whole theme in the one `package.json`.

## What is loaded, and when

The portal loads the browser half, the server half and the themes of every
package that is installed in the portal and switched on. Installing, removing, updating or
switching one takes effect in the server and in every open page, without a
reload or a restart: at once in the page it was done from, and within five
seconds in the others, wherever it was done (another tab, the API, an agent).
Every page asks for the list of chats every five seconds, and is told with it a
revision of what is installed: of every package, one that brings nothing to the
page included (a pi half, skills, prompts), and of where each server half
stands, so that a crash reaches every open page too
([When the server half crashes](#when-the-server-half-crashes)). When that is
not the revision the page last went through, the page goes through what is
installed again, and Settings → Extensions lists it again.

Each half has a revision of the files it is made of: for the browser half the
files of its web folder, for the server half those of the folder its module is
in, the folders below included, but not `node_modules`, nor a file or folder
whose name starts with a dot. A file changed, added, removed or renamed there
is another revision. Of a folder with more than 1,000 such files, the first
1,000 count, each folder's entries taken by name: a change to a file past them
alone is not another revision. The module and the stylesheet always count.

A browser half is fetched under its revision: installing a package again from
its folder after you changed a file of its web folder swaps the new one into
every page, in place, and a page loaded again has it too. Every file the module
imports by a relative address is fetched under the same revision, so the new
one comes with the files of its own revision, not with those the page had.

A server half is started again when its revision changes, and its module and
every file of its folder it imports by a relative address or a `file:` URL are
loaded under that revision, as new modules: the half runs its files as they are
now, and keeps nothing of the revision before but what it keeps itself
([Where it keeps things](#where-it-keeps-things)). Started again at the same
revision, as when it is switched off and on, it runs the modules already loaded.
Node loads once, for as long as the portal runs, what it imports by a bare name
(a dependency in `node_modules`, `node:fs`), a file outside its module's
folder, and a CommonJS file (a `.cjs` file, a `.js` file of a package that is
not `"type": "module"`, or anything loaded with `require()`), whether imported
or required: a change to those needs a restart of the portal. A server half in
[a process of its own](#a-server-half-in-a-process-of-its-own) is a new process
at each start, which reads every file it loads anew, CommonJS files and
`node_modules` included; its revision still covers only its folder. A server half
whose module is at the package's root has all of the package as its folder,
the web folder too, so a change to the browser half starts it again as well. A
module in a folder of its own keeps the two apart, but what it then imports
from the rest of the package, outside its folder (a file both halves use), is
outside its revision and loaded once. Node keeps every module it has loaded, so
each revision a server half was started at stays in the portal's memory until
the portal restarts.

The first revision of a server half that the portal starts is loaded as Node
loads any module, so until the half is started at another, a file of its folder
that something else in the portal's process imports (a test, or the package's
pi extension where pi leaves the file to Node, see below) is the same module
the half has. After that, what imported it keeps the first revision's module,
beside the half's new one, each with what it holds. So share what the halves
hold through [`chats.extend`](#tools-that-share-the-server-half-s-state), whose
tools are made in the server half, or what `chats.tell` and `chats.onEvent`
carry, not through a module both import.

A new revision of a server half that cannot start is off, with the reason
beside the package in Settings → Extensions; the revision before it is not
started again. Its files have been replaced already: only its server half's
code already loaded would be the old one, beside the new files of its browser
half and its pi extension.

pi reads a pi extension's `.ts` files again each time it loads it, and its
`.js` files where the package is not `"type": "module"`. A `.js` file of a
`"type": "module"` package, the extension's entry too, and `.mjs` and `.cjs`
files, it leaves to Node, which keeps them for as long as the process pi runs
in: the portal's, where pi runs on the host. A change to those needs a restart
of the portal. A pi extension whose own files are `.ts` files is read again
whole.

Installing, removing, updating or switching a package also loads the open chats
again, for their pi to have the package's pi extension and what its server half
adds as they are now: an idle chat at once, and one that is working at its next
step, between two requests of its run (see
[a chat that is working](/guide/extensions#a-chat-that-is-working)). So does
saving pi's `settings.json` in Settings → **Advanced**.

Of two installed packages that go by one name, the first is the one, whole.

The browser halves are loaded at the same time, so which one comes into the
page first is not something to rely on. Wherever the portal has to choose
between extensions (the order of their entries in a slot, which of two shortcuts
wanting one key has it, whose command answers to a name, the order of their
themes in the picker) it goes by the order of the list of installed extensions,
the same on every load.

A package that a chat's folder brings (`.pi/` in a project) never has either
half loaded. The agent can write that folder, and what it put there would run
in the page of everyone who opens the portal, or in the portal itself.

::: warning Both halves are trusted like the rest of the package
A browser half runs in the portal's own page, with the login of whoever is
looking, and can do what that person can. A server half runs in the portal's
process. That is no more than the package's pi extension can already do, but
it is one more reason to install packages you trust.
:::

A half that fails to load is left out, with the reason beside the package in
Settings → Extensions, and for a browser half on its page's address and in the
browser's console. A browser half has fifteen seconds to be fetched and
called, and the others do not wait for one that takes longer. It is tried
again the next time a package changes, and the themes its `package.json` names
are there to choose all the while. A component that fails to draw takes down its own panel or
page, and a server half's handler that throws is answered as an error; the
rest of the portal goes on. A server half that crashes is stopped and held off
([When the server half crashes](#when-the-server-half-crashes)).

A page tells the portal when a browser half fails there, with the revision that
failed and where it failed (`POST /api/extension-ui/failures`): when it fails to
load or to draw, when a handler of its throws (what its server half or its
extension in a chat said to it, a shortcut), and when something it runs of its
own throws and nothing catches it (a timer, a promise, a click handler), told
apart by the address its files come from. Each failure is told once per page.
The portal keeps the latest for each package until another revision of it is
installed, and says it with the package (`clientError` and `clientStack` in
`GET /api/extension-ui`). Settings → Extensions shows it beside the package in
the page it failed in at once, and in any other page that goes through what is
installed after that: one opened or reloaded later, and every open page once
what is installed next changes.

A page that could not take an extension's old version out cleanly as what is
installed changed, because something that version had put into the page threw
as it was undone (the function its module gave back to be called as it goes,
say), names it in a line at the top, with **Reload**: what that version left may
still be at work beside the new one until the page is loaded again. Nothing is
said where every change went in cleanly.

A browser half that breaks the whole page, or keeps it from answering, can be
switched off all the same: open the portal with `?extensions=off` on its address
(`/settings/extensions?extensions=off`). That page loads no browser half, and
Settings → Extensions lists every package, with its switch and Remove. An
extension's own page opened that way says so.

### The extensions a portal starts with

The extensions in the portal's own `extensions/` folder are packages like any
other. `extensions/defaults.json` names those a portal starts with: each is
installed once, as Discover installs one, and is an installed package from then
on, switched off or removed the same way. One removed stays removed, and one
already installed under its name, from anywhere, is left as it is, so your own
can take its place. A portal that is updated installs what the list adds, once.

Nothing in the portal's own code imports them, and none of them imports the
portal's code: `npm run check:boundaries` holds that line, and CI runs it.
What they need of the portal they get the way your extension does, through
the `portal` they are given.

Each keeps its tests beside its code, in `test/`, so removing its folder takes
them with it, and the image leaves them out:

- `test/*.test.mts`: unit and server tests, run by the portal's `npm test`;
- `test/browser/*.spec.mts`: browser specs, run by Playwright with the
  portal's own;
- `test/browser/<page>.page.tsx`: a page of its own for those specs, served by
  the portal's dev server at `/tests/extension.html?page=<folder>/<page>`.

A test may reach into the portal's code and its test helpers
(`tests/helpers.mts`, `tests/browser/portal-mock.ts`); the extension's own code
may not. A browser spec says what the portal has installed, which is nothing
unless it does: `test.use({ installed: ['extensions/git'] })`, by folder from
the repository's root. The portal's own specs never install one of these: where
they need an extension's panel or window, they install a stand-in,
`tests/fixtures/extensions/console`, so that any extension that comes with the
portal can be removed without a spec of the portal's failing.

## Keeping it fast

- Say what you use of the chat: `portal.chats.use(chat.id, pick)`.
- Keep what the server half tells you in the module, not in a component, and
  have components read it from there.
- Load what is heavy when it is first needed: `import("./editor.js")` from
  your web folder.
- A status your pi extension refreshes on a timer does not keep the chat's
  agent up, and neither does what it sends its browser half. Hold the agent
  only while work is going on, with `portal.chats.hold`.

## What the portal's own apps use

The terminal, Git, Files, Canvases, Media, Browser, Voice, Understory and
Subagents are extensions (`extensions/terminal`, `extensions/git`,
`extensions/files`, `extensions/canvas`, `extensions/media`,
`extensions/browser`, `extensions/voice`, `extensions/understory`,
`extensions/subagent`). This is what each of them takes
from the portal, and what gives the same to an extension:

| The portal's app uses | An extension has |
| --- | --- |
| Routes that work with no agent running: listing, saving, renaming, deleting, downloads | `portal.router`, `chats.folder`, and [`portal.files`](#a-chat-s-folder) for the folder itself |
| Uploads and pictures | The portal's own routes for them (`/api/sessions/:id/upload`, `/picture`), which its message box and conversation use too |
| A shell and its stream, ended with the login it was opened under; cleanup when a chat goes | The server half, `http.upgrade` or a stream route, `http.endWithLogin`, `sandbox.personEnv`, `chats.on("deleted")` |
| What the agent read, wrote and ran, as it happens | `portal.chats.use(chat.id, pick)` |
| Tools that write to what the pages show (canvases, pictures) | `chats.extend`, `chats.send`, `chats.onOpen`, `chats.onEvent` |
| Tabs and a count in a panel's head, a fullscreen button | `header`, `actions`, `panel.state` |
| A button only when there is something to open, with a dot while it runs | `useButton` |
| "Discard your changes?", and staying open when a third panel opens | `panel.guardClose`, `panel.keep` |
| One panel asking another to show a file, and staying open beside it | `panel.open("files", { path })`, `portal.commands` |
| "Open in Files" only where there is a Files | `portal.panels.useHas("files")` |
| A window in voice mode that shows the file of the card that was tapped | `opened` given to its `voice.window`, `opensFor(call, chat)` |
| Its name in the page's language | `title` with `msg()`, and `locale.add` |
| git and gh in a chat's folder, safely, with a write at a time | `portal.git.at(folder)` |
| What changed in the history it shows, counted and dated in the page's language | `portal.tp`, `portal.tc`, `portal.tx`, `portal.format` |
| Its components styled with the portal's utilities | `buildExtension` with `tailwind: true` |
| A card of its own for its tool in the conversation | `chat.tool` |
| A window over the chat; chips above the message box | `chat.overlay`, `chat.composer.above` |
| Opening itself when the agent makes something | `chat.background` |
| A window in voice mode, at the side, opening itself when the agent runs a command and when its card is tapped | `voice.window` with `place`, `useAutoOpen`, `opensFor` |
| A document written live as the model writes the call, only for a call that will run | `chats.onEvent`, `chats.offers` |
| A document drawn as the model writes the call, before the tool runs and saves it | `calls` and `call(callId)` in `portal.chats.use` |
| Its tools' cards in voice mode saying what they do, and its tools telling a spoken turn to keep it short | `describe` on its `voice.window` or on its `chat.tool` entries; `voiceGuidelines` on its tools |
| The picture a tool is making, small on its card in voice mode | `tile` on its `chat.tool`, drawing `ui.ImagePreview` with `compact` |
| Tools that are there only while their endpoint is set up, listed in Settings → Tools before a chat has had them | `tools.offer`, and `chats.reload()` once a save changes them |
| A tool whose pictures the person approves one by one; one that reads outside content, goes to an address, or sends things out | `guard` on the tool: `files` (`approvalFiles` in the older spelling), `outside`, `reaches`, `acts` |
| A store of its own, a database and files the agents cannot reach, and native packages (better-sqlite3, sharp) | `dataDir()`, and the dependencies in its own `package.json` and lock |
| What the portal kept of it before it was an extension | `portal.handoffs` |
| Pictures and clips sent from its own folder, as the portal sends its own | `files.open(dataDir(), …)`, `http.send` |
| A deleted chat's pictures kept as its folder's, named as the person calls the folder; a deleted project's gone with it, also one deleted while it was switched off | `chats.on("deleted")`, `folders.label`, `folders.on("removed")` |
| A gallery whose filters are in its address, so that a link keeps them and Back goes through them | `portal.useLocation()`, `portal.navigate(path, { replace })` |
| The portal's picture viewer, a dialog, and the buttons over a picture | `ui.ImageViewer`, `ui.Modal`, `ui.classes.viewerButton` and `iconButton` |
| A viewer of its own over the whole page, styled with its utilities, leaving as the portal's dialogs do | `createPortal` into an element with its `data-extension`, `ui.useLeaveRef("dialog")` |
| "Delete this document?" only for someone who wants to be asked | `ui.asksBeforeDeleting()` |
| "Open in the agent terminal" on the card of a shell call | `chat.tool.action` |
| Watch on the call that started a subagent, without opening its card | `chat.tool.action` with `head` |
| A chip in the running tray for each subagent at work | `chat.tray`, `ui.TrayChip` |
| Its row in the chat's model menu, there as the menu opens | `chat.model.menu`, fetched with the chat in `chat.background` |
| A subagent's run drawn as the chat draws its own, with the tool cards extensions bring | `ui.Transcript`, `ui.Ring`, `ui.Shimmer`, `format.elapsed` |
| A key in voice mode (T for the terminal) | `portal.shortcuts.register` |
| Being opened by name from anywhere (`terminal`) | `name` on its `chat.panel` |
| The running tray's jobs opening its Jobs tab, and the jobs themselves | The `jobs.show` command; `background` in `portal.chats.use` |
| An emulator fetched only when its tab is opened | `ui.lazy` |
| A page in the sidebar; a page in Settings | `nav.page`, `settings.page` |
| Its page in Settings with its own name and mark, groups that fold, a question before what was typed is lost, and links to it from its page | `title` and `icon` on its `settings.page`, `ui.DetailsGroup`, `ui.useUnsavedDraft`, `portal.navigate("/settings/x/<package>")` |
| A window in voice mode that can fill the stage, with a page in it that is not loaded again each time | `maximizable`, `keepLoaded` and `restore()` on its `voice.window` |
| A page in the sidebar only once its service is set up | `useShown` on its `nav.page` |
| A container of its own, and the one the portal made before it was an extension taken over by its name | `requires` with `pithagoras-docker`, `extensions.use`, `containers.adopt` and `volumes.adopt` |
| A container on the portal's loopback, made again on its network after the portal's container was, on the GPU it was given | `sharedNetwork()`, `containers.inspect`, and `DeviceRequests` in the create body |
| A container that runs code from elsewhere, on a network that reaches nothing but the portal | `networks.create`, `networks.reach`, `networks.remove` |
| A container that comes back after the host restarts and stays stopped when the person stops it, and one made before given that as it is | `RestartPolicy: { Name: "unless-stopped" }` in the create body, `containers.update` |
| Recognising and speaking for voice mode with the voices it has, chosen once its service is up, with its model loaded while voice mode is used | `portal.voice.provide`, `voice.choose` and `voice.chosen` |
| Scripts run in its container, one at a time, and ended where they took too long | `containers.exec`, with `timeoutMs` |
| The agent's memory: its tools as an MCP server's, counted as the person's own words, and MEMORY.md left aside while it is on | `portal.mcp.set` with `trusted`, `portal.memory.hold` |
| A model server of its own for its service, passing each request to the model of the chat whose tool is asking | `portal.models.of` and `endpoint`, `chats.onEvent`, `chats.on("stopped")` |
| Links in Markdown that open a page of its own | `components={{ a }}` on `ui.Markdown` |
| Another program's web page through the portal, behind its login, with its websockets | `portal.router`, `http.upgrade` |
| Another program's screen beside a chat, black from edge to edge, with a Fullscreen in its head | `bleed`, `actions` and `panel.fullscreen()` on its `chat.panel` |
| A button in voice mode only while there is something to see | `useButton` on its `voice.window` |
| Who may use its tools, on its own page | `tools.exceptions(names)` |
| Letting go of what it kept for a chat when a routine's run is over | `chats.on("finished")` |
| A slash command | `pi.registerCommand` in the pi extension, and the channel for what it does in the page |
| The colours of everything | [A theme](#themes) |

## Extensions in their own repository

An extension is a package of its own, and it can have a repository of its own
too. `@pithagoras/extension-api` is published on npm: the types,
`buildExtension` and the portal's Tailwind preset that the extensions in this
repository are built with.

```sh
npm install --save-dev @pithagoras/extension-api esbuild typescript @types/react@18 @types/node @types/express@5
```

Code that imports `react-dom` needs `@types/react-dom@18` as well, and
`tailwind: true` needs `tailwindcss@3` and `postcss`. They are peers of the
package: it builds with the versions the extension installs. TypeScript 6 and
later want types for a stylesheet the code imports; with
`"noUncheckedSideEffectImports": false` in `tsconfig.json` it is left to the
build. The package's
[README](https://github.com/thecodacus/pithagoras/tree/main/packages/extension-api)
is a whole extension: its `package.json`, `tsconfig.json` and `build.mjs`, a
browser half and a server half.

It is installed by name in Settings → Extensions → Discover:

| From | Spec | It has to be |
| --- | --- | --- |
| npm | `npm:<name>` | Published built: `"files": ["web", "server.js"]` and `"prepack": "npm run build"` in its `package.json` |
| git | `git:github.com/<owner>/<repo>@<tag>`, or its `https://` URL | Committed built: pi clones it and installs its `dependencies`, not its `devDependencies`, and does not build it |
| A folder on the server | Its path | Built there |

The package is released with the portal and has its version: 0.2.0 is what
Pithagoras 0.2.0 gives an extension. The portal stays on 0.x while this
interface still changes, and a 0.x minor version may break an extension, so an
extension depends on `"^0.2.0"`, which takes 0.2.1 and not 0.3.0. `version` on
the `portal` an extension is given, `1`, is not the package's version: it is
the version of the interface the portal loads an extension with, raised only
when something an extension relies on changes.

### Releasing @pithagoras/extension-api

For the maintainers of this repository. The package is released with the
portal, from the portal's tag:

1. In a pull request, raise `version` to the release's in `package.json` and
   `packages/extension-api/package.json`, and in `package-lock.json` its
   `version` and the entries `""` and `packages/extension-api`, and merge it.
2. Tag the merged commit `v<version>` and push the tag:

   ```sh
   git fetch origin
   git tag v0.3.0 origin/main
   git push origin v0.3.0
   ```

The tag builds the image (`.github/workflows/docker.yml`) and publishes the
package (`.github/workflows/publish-extension-api.yml`) with npm's trusted
publishing: no token, and with provenance. The workflow stops before
publishing when the tag is not the version in both `package.json` files, and
`tests/extension-api-package.test.mts` fails while they, or the lock, differ.
Run by hand, the workflow is run on the tag.

npm links a trusted publisher only to a package that exists, so the first
version, 0.2.0, is published by hand, from a clean checkout of the tag `v0.2.0`
once that release is cut:

```sh
git clone --branch v0.2.0 https://github.com/thecodacus/pithagoras.git
cd pithagoras
npm publish --provenance=false -w packages/extension-api
```

Provenance is made only in CI. The workflow's own run on `v0.2.0` fails at
`npm publish`, as npm has no trusted publisher for the package yet; the image
is built all the same.

The trusted publisher is added when the next release after it is cut, between
steps 1 and 2: on npmjs.com, the package's **Settings → Trusted Publisher**
takes GitHub Actions, with the organization or user `thecodacus`, the
repository `pithagoras`, the workflow filename `publish-extension-api.yml`, no
environment name, and `npm publish` selected under **Allowed actions**
(`npm dist-tag` stays off). Without it, a new trusted publisher allows only
`npm stage publish`, and npm refuses the workflow's `npm publish`. A new
trusted publisher expires when no publish goes through it within 2 days: push
the tag within 2 days of adding it, and if it expires, delete it and add it
again.

## Troubleshooting

### When the server half crashes

A server half runs in the portal's own process, so an error its code throws
where nothing catches it (in a timer, a callback, a socket's event), a promise
of its own that rejects with nobody to hear it, and a call of `process.exit()`
would end the portal. They do not: each is that extension's crash.

- The portal and its chats go on. The half is stopped, and so are the halves
  that require it (`pithagoras.requires`); those that only use it where it is
  there (`optional`) start again without it.
- It stays off while the files are the ones that crashed: until another
  version of it is installed (a file of its server half changed), or it is
  switched off and on in Settings → Extensions. A restart of the portal starts
  it again as well.
- A tool of its that a chat had called, and that had not answered yet, answers
  at once with an error that names the crash and carries the half's last
  lines, so the agent reads what happened in the same turn and the chat goes
  on; so does one of its handlers in a chat's pi (`pi.on`) that had not
  returned. A later call of that tool or of its commands, in a chat that still
  has them, answers the same without running its code, and its handlers are
  no longer called; a chat that loads after the crash has none of them.
- A request to its routes that had not been answered is answered with
  `503` and the crash; one whose answer had begun is cut off.
- Settings → Extensions shows the crash beside the package, with what the
  half said last, in every open page within five seconds, as it shows an
  install ([What is loaded, and when](#what-is-loaded-and-when)); a page
  opened with `?extensions=off` reads nothing of the extensions' halves and
  does not show it. `GET /api/extension-ui` has it as `crash`, and Settings →
  Logs has every line.

What the half said is kept for it, the latest 200 lines: what it writes with
`portal.log`, the portal's own lines about it, and whatever is printed while
its code runs.

The portal knows the code as the extension's while it runs the module as it
starts, its routes and what their request, answer and upgraded socket tell it
later, its handlers (`chats.on`, `chats.onEvent`, `chats.onOpen`, upgrades,
and the rest it registers), and what it adds to a chat's pi: its tools'
calls, its handlers and its commands. So it knows what that code starts: its
timers, promises, callbacks, sockets and processes. What the portal does that
the half asks for is the portal's own: a chat told or reloaded, a chat's
model, a request its routes hand on, a turn it asks a chat's pi for
(`pi.sendMessage`, `pi.sendUserMessage`). An error from a listener it put on
something it does not own (`process.on(...)`, an emitter of another's), or
from a `queueMicrotask` callback, is known by its stack, which goes through
the folder of the server module: any file in that folder counts, a pi
extension (`pi.extensions`) kept there as well, whose uncaught error is then
counted as the server half's crash. An error that is no extension's ends the
portal, as it always has, and so does one of a pi extension kept elsewhere.

Only the frames of a stack count, not the error's message: an error of the
portal's own that names a half's folder in its message (a file of it not found,
say) is not that half's.

What this cannot stop, for a server half in the portal's process:

- Code that never yields, a loop or a long synchronous call, holds the whole
  portal, and code that takes all the memory ends it: both run in the
  portal's own process, and a restart starts the half again. Remove the
  package with `pi remove <spec>` where the portal runs (in its container),
  then restart it.
- A timer or a process the half left behind, as it crashed or as it was
  stopped, goes on until the portal restarts. Each of its errors is said in
  the log, and nothing more is done. One known only by its stack is counted
  as the running half's of that folder, where there is one.

A server half in [a process of its own](#a-server-half-in-a-process-of-its-own)
has none of these limits: a loop, memory that grows without end, a native crash
and what it left going all end with its process, which is said as its crash
("It did not let its process answer for 10 seconds…", "Its process used more
than 1024 MB of memory…", "Its process ended by SIGABRT" with V8's own words
among its last lines). A pi extension kept in its folder runs in the portal's
process all the same, and its uncaught error is the server half's crash, as
above.

## The example

`tests/fixtures/extensions/notes` uses most of this in three small files:

- `index.ts`, the pi extension: a `note` tool, and the notes kept with the
  conversation.
- `web/client.js`, the browser half: a panel with tabs in its head that asks
  before discarding a note being written, a header button that pins the
  agent's last reply, its own card for a call of `note`, a window in voice
  mode, a page of every chat's notes, a command, and its texts in German.
- `server.js`, the server half: a copy of each chat's notes in the chat's
  folder, a route that answers for all chats, and the count each page is told.

It is the portal's test extension and is not shipped: copy it to start your
own, and install your copy by its path. What the portal ships is in
`extensions/`, under **Settings → Extensions → Discover → Comes with
Pithagoras**: `extensions/themes` is an extension
that is only themes, and `extensions/docs` is a large one: a page in the
sidebar, fed by its server half's routes, a stream that tells the page of
changes, an editor built into the page, and tools for the agent that share the
server half's store ([Documents](/guide/documents), whose last section says how
it is built). Its texts are in German through `portal.locale.add`, and the
portal's tests hold it to every text it shows.

`extensions/terminal`, the [terminal](/guide/terminal) a fresh portal installs,
is the one written in TypeScript and JSX:

- `src/client.tsx` registers a panel by the name `terminal` with tabs in its
  head and a dot on them while something runs, a window in voice mode that
  asks for the side and opens on each command, an action on a shell call's
  card, a voice shortcut, and the `jobs.show` command.
- `src/AgentTerminal.tsx` and `src/Jobs.tsx` read the chat with
  `portal.chats.use`; `src/Shell.tsx` is the emulator, in a chunk of its own
  loaded with `ui.lazy`.
- `server.js` is its shell: routes, a stream ended with the login, and a
  stopper that ends every shell as the portal stops.
- `src/de.ts` is its German, which the portal's tests hold to every text it
  shows.

`extensions/git`, the [Git](/guide/git) panel, is a larger one:

- `src/client.tsx` registers a panel by the name `git`, with its tabs and the
  count of changed files in its head (`panel.state`), and opens a file in
  Files with `panel.open`. It looks again when the agent wrote a file or its
  turn ended, from `portal.chats.use`.
- `src/panel/` is the panel, styled with Tailwind utilities its build makes
  into its own stylesheet.
- `src/server.ts` is its routes, keyed by chat, and `src/git.ts` what each
  runs, through `portal.git.at`.

`extensions/media`, [Media](/guide/media), is the one with a store and packages
of its own, and the agent's tools that follow its settings:

- `src/server.ts` is its server half. Its tools (`src/server/pi/tools.ts`) are
  registered with `chats.extend` and said to the portal with `tools.offer`, as
  its settings make them there, and a save that changes them reloads the idle
  chats with `chats.reload()` (`src/server/api/settings.ts`). `show_image`,
  `generate_image`, `edit_image` and `generate_video` say what a spoken turn
  needs of them in `voiceGuidelines`, and `edit_image` names its pictures in
  `approvalFiles`.
  Its routes are at `/api/x/pithagoras-media/…`, and send pictures and clips
  with `http.send`.
- `src/server/store.ts` is its store, `media.db` in `dataDir()`, kept with
  better-sqlite3, beside the pictures and clips of its page and the small
  copies sharp makes of them. Both packages are its own dependencies, in its
  `package.json` and its lock, installed in its folder (a native package is not
  bundled).
- `src/server/handoff.ts` takes up what the portal kept of Media before it was
  an extension, the hand-off `media` (`portal.handoffs`).
- `src/client.tsx` registers the Media page (`nav.page`, at
  `/x/pithagoras-media/media`, listed while an endpoint is set up), which
  keeps its gallery's filters in its address with `portal.useLocation()` and
  `portal.navigate`; its page in Settings (`settings.page` with its own `title`
  and `icon`, at `/settings/x/pithagoras-media`); and its tools' cards in the
  chat (`chat.tool`, with a `tile` for the picture tools and `describe` on all
  five).
- `src/web/` is the page, the cards and the settings, drawn with
  `ui.ImagePreview`, `ui.ImageViewer`, `ui.Modal` and `ui.DetailsGroup`, and a
  video viewer of its own put over the page with `createPortal`.
- `src/de.ts` is its German.
