---
name: "extension-creator"
description: "Use in Creator mode, when asked to write, change, fix or install a Pithagoras extension (a tool for the agent, a page, a panel, a route): the loop of copying the template, editing it, installing it with extension_install, reading extension_status and calling the new tool, and the rules a made extension follows."
---

# Writing a Pithagoras extension in Creator mode

An extension is a pi package that also brings something to the portal: tools
for the agent, routes on the server, pages and panels in the browser. In this
chat you write one in a folder of your own, install it with
`extension_install`, and call its tools from your next step. Nothing restarts.

The folder this file is in holds `template/`, a working extension in plain
JavaScript, and `reference/`, the full guide and the API's types.

## The loop

1. Copy the template into this chat's folder, and give it its own name:

   ```bash
   mkdir -p extensions && cp -r <the folder this SKILL.md is in>/template extensions/<name>
   ```

   Then change `name` in `extensions/<name>/package.json`, and the tool's
   name, `my_extension_echo`, in `server.js`.
2. Edit it: `server.js` for tools and routes, `web/client.js` and
   `web/client.css` for what is drawn.
3. Install it: `extension_install { path: "extensions/<name>" }`. A copy of
   the folder is taken and installed; your folder stays yours to change.
4. Read what the install says of the server half. `server.running: false`,
   a `failure` or a `crash` means it does not work yet: call
   `extension_status { name: "<name>" }` for its lines, and fix the code.
5. Call its tool from your next step. Where a subagent of this chat works in
   the background, the tools come once this run ends.
6. Change something, and install again: nothing reloads by itself. Each
   install loads every half again, at its new revision.

`extension_status` with no name lists what was made in Creator mode;
`extension_remove { name }` uninstalls one and deletes its copy. Every install
and removal is in Settings → Audit, and the person can switch an extension off
or remove it in Settings → Extensions. One they switched off stays off when you
install it again.

## package.json

```json
{
  "name": "<name>",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": {},
  "pithagoras": { "client": "./web/client.js", "style": "./web/client.css", "server": "./server.js", "isolated": true }
}
```

- **One name, without a scope**: letters, digits, `-`, `_` and `.`. It is what
  everything goes by: its routes are at `/api/x/<name>/…`, its pages at
  `/x/<name>/<id>`. A name that an extension of the portal has, or that
  another installed package has, is refused.
- **`"pi": {}`**, always, and nothing in it that runs code: no
  `pi.extensions`, and no folder `extensions/` at the package's top (pi would
  load that as a pi half). A pi half runs in every chat's pi inside the portal,
  where your extension's own process does not reach. Give tools through the
  server half instead (below).
- **`"type": "module"`**, as the template has it.
- **The browser half in a folder of its own** (`web/`): the portal serves that
  whole folder to whoever is signed in, and a module at the package's root is
  not loaded.
- The template's licence is Apache-2.0; the person may change it.
- Links in your folder are left out of the copy, not followed. Install
  packages with `npm install` in the folder (npm copies them; pnpm links
  them), and the copy takes `node_modules` with it. At most 64 MB, 10,000
  files, 32 folders deep and 2,000 entries in one folder (`node_modules`
  included) are copied.

## Which half does what

| Half | Runs | For |
| --- | --- | --- |
| Server half (`server.js`) | Once, for all chats, in a process of its own | Tools (`chats.extend`), routes, what must be there when no chat is running |
| Browser half (`web/client.js`) | In each page signed in to the portal | Everything drawn: a tool call's card, a page, a panel |

A tool belongs in the server half: it is registered in every chat's pi from
there, and it shares what the routes know.

## The server half

Its default export is called with `portal`; it may return a function that
stops it. The members you will use most:

| `portal.` | |
| --- | --- |
| `chats.extend((pi, chat) => …)` | Tools for every chat's pi: `pi.registerTool({ … })` |
| `router` | An Express router: routes at `/api/x/<name>/…`, behind the portal's login |
| `http.json()` | The body parser for a route that takes JSON |
| `chats.send(chatId, data)`, `chats.onOpen(fn)` | To the pages open on a chat, heard there with `portal.server.on` |
| `chats.get(id)`, `chats.list()`, `chats.folder(id)` | A chat, the chats, the folder a chat works in |
| `files.list`, `read`, `write`, `open`… | A chat's folder, read and changed with the portal's checks: never `fs` on a chat's folder |
| `dataDir()` | A folder of the extension's own, for what it keeps |
| `log(text)` | A line in its log, which `extension_status` shows |

