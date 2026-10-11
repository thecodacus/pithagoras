# Settings

Settings open from the bottom of the sidebar, or `/settings`. There is a search
box at the top: it finds a setting by name or by what it does, in English or
German. Navigation runs down the left edge, in four groups:

| Group | Pages |
| --- | --- |
| **Models** | **Providers** — where models come from, see [Models and providers](/guide/models); **Defaults** — model, effort and context for new chats |
| **Agent** | **Tools**, **Images**, **Skills**, **MCP**, **Extensions** |
| **Reach** | **Channels**, **People** |
| **Portal** | **This browser**, **Add-ons**, **Shortcuts**, **Logs**, **About**, **Advanced** |

Plus a page for every extension that exposes configuration.

There is no Session tab. Model, effort and context all live on the pills under
the composer, and a second copy here would be two places to keep in sync.

The pages are built from the same few pieces. Something that takes effect the
moment it is clicked is a switch, and a choice between a few things is a row of
buttons of which one is picked; a screen reader says which, as "on" or "off" and
as picked or not, and not only the colour does. An off switch has an edge you can
see in the light theme too. A page with a **Save** button shows **Saved** beside
it for two seconds, counted from the last save.

A page that cannot read what it shows, because the portal was restarting or could
not be reached, says so in red with the reason and a **Try again** button, in the
place of its list. It does not show an empty list or "Nobody yet" as if that were
what the portal holds. The same goes for the Projects, Audit and Agents pages and
for the add-ons. A refresh that fails while a page is already showing something
is a message at the top of the dialog instead, and what was shown stays.

## Defaults

*(The **Defaults** page; older links call it `general`.)*

