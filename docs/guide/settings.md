# Settings

Settings open from the bottom of the sidebar, or `/settings`. There is a search
box at the top: it finds a setting by name or by what it does, in English or
German. Navigation runs down the left edge, in four groups:

| Group | Pages |
| --- | --- |
| **Models** | **Providers** — where models come from, see [Models and providers](/guide/models); **Defaults** — model, effort and context for new chats |
| **Agent** | **Tools**, **Modes**, **Sandbox**, **Guard**, **Skills**, **MCP**, **Extensions** |
| **Reach** | **Channels**, **People** |
| **Portal** | **This browser**, **Authentication**, **Shortcuts**, **Logs**, **About** (with **Update** and **Restart**), **Advanced** |

Plus a page for every extension that exposes configuration, under **Extension
settings**: [Media](/guide/media)'s is **Media**, at
`/settings/x/pithagoras-media`.

Each group folds under its heading: a click, or Enter or Space on it, hides its
pages and shows them again, and the arrow beside the name says which it is. All
of them are open until you fold one, and what you fold stays folded in this
browser, through closing Settings and reloading the page. The group of the page
showing is held open, so the page marked as the current one is always in the
rail: a search, a link or an address that goes to a page in a folded group
finds the group open, and it folds again once you go to a page in another
group. While it is held, its heading does nothing. The search lists what it
finds whatever is folded. On a phone, folding a group keeps you in the list of
pages; it does not open one.

The dialog takes the room the screen has: nearly all of a laptop's, and three
quarters of the width of a wider one. Every page uses that width. Lists
(providers, skills, MCP servers, channels, people, extensions) stand two
abreast, three on a very wide screen, and there a form's sections stand in two
columns so that no field runs the whole width.

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
for the **Subagents** page under **Extension settings**. A refresh that fails while a page is already showing something
is a message at the top of the dialog instead, and what was shown stays.

## Defaults

*(The **Defaults** page; older links call it `general`.)*