A tool:

```js
pi.registerTool({
  name: "<name>_<verb>",
  label: "What it does",
  description: "What the model reads to decide when to call it.",
  parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  guard: { outside: true },
  async execute(_id, params) {
    return { content: [{ type: "text", text: "…" }], details: { /* for its card */ } };
  },
});
```

- **Parameters** are JSON schema.
- **`guard`** says what it does: `outside: true` for a tool that returns what
  it read from the outside world (a page, a feed, an API), so that it is held
  as data and not as instructions; `acts` for one that changes things
  (`"persist"`, `"publish"`, `"upload"`, `"write-to-path"`…), which the guard
  then holds after a suspected prompt injection.
- **`offByDefault: true`** keeps it off in every chat until somebody switches
  it on in Settings → Tools. Without it, it is on in every chat.
- **Never one of pi's own tool names** (`bash`, `read`, `write`, `edit`,
  `grep`, `find`, `ls`…), nor another tool's: start its name with the
  extension's.

## Its own process

Every extension made here runs its server half in a process of its own, so it
has less than one in the portal's process:

- In `chats.extend`, `pi` has `registerTool`, `on`, `registerCommand`,
  `sendMessage` and `sendUserMessage`, and nothing else. Register while the
  factory runs (five seconds at most), not later.
- `execute`, a handler and a command are given no `ctx`. `renderCall` and
  `renderResult` are left out, and any other function in a tool's definition
  is refused.
- No `provide` and no `voice`. `requires` and `extensions.use` only of an
  extension in the portal's process, such as the portal's own: nothing can
  build on a half in a process of its own, another made extension included.
- It has 15 seconds to start. Keep synchronous work under 10 seconds and its
  heap under 512 MB: past either (or 1 GB of memory, on Linux) its process is
  ended, as its crash.

A crash (a throw nothing catches, a rejection nobody hears, `process.exit()`,
a loop that never ends) ends its process. A call of its tool that was running
answers at once with the crash and its last lines, and it stays off until it
is installed again: fix it, and install it again.

## The browser half

Plain JavaScript, made with the portal's React and no JSX, so nothing needs
building:

```js
export default function (portal) {
  const { React, ui } = portal;
  const h = React.createElement;
  portal.slots.register("chat.tool", { id: "card", tool: "<name>_<verb>", component: ({ call, card }) => call.status === "done" ? h("p", null, call.output) : card });
}
```

- **Slots:** `chat.tool` (a call of its tool, in place of the portal's card),
  `nav.page` (a page in the sidebar), `chat.panel` (a panel beside the
  conversation), `settings.page` (its page in Settings),
  `chat.composer.above`, `chat.header.action`.
- **`portal.chats.use(chatId, pick)`**: a hook, the chat as the page has it.
- **`portal.api.json(portal.api.url("/route"))`**: its server half's routes.
- **`portal.server.on((chatId, data) => …)`**: what `chats.send` says.
- **Colours** are the portal's variables: `rgb(var(--fg))`, `--fg-muted`,
  `--fg-faint`, `--line`, `--accent`, `--raised`, `--danger`… Give class names
  a prefix of the extension's, in its own stylesheet. No Tailwind classes:
  the page has only those the portal itself uses, and they change with it.
- `ui` has the portal's own parts: `ui.LoadFailed`, `ui.Empty`,
  `ui.RowsSkeleton`, `ui.confirm`, `ui.classes`.

## Where to look next

- `reference/extension-ui.md`, the whole guide (about 160 KB: grep it by its
  headings, `## ` and `### `).
- `reference/server.d.ts`: everything the server half's `portal` has.
- `reference/index.d.ts`: the browser half's `portal`, and every slot.
- `/app/extensions/kanban/src`: a full extension, written in TypeScript.