What new chats start with: provider, model, effort, the context window, how much
is kept when a chat is compacted, and where routines report. The fields are
described in [Models and providers](/guide/models#defaults).

The fields show **only your explicit overrides**. Leave one empty and it
inherits, with the inherited value shown as the placeholder. Clearing a field
hands the setting back to pi; clicking the active effort level again unsets it.

This matters more than it sounds. An earlier version prefilled each field with
the *resolved* value, so one click of Save pinned an inherited setting forever —
which is how a portal could end up permanently stuck on a model nobody chose.

### Where a model comes from

Resolved in order, first match wins:

1. The session's own choice, from the pill under the composer
2. A portal override, saved on **Defaults**
3. `PI_PROVIDER` / `PI_MODEL` / `PI_THINKING_LEVEL` in the environment
4. `defaultProvider` / `defaultModel` / `defaultThinkingLevel` in pi's `settings.json`
5. A last-resort constant

Steps 4 and 5 are the point: an install configured through the pi CLI behaves
the same in the portal without being configured twice.

::: tip Models from extensions
A model provided by an extension — anything under a `llama-server=…` provider —
does not exist until extensions are bound, which happens after the session is
created. The portal resolves the model a second time after binding. Without
that, a session asking for a local model silently started on pi's fallback.
:::

## Tools, Skills and MCP

**Tools** sets which tools every conversation starts with, see
[The interface](/guide/interface#tools). **Skills** lists, creates, imports and
switches the agent's procedures, see [Skills](/guide/skills). **MCP** manages MCP servers, see
[MCP servers](/guide/mcp).

**Images** holds the image endpoint behind generation and editing, including the maximum picture size of an edit, and the
switches for **Image generation**, **Image editing**, **Several pictures per edit** and **Stable Diffusion extra settings**, see
[Opt-in features](/guide/features#image-generation). The first two switch the feature on or off as a whole: the
[Images page](/guide/images) and the existence of the tools. Whether a chat's agent gets the tools,
`show_image`, `generate_image` and `edit_image`, is set only in the Tools list, where they are together in one **Images** group. **Stable Diffusion extra settings** (off by default) is
for an endpoint that is a stable-diffusion.cpp server: it lets the Images page offer and send the settings only that server
reads, see [Images](/guide/images#stable-diffusion-settings). The tools do not use it.

## Channels

Two-way links into the agent, and the packages that provide them. See
[Agent and channels](/channels/).

## Extensions

Install, update and remove pi packages, from npm, a git repository, a URL or a
local path. The list comes from the server's parsed view of `pi list` — the
browser used to re-parse it and listed some packages twice.

Any extension whose settings the server can recover gets its own page in the
navigation, with a field per key.

::: warning Recovered, not declared
pi publishes no schema for extension settings — extensions simply read keys off
the settings object. The portal recovers them by reading the package source,
which is a heuristic: a key built dynamically at runtime will not appear. Use
Advanced to edit `settings.json` directly when that happens.
:::

## This browser

What is kept in this browser rather than on the server, so a phone can differ
from the laptop: the theme (light, dark, or following the system), animations,
language, notifications, the command character, confirmations and sign-out. See
[The interface](/guide/interface) and
[Slash commands](/guide/commands#the-command-character).

**Confirmations** is the one question the portal asks before it deletes
something, and whether it asks it.

### Notifications

A switch. Turned on, the browser asks for permission once, and after that a chat
that finishes or an extension that needs an answer says so while you are on
another tab or window. Nobody is told about the chat in front of them. It needs a
secure connection — HTTPS, or `localhost` — because browsers do not offer
notifications over plain HTTP; the switch says so where it is unavailable. A chat
that is not open is noticed too: while one is running and notifications are on,
a hidden page keeps checking every fifteen seconds.

### Sign out

Appears when the portal has a password. It signs out this browser only, and the
login it held stops working anywhere a copy of its cookie was taken. A login that
runs out — after thirty days, or when the portal restarts without
`PORTAL_SECRET` — brings the password screen back rather than failing every
request with *Unauthorized*.

### Language

The portal speaks English and German. **Language** picks one, and is kept in this
browser like the theme; until one is picked it follows the browser's own
language, and English where there is none of its own. Dates and numbers are
written the language's way. It changes the portal's words only: what the agent
writes is up to the agent, and messages that come from the server — an error it
reports, a channel's own description — stay as they are.

A language is one file in `web/src/locales/`, named by its language code
(`de.ts`), mapping each English text to its own; adding one means adding that
file, and the tests list what it lacks. A page fetches only the file of the
language it is in, so an English page does not carry the German text.

## Add-ons

Installs the optional parts of the portal itself: Browser, Voice, Subagents and
Memory, see [Docker add-ons](/guide/add-ons) and
[Opt-in features](/guide/features).

## Logs

What the portal's server prints, which used to be readable only on the host. The
newest lines are at the bottom and the list follows them as they come, until you
scroll up to read something; scroll back down and it follows again. Errors are
red and warnings amber. **Warnings and errors** and **Errors** hide the rest, and
the search box keeps the lines that contain what you type. An uncaught exception
and node's own warnings are in the list too, not only what the portal logs itself.

**Download** saves everything the portal still holds as a text file, one line per
entry with its time and level, to attach to an issue. The portal keeps the last
2000 lines in memory, so a restart starts the list again; for what happened before
one, the host's own log (`docker logs` for a container) is still where to look.
Lines of the chats' own tools, and of containers, are not in it.

## About

Where this portal keeps what it keeps, set when it was deployed through its
environment: whether the agent runs on this host or in a container per chat, the
workspace root where each chat's folder is made, and where pi keeps its files
(`settings.json`, `models.json`, `auth.json` and installed packages).

## Shortcuts

Every keyboard shortcut, in one list. The voice-mode ones can be changed: choose
**Change** and press the new keys, with any modifiers. **Clear** leaves an action
without one, **Reset** puts its default back, and **Reset all** puts back every
default. A key that another action already has moves to the one being changed,
and the list says which action lost it. `Tab` cannot be a shortcut — it is how
the keyboard moves on to the next button — so pressing it while listening ends
the listening and moves on. Shortcuts are kept in this browser.

A shortcut is the physical key, so it stays the same key whatever the keyboard
layout, and it is shown with the label on this keyboard where the browser can
tell (Chromium can). The chat's own keys — the command character (`/` unless
you chose another, under **This browser**), Enter, Shift+Enter and Escape in
the message box — are listed there too, and are fixed.

## Advanced

pi's raw `settings.json`, edited in place. It is validated as JSON before
writing — a broken file stops every future session from starting, so an invalid
save is refused rather than accepted. It has to be an object, and what a save
replaces is kept beside the file as `settings.json.bak`.

If you edit the file by hand and leave it unreadable, the other places that
write to it (the compaction slider, the extension switches and forms) refuse to
change it and say so, rather than starting over from an empty file and losing
your packages and defaults. Put it right here, or in your editor, and save
again.