What new chats start with: provider, model, effort, the context window, how much
is kept when a chat is compacted, and where routines report. The fields are
described in [Models and providers](/guide/models#defaults).

At the end of the page, **Voice mode** holds what voice mode does whatever
listens and speaks for it: whether voice conversations are offered at all (off,
only dictation is), speech detection, the speaking instructions, the model that
answers spoken messages and the providers that reply without thinking first,
each saved as it is changed. It names voice mode's source too, says whether it
is running, and has a button to its page and **Stop using**: see
[Voice mode's settings](/guide/voice#voice-mode-s-settings).

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

**Guard**, beside **Sandbox**, is the [guard](/guide/security)'s page: the rules that hold after a suspected
injection, each routine's exemptions from them (one switch per rule), which MCP servers count as your own and are
not marked as outside content (the portal's own memory server until you say otherwise, and a server an extension counts
so when you switch it on from its page; the browser never), the sites
the agent's tools may reach (one list, one domain per line, for every tool that says where it goes and for the browser
tools an MCP server brings; an empty list means any site; saved with its **Save** button), the approvals not yet spent
and the flagged results you trusted, each of which can be taken back, and what is always on. Each other change is
saved as it is made.

**Tools** sets which tools every conversation starts with, see
[The interface](/guide/interface#tools). **Subagents**, under **Extension
settings** while the subagent extension is on, sets how the subagent tool runs;
the extension is switched in **Extensions**, see
[Opt-in features](/guide/features#subagents). **Skills** lists, creates, imports and
switches the agent's procedures, see [Skills](/guide/skills). **MCP** manages MCP servers, see
[MCP servers](/guide/mcp).

**Browser**, under **Extension settings** while the [Browser](/guide/browser)
extension is installed, installs, starts, stops and removes the agent's browser,
with the password of its web UI and how the download of its image goes; see
[Installing it](/guide/browser#installing-it). The voice service and Voice
servers, which voice mode can listen and speak through, and Understory, the
agent's memory, are extensions with pages there too: see
[The voice service](/guide/voice-service), [Voice servers](/guide/voice-servers)
and [Memory: Understory](/guide/features#memory-understory).

**Media**, under **Extension settings**, is the page of the [Media](/guide/media)
extension. It has two sections, **Image model** and **Video model**. Each has its **switches** at the top, always in view,
and under them a heading with a line under it, which opens and closes the section with a click; what opens is directly
under the heading. The line says what the section is for
while it is open, and the address and model while it is closed. A model that is not set up starts open, to show its
address; one that is set up starts closed, and what you open or close is kept in this browser. A section with something
typed in it and not saved stays open, and the search of Settings opens the section, or the group in it, that it finds.

**Image model** holds the image endpoint behind generation and editing, including the maximum picture size of an edit, and the
switches for **Image generation** and **Image editing** (always in view), and **Several pictures per edit** and **Stable Diffusion extra settings** (under **More options**). The image endpoint is in the section; **Editing endpoint**, a group of its own that opens and closes, holds the address, key, model and maximum size for editing, which are empty when editing uses the image endpoint. See
[Opt-in features](/guide/features#image-generation). The first two switch the feature on or off as a whole: the
[Media page](/guide/media) and the existence of the tools. Whether a chat's agent gets the tools,
`show_image`, `generate_image` and `edit_image`, is set only in the Tools list, where they are together in Media's group, `pithagoras-media`, with the video tools. **Stable Diffusion extra settings** (off by default) is
for an endpoint that is a stable-diffusion.cpp server: it lets the Media page offer and send the settings only that server
reads, see [Media](/guide/media#stable-diffusion-settings). The tools do not use it.

**Video model** holds the video endpoint behind video generation: its address, key, model, size, frames and frame rate, the time
limit, the disk limit, and the switch for **Video generation**, see
[Opt-in features](/guide/features#video-generation). The switch turns the feature on or off as a whole: the
[Media page](/guide/media) and the existence of the tools. Whether a chat's agent gets the tools, `generate_video` and
`show_video`, is set only in the Tools list, in the same group.

## Modes

Your own [chat modes](/guide/sessions#modes-you-make): the ways a chat can work
that the menu above the message box of a new chat offers after Standard and
Code mode. The page lists them, and **New mode** makes one from a name and a
description and opens it. A mode's page has its name, description and
instructions, saved with **Save**; the model and effort a chat put in it starts
on, which use the same menus as **Defaults**; whether its chats work through
the code tool; and its tools, the same list as a project's. Each of those is
saved as it is changed. The bin at the top deletes the mode, after asking.

## Channels

Two-way links into the agent, and the packages that provide them: Telegram,
Slack, Discord, Signal and a webhook ship with the portal. See
[Agent and channels](/channels/), and [Signal](/channels/signal) for setting up
signal-cli and linking it to your phone.

## Extensions

Install, update and remove pi packages, from npm, a git repository, a URL or a
local path. The list comes from the server's parsed view of `pi list` — the
browser used to re-parse it and listed some packages twice.

Any extension whose settings the server can recover gets its own page in the
navigation, with a field per key.

The list follows what is installed elsewhere (another tab, the API, an agent)
while it is open. Beside a package is why a half of it is not working: its
server half could not be started, or crashed (with what it said last), its
interface could not be loaded in this page, or its interface failed in a page:
in this one, or in another before this one last went through what is installed
(when it was opened, or when what is installed last changed). A page that one of them breaks is opened with `?extensions=off` on its
address (`/settings/extensions?extensions=off`): it loads no extension's
interface, and the package can be switched off or removed here. See
[What is loaded, and when](/guide/extension-ui#what-is-loaded-and-when).

A package in an extension's own data folder says **From** that extension: one
the extension installed itself ([Extensions it installs](/guide/extension-ui#extensions-it-installs)),
or one installed from there by its path. Where the extension installed it, the
note it gave is under it, as the extension wrote it, and pointing at the pill
says when.

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
login it held stops working anywhere a copy of its cookie was taken. With
**End the session at the provider too** under [single sign-on](#single-sign-on),
the browser goes on to the provider's sign-out page. A login that
runs out — after thirty days, or when the portal restarts without
`PORTAL_SECRET` — brings the password screen back rather than failing every
request with *Unauthorized*.

A password that is shorter than 8 characters, which an older portal took from
`PORTAL_PASSWORD` and which is kept because it was already in use, is said here
too, with where to change it: **Authentication**.

### Language

The portal speaks English and German. **Language** picks one, and is kept in this
browser like the theme; until one is picked it follows the browser's own
language, and English where there is none of its own. Dates and numbers are
written the language's way. It changes the portal's words only: what the agent
writes is up to the agent, and messages that come from the server — an error it
reports, a channel's own description — stay as they are.

A language is one file in `core/web/src/locales/`, named by its language code
(`de.ts`), mapping each English text to its own; adding one means adding that
file, and the tests list what it lacks. A page fetches only the file of the
language it is in, so an English page does not carry the German text.

## Authentication

How people sign in to the portal: the password, and single sign-on through an
OpenID Connect provider beside it. Both are on this one page. The password's
part is open; single sign-on is a section that opens and closes, closed at first,
and says while it is closed whether it is off or which provider it uses (with
"OIDC only" where the password login is switched off). A search for one of its
settings opens it.

With `PORTAL_ALLOW_NO_PASSWORD=1` there is no login, and so no password and no
single sign-on; the page says so.

### Password

The one password that signs in to the portal, kept in its database as a salted
scrypt hash and never in a file you have to protect. A portal that has none yet
asks for one on its first start, in the browser; see
[Deploying](/guide/deploying#the-password).

**Change password** takes the current password once and the new one twice, which
has to be at least 8 characters and not `change-me`, the example the older
guides gave. Every other browser is signed out by the change and asks for the new
password. What is open under the old password is closed in every browser, the one
you changed it in too, since a copied cookie must not keep its streams: a chat's
live view, a terminal, the agent's browser. The page you changed it in stays signed
in and opens them again by itself, with its new login. Wrong current
passwords are counted on their own, apart from the sign-in's: after ten from one
source in fifteen minutes the page is told to wait, and not even the right one is
taken until the time is up.

A lost password is not recovered here (you cannot get in to this page
without it): it is removed with a command on the server, see
[Deploying](/guide/deploying#a-lost-password).

### Single sign-on

Signing in through an OpenID Connect provider, beside the password or instead of
it; how to set up the provider's side, and what each field means, is in
[Deploying](/guide/deploying#single-sign-on).

- **Provider**: the issuer URL, the client ID and secret, the redirect URL (filled
  in from the address the page is open at), the scopes and the name on the login
  page's button. The secret is never shown again once saved: an empty field keeps
  it for the same issuer and client, another one asks for it again, and **Remove the
  kept secret** is for a public client. There is no list of who may sign in: that is
  decided at the provider, and every account it signs in gets in.
- **End the session at the provider too**: signing out of the portal goes on to the
  provider's sign-out page.
- **OIDC only**: the password form is hidden and the password login refused. If the
  provider stops letting you in, `npm run sso-only-off` on the server switches the
  password login back on; see [Deploying](/guide/deploying#oidc-only).

**Save** asks for the portal's current password, and the provider is read before
anything is kept: settings it does not answer to are refused with its reason. A
change to the provider or to **OIDC only** signs out every other
browser; this one stays signed in. **Take out single sign-on** removes the button
and the settings, after asking. Wrong passwords here are counted like those of
**Change password**; settings refused after the right password are not.

## Logs

What the portal's server prints, which used to be readable only on the host. The
newest lines are at the bottom and the list follows them as they come, until you
scroll up to read something; scroll back down and it follows again. Errors are
red and warnings amber. **Warnings and errors** and **Errors** hide the rest, and
the search box keeps the lines that contain what you type. Node's own warnings
are in the list too, not only what the portal logs itself.

**Download** saves everything the portal still holds as a text file, one line per
entry with its time and level, to attach to an issue. Read the file first and
remove what is personal before you attach it: it can hold folder paths on the
host, chat ids, the identifiers of people who wrote to a channel, and the file
paths an agent was refused. The portal keeps the last 2000 lines (and no more
than about 2 MB of text; both can be changed, see below) in memory, so a restart
starts the list again; for what happened before one, and for a crash, which ends
the process and the list with it, the host's own log (`docker logs` for a
container) is still where to look.
Lines of the chats' own tools, and of containers, are not in it.

**Debug lines.** The portal writes at the `info` level unless it is started with
`PITHAGORAS_LOG_LEVEL=debug` (a container needs it in its environment: both
Compose files pass it from `.env` or the shell, see
[Deploying](/guide/deploying#environment)). At `debug` the list, the file and the
host's log also carry lines marked `DEBUG`, shown in a fainter colour. So far
they follow the tool calls and the approvals:

```
[tool] start tool=bash session=k3Vx9aPq_zLm
[tool] end tool=bash outcome=ok ms=1520 session=k3Vx9aPq_zLm
[audit] refused tool=bash session=k3Vx9aPq_zLm
[approval] asked question=h7mq tool=bash session=k3Vx9aPq_zLm immediate=true
[approval] answered question=h7mq tool=bash outcome=once waited_ms=48210 session=k3Vx9aPq_zLm
```

A tool call has a line when it begins and one when it ends, with how it ended
(`ok`, `error`, or `cut-off` when the chat's pi or a subagent stopped under it)
and how long it ran in milliseconds. An approval has the question's short id,
the tool, what the answer was (`once`, `always`, `denied`, or `answered` for a
question that was not about an action) and how long the person waited for it.
`subagent=` names the subagent a call ran in, and `via=tools` a call of a
[lazy tool](/guide/extensions#lazy-tools) through the `tools` tool, which is filed under the
tool it called. An `[audit]` line is a decision
of the guard that the Audit page lists as well (`refused`, `allowed-by-approval`
and the like), with its kind and the tool, without the command or the reason.
Voice, devices and web requests have no debug lines yet.

A debug line holds names, outcomes, times and ids, never what a tool was given
or returned, the action an approval was about, or the words of a message: those
can hold anything, and the lines may be attached to an issue. Whatever else
slips in is run through a filter that takes out what looks like a secret (the
values of the portal's own secret environment variables, `Authorization` and
`Cookie` headers, `token=` and `password=` pairs, the user and password of a
URL, the keys the common services issue). It is a net, not a promise, so the
note above about reading the file before you attach it holds for debug lines too.
Anything printed through `console.debug`, by the portal or by a package it
runs, counts as a debug line: below the `debug` level it prints nothing.

`PITHAGORAS_LOG_LINES` and `PITHAGORAS_LOG_CHARS` change how much is kept: the
number of lines (default 2000, from 100 to 50000) and the characters of text
(default 2000000, from 200000 to 20000000). A value that is not a whole number
leaves the default, one outside the range is brought to its nearest end, and
the start says so in the list. Debug lines count against the same limits as the
others, and every tool call adds two of them: a long session at `debug` pushes
older warnings and errors out sooner than at `info`, so raise
`PITHAGORAS_LOG_LINES` when you turn `debug` on. The line under the title of the Logs tab says
whether the debug level is on.

## About

Where this portal keeps what it keeps, set when it was deployed through its
environment: whether the agent runs on this host or in a container per chat, the
workspace root where each chat's folder is made, and where pi keeps its files
(`settings.json`, `models.json`, `auth.json` and installed packages).

### Update

A portal that runs from a git checkout of the repository, built (`npm start`,
or a service that runs `node core/server/dist/index.js` in it), can update itself, so
that nobody has to log in to the host. The folder is the one the portal itself
runs from. The section shows the branch and commit that are checked out, and how
many new commits `origin/main` has. The portal looks for them when it starts,
every six hours, and when this page opens: a `git fetch` of `origin/main`
and a count of the commits the checkout lacks. A failed look is written to the
[log](#logs) and tried again at the next time; it is not shown as an error.
`PORTAL_UPDATE_CHECK=off` leaves out the looks the portal makes by itself.

**Update** asks `origin` once more, then shows the commit you are on and the one
it would move to, and asks for a confirmation. The portal's own request names the
commit that was shown, and is refused without it (`expect`, see the
[API](/reference/api#updating-the-portal)): nothing starts from a request that
did not ask. It says how many chats and
routines are running: the restart stops them as stopping the portal does, and a
chat carries on when you send it a message. Once you confirm, the portal runs
these steps, one update at a time:

1. `git fetch origin main`
2. `git merge --ff-only origin/main`
3. `npm ci --prefer-offline --no-audit --no-fund`
4. `npm run build`
5. restarts, and this page loads again when the portal is back.

The page shows each step as it goes. Nothing is reset, forced or discarded: an
update is **refused**, with the reason and before anything is changed, when the
checkout has changes to files git tracks (files git does not track are no
reason), is not on a branch, or has commits of its own that `origin/main` lacks,
so that it cannot be moved straight to it. Fix that on the host and press
Update again.

**A step that fails.** The update stops where it is, names the step and shows the
last lines the program printed, and the portal goes on running its old build.
`npm ci` empties `node_modules` and a build writes `core/server/dist` and `core/web/dist`
as it goes, even a server build with a type error, so the update puts the three
aside (`node_modules.update-old`, `core/server/dist.update-old`, `core/web/dist.update-old`)
before the step that works on them, puts them back if it fails, and throws them
away only when the whole build has worked. What a failed step wrote is removed.
The checkout itself stays at the new commit, which the update never takes back.
What the build was made from is written in `core/server/dist/.built-from`, with the
times at which the build's own files were written, and goes aside and comes back
with the build: so after a failed build, and after any restart of the portal,
**Update** says that the build is not of the commit that is checked out and
builds it again, with a merge of whatever is new on `main` meanwhile, or without
one. A build made on the host (`git pull && npm ci && npm run build`) writes
those files again, so the record is then of a build that is not in place any more
and says nothing: the portal is not told to build what is built. A portal that
never ran an update has no record and is not told it needs a build. (Between `npm ci` and the end of the build the
running portal has no `node_modules` and no build to read from disk, as with
any rebuild in place; a power cut or a kill of the portal in that time leaves
the `.update-old` folders, which can be moved back by hand.)

**The restart.** What starts the portal again depends on how it is run.

- Run by hand, with `npm start` or `node core/server/dist/index.js` in a terminal, tmux
  or `nohup`: the portal starts a copy of itself with the command line it was
  started with, detached and writing where the portal wrote, and then stops as it
  does on SIGTERM; the copy waits until the old one is gone.
- Run as a **systemd service**, as the unit's own process (`ExecStart=/usr/bin/node
  core/server/dist/index.js`): the portal stops with status 75 and leaves the start to
  systemd. It knows from its control group and from the unit's `MainPID`, which
  is the portal or its parent. A copy that the portal started itself would be in
  the service's control group and be ended with it, so it does not start one. The
  unit has to start it again:

  ```ini
  [Service]
  WorkingDirectory=/srv/pithagoras
  ExecStart=/usr/bin/node core/server/dist/index.js
  Restart=on-failure
  ```

  `Restart=on-failure` or `Restart=always` is needed. A unit with `Restart=no` (the
  default), `on-success`, `on-abnormal` and so on would leave the portal down, so
  the check refuses the update beforehand, says why, and changes nothing. systemd
  logs the stop as a failure, status 75, and starts the portal after `RestartSec`.
- In a **systemd service's control group without being its process**: `ExecStart=npm
  start` on Debian and Ubuntu, where `/bin/sh` is dash and does not exec the
  command, so the shell and npm stand between systemd and the portal; a wrapper
  script that does not `exec` it; a job of cron, which runs in `cron.service`. The
  portal cannot tell these apart, and has to work for all of them, so it does
  both: it starts its own copy, as above, and stops with status 75. For cron, which
  does not look at the status and does not end with its job, the copy lives on.
  For a unit whose process is npm or a shell, the status passes up to systemd,
  which starts the unit again (and ends the copy with the old control group, the
  new portal turns away a second start of itself). This needs `Restart=on-failure`
  or `Restart=always` in that unit too, and the check cannot warn about a unit
  that does not have it, since it cannot tell which unit is the portal's. Better, in
  the unit: `ExecStart=/usr/bin/node core/server/dist/index.js`, or `exec` in the wrapper.
- Run by something else that restarts it (pm2, a container's restart policy,
  `while true`): set `PORTAL_UPDATE_RESTART=exit`. The portal then only stops, with
  status 75, and its manager starts the new build; started by itself too, it would
  be started twice. `PORTAL_UPDATE_RESTART=self` makes the portal start its own
  copy where it would otherwise exit.

The password is in the portal's database, so the new portal asks for it as before;
the logins that were open end with the restart, as with any restart, unless
`PORTAL_SECRET` is set (see [Deploying](/guide/deploying#environment)).

If the replacement cannot be started, the update fails at the last step, and the
portal goes on running. If the new portal does not come up, the page says after
three minutes that it has not come back, and the log on the host says why.

**Not offered.** A portal that runs from the source files with a file watcher
(`npm run dev:server`, which is `tsx watch`, or `node --watch`) has no Update
button. The watcher restarts the portal as soon as the merge changes a file,
with `npm ci` just started and its node_modules half deleted; the section says so
and suggests `npm run build && npm start`.

**The notice.** When a look finds new commits, a line at the top of every page says
*N new commits on main, update available*, with **Update** (the same question,
then the same steps), **Details** (this page) and a button to put it away until
the next new commit on main (a failed update's line can be put away the same way). A browser with [notifications](#notifications) on is
told once for each new commit on `origin/main`, when nobody is looking.

Anyone who can sign in can update the portal, as they can already run commands
on the host. The section is not there when the portal is not a git checkout.
In a Docker container, which cannot rebuild itself, there is no button and no
notice: the section says to update the image instead, see
[Updating](/guide/deploying#updating).

### Restart

**Restart** in Settings → About, under Update, stops the portal and has whatever
runs it start it again: for a new extension, or a setting that says it needs a
fresh start, without a shell on the host. It works on any portal, a git checkout
or a container, and asks first. The question says what happens: the portal is away
for a few seconds to a minute, open chats reconnect on their own, and running
chats and routines are stopped (their number is in the question; a chat carries on
when you send it a message). After you confirm, the page waits, asks the portal
whether it is back, and loads again when a new start of it answers. If it has not
come back after three minutes, the page says so, and the log on the host says why.
The page that loads after a restart says what it brought: the extensions the
new start runs that the old one did not, and the ones it no longer runs. This is
compared with what the portal had loaded when it started, not with what is
installed, so an extension you installed just before pressing Restart is told as
added.

**While an update runs** the button is off, and a restart request is refused: the
update has moved `node_modules` and the builds aside, and stopping the portal then
would leave it without the files it starts from. An update is likewise refused for
the moment a restart is on its way.

**Logins.** The logins that were open end with a restart unless `PORTAL_SECRET`
is set (see [Deploying](/guide/deploying#environment)). Without it, the question
says so, and the login page is what you see when the portal is back; the note about
what the restart brought is shown when you open About after signing in.

The portal restarts only where something is there to start it again, and says so
where there is not (the button is off, with the reason):

- as a **systemd service** whose unit has `Restart=on-failure` or `Restart=always`;
  a unit with `Restart=no` (systemd's default) is refused. This holds whether the
  portal is the unit's own process or only runs inside it, from a wrapper script or
  `npm start`: the copy such a portal starts is ended with the unit when it stops.
  A job of a daemon that is not stopped when the job ends (cron) is told apart
  from that by nothing but the daemon's own unit, so with `Restart=no` there it is
  refused too; `PORTAL_UPDATE_RESTART=self` lets the portal start its own copy;
- in a **Docker container** run with a restart policy (`unless-stopped`, `always`
  or `on-failure`, as both Compose files have it); where Docker says the container
  has none, it is refused;
- under another manager (pm2, `while true`) when `PORTAL_UPDATE_RESTART=exit`
  says so; with `PORTAL_UPDATE_RESTART=self` the portal starts a copy of itself.

A portal started by hand in a terminal is none of these: nothing would start it
again, so the button is off. Start it again on the host, or run it under systemd or
in Docker. Unlike the Update, the Restart does not start a copy by itself without
`PORTAL_UPDATE_RESTART=self`. How it ends, and what the supervisor sees, is in
[Deploying](/guide/deploying#restarting).

Anyone who can sign in can restart the portal, as they can already run commands
on the host. Each restart is written to the [log](#logs) with the time and the
address it came from.

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
replaces is kept beside the file as `settings.json.bak`. A save reloads the
open chats, as installing a package does.

If you edit the file by hand and leave it unreadable, the other places that
write to it (the compaction slider, the extension switches and forms) refuse to
change it and say so, rather than starting over from an empty file and losing
your packages and defaults. Put it right here, or in your editor, and save
again.
