# Upgrading

Upgrading Pithagoras is pulling a newer version and starting it. When the new version changes the database, it checks and backs it up first. While that runs, it shows a page instead of the portal.

## What happens on the first start

The database records its schema version. A new version that needs a newer schema does this before the portal opens:

1. **Checks the database** with SQLite's `quick_check`, which reads every page. On a large database this can take a few minutes.
2. **Backs it up** with SQLite's online backup, to `backups/` in the data folder (`/data/backups` in the image). The file is named after the schema version it came from, for example `portal-v2-20261001-142914.db`. It is written as `<name>.partial` and renamed when it is whole, so an upgrade that is cut off, by a full disk or a restart, leaves no file that could be taken for a backup; the next start removes what it left. The two newest backups are kept and older ones are removed.
3. **Upgrades it** in one transaction. Either every change is made or none is, so a failure leaves the database as it was, at its old version.

Meanwhile the portal's address shows an **Upgrading** page that reloads itself, and API calls answer `503` with a message saying so. The portal opens on its own when the upgrade is done.

A new install has nothing to upgrade. A database already at the current version starts straight away, with no check and no backup.

## When it cannot upgrade

If the database is damaged, or there is no room for the backup, nothing is changed. The portal stays up showing the page with the reason, and the log says the same. It doesn't exit, which in Docker would only restart it into the same failure.

The same goes for a database that a **newer** version of the portal has upgraded: this version doesn't open it, because the newer one may have renamed or dropped what this one reads. The page says which version the database is at. Start the newer version again, or put back the backup from before it upgraded the database (see [Going back](#going-back)).

### No room for the backup

The backup needs about the size of `portal.db` plus its `-wal` file, with some margin. Free that much space on the volume holding the data folder and restart.

If you can't, and you accept upgrading without a backup, start once with:

```sh
PORTAL_UPGRADE_BACKUP=skip
```

Put it in `.env` and recreate the container (`docker compose up -d`): both Compose files pass it on to the portal, as does the Portainer stack when it is set in the stack's environment. Take it out again afterwards, or no later upgrade is backed up.

### A damaged database

SQLite can recover everything still readable into a new file. Both shipped Compose files name the container `pithagoras` and set `PORTAL_CONTAINER_NAME` to it; the page and the log show these steps with the name your portal has been told. The volume holding its data is read from the container, since the Compose files name it differently:

```sh
docker stop pithagoras
DATA=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' pithagoras)

# Recover what can be read into a new file
docker run --rm -v "$DATA:/data" alpine sh -c \
  "apk add -q sqlite && sqlite3 /data/portal.db .recover | sqlite3 /data/portal-recovered.db"

# Keep the damaged file, put the recovered one in its place
docker run --rm -v "$DATA:/data" alpine sh -c \
  "cd /data && mv portal.db portal-damaged.db && rm -f portal.db-wal portal.db-shm && mv portal-recovered.db portal.db"

docker start pithagoras
```

With `PORTAL_DATA_DIR` set to a folder on the host, `DATA` comes out as that folder.

A portal that doesn't run in a container has no volume to find: stop it and run the same two steps on the data folder, which needs the `sqlite3` command line tool:

```sh
cd /path/to/data
sqlite3 portal.db .recover | sqlite3 portal-recovered.db
mv portal.db portal-damaged.db && rm -f portal.db-wal portal.db-shm && mv portal-recovered.db portal.db
```

The portal checks the recovered database before upgrading it. Rows on damaged pages can't be recovered, which usually means part of the event history of some conversations. Once you're happy with the result, delete `portal-damaged.db`.

## From 0.1.0 to 0.2.0

A portal at 0.1.0 takes every step of this release in its first start. The
database goes from schema 3 to 11 in one transaction, after one check and one
backup, `backups/portal-v3-<date>-<time>.db`. The steps run in this order, and
each has a section below:

| Schema | What changes | Section |
| --- | --- | --- |
| 4 | Agents and routines get tool lists of their own, and a project can work with an agent | [Agents and routines have tools of their own](#agents-and-routines-have-tools-of-their-own) |
| 5 | The canvases stored in the database are written out as Markdown files, and their table is dropped | [Canvases are an extension](#canvases-are-an-extension) |
| 6 | The ends of picture and clip calls kept in the chats are given the files they showed | [A tool's files are shown under its card](#a-tool-s-files-are-shown-under-its-card) |
| 7 | What the Images page kept is left for Media | [Media is an extension](#media-is-an-extension) |
| 8 | What the browser kept is left for Browser, and who may drive it becomes the tools' switches | [Browser is an extension](#browser-is-an-extension) |
| 9 | Voice mode's settings, voices and addresses are left for Voice and Voice servers | [Voice's service is an extension](#voice-s-service-is-an-extension) |
| 10 | Understory's settings are left for Understory, and its MCP server is trusted where no list was set | [Understory is an extension](#understory-is-an-extension) |
| 11 | Every chat is in Standard mode, and there is a table for the modes you make | [Chats have a mode](#chats-have-a-mode) |

The same start moves the password into the database, installs the six
[extensions a portal starts with](#the-extensions-a-portal-starts-with), puts
code mode in the tool defaults as off, and removes the rules that no longer
apply. The rest of the sections say what else is different.

What you do:

- **Take `PORTAL_PASSWORD` out** of `.env`, the Compose environment or the
  Portainer stack once the portal is up. It is read once and then ignored
  ([The password moves into the database](#the-password-moves-into-the-database)).
- **Install what you used** from Settings → Extensions → Discover → Comes with
  Pithagoras: Browser for the agent's browser, Voice for the voice service,
  Voice servers for speech servers of your own, and Understory for the agent's
  memory. The upgrade installs none of them. Browser, Voice and Understory
  require Docker for extensions, which the question before the install lists
  and installs first. Until then, what 0.1.0 kept for each waits in `handoff/`
  in the data folder, nothing of it lost, and their containers and volumes stay
  where they are.
- **Reload the portal's open tabs.** A tab that was open before the upgrade
  still runs the old page.
- **Change scripts and bookmarks** that use an address that moved (see the
  table below). The old addresses have no aliases.
- **If you use Azure**, rename its provider ([pi is 1.1](#pi-is-1-1)).
- **From a checkout, use Node 22.19 or later** ([pi is 1.1](#pi-is-1-1)).
- **If you started with `docker-compose.voice.yml`**, drop it from your command:
  it is gone (see [Voice's service is an extension](#voice-s-service-is-an-extension)).

### Pages, settings and routes that moved

| In 0.1.0 | In 0.2.0 |
| --- | --- |
| Settings → Agent → Images, `/settings/images` | Media's page under Extension settings, `/settings/x/pithagoras-media` |
| The Images page, `/images` | The Media page, `/x/pithagoras-media/media` |
| Settings → Add-ons, `/settings/add-ons`: Browser, Voice, Subagents and Memory | Browser's, Voice's, Voice servers' and Memory's pages under Extension settings; Subagents in Settings → Tools; voice mode at the end of Settings → Defaults |
| The Browser page, `/browser`, with the allowlist | `/x/pithagoras-browser/browser`; the allowlist in Settings → Guard → Sites the agent's tools may reach |
| The Memory page, `/memory` | `/x/pithagoras-understory/memory` |
| `/api/terminal…` | `/api/x/pithagoras-terminal/terminal…` |
| `/api/sessions/:id/git…` | `/api/x/pithagoras-git/chats/:id…` |
| `/api/sessions/:id/canvases…` | `/api/x/pithagoras-canvas/chats/:id/canvases…` |
| `/api/sessions/:id/files`, `file`, `folder`, `unsaved` and `archive` | `/api/x/pithagoras-files/chats/:id/…` |
| `/api/images…`, `/api/features/images` | `/api/x/pithagoras-media/images…`, `/api/x/pithagoras-media/settings/images` |
| `/api/browser…`, `/browser-ui/` | `/api/x/pithagoras-browser/…`, `/api/x/pithagoras-browser/ui/` |
| `PUT /api/browser/allowlist` | `PUT /api/guard/allowlist`; the list is in `GET /api/guard` |
| `/api/voice/install`, `hardware`, `gpu`, `start`, `stop`, `uninstall`; `/api/voice/presets…`; `POST /api/voice/connect` | `/api/x/pithagoras-voice/…` (`GET install` → `/state`); `…/voices…`; `PUT …/chosen` |
| `/api/features/understory…`, `/api/memory/…`; `PUT /api/features/understory`; its part of `GET /api/features` | `/api/x/pithagoras-understory/…`; `…/use`; `…/state` |

`/settings/images` and `/settings/add-ons` open Settings → Defaults. The
sections below give each move in full, and the
[API reference](/reference/api) has the new routes.

### New environment variables

None of them has to be set. Unset, `BROWSER_BIND` keeps a new browser container
off the network, the fetch and Understory waits are 30 minutes where 0.1.0 had
Node's five, and a portal run from a checkout looks for new commits at the start
and every six hours (`PORTAL_UPDATE_CHECK=off` stops that). See
[Configuration](/reference/configuration#environment).

| Variable | What it sets |
| --- | --- |
| `BROWSER_BIND` | The address the browser's own ports listen on: `127.0.0.1` unless set; 0.1.0 opened them on every interface ([Browser is an extension](#browser-is-an-extension)) |
| `PORTAL_DEFAULT_EXTENSIONS` | `off` installs none of the extensions a portal starts with |
| `UNDERSTORY_LLM_PORT` | The loopback port through which Understory reaches the chat's model, `3801` |
| `UNDERSTORY_LLM_HEADERS_TIMEOUT_MS`, `UNDERSTORY_LLM_BODY_TIMEOUT_MS` | How long the model Understory thinks with may take |
| `PORTAL_FETCH_HEADERS_TIMEOUT_MS`, `PORTAL_FETCH_BODY_TIMEOUT_MS` | How long a fetch of the portal's process, an MCP call among them, may wait: 30 minutes, where Node cut one off after five |
| `PITHAGORAS_LOG_LEVEL`, `PITHAGORAS_LOG_LINES`, `PITHAGORAS_LOG_CHARS` | What Settings → Logs keeps |
| `PORTAL_UPDATE_CHECK`, `PORTAL_UPDATE_RESTART` | The Update and Restart buttons in Settings → About, for a portal run from a checkout |
| `FFMPEG_PATH` | The `ffmpeg` Media makes posters and playable copies of clips with |

No variable that 0.1.0 read is gone. `PORTAL_PASSWORD` is read only to move it
into the database.

### What does not carry over

- **A chat 0.1.0's guard held is not held any more**: see [The guard](#the-guard).
- **A key chosen** for the terminal (<kbd>T</kbd>), canvases (<kbd>D</kbd>),
  files (<kbd>F</kbd>) or the browser (<kbd>B</kbd>) in voice mode is back at
  its default, and the terminal's, Git's, Canvases', Files' and the browser's
  panels beside a chat start at the default place once.
- **Stored canvases** are Markdown files in their chats' folders, not canvases.
- **The logins** made before the upgrade are asked for the password once more.
- **Breeze Python** has no source in voice mode, and speech at an address of
  your own carries over only where it spoke Kokoro
  ([Voice's service is an extension](#voice-s-service-is-an-extension)).

## Agents and routines have tools of their own

An agent and a routine each have a **Tools** list now, as a chat and a project
do ([Agents](/guide/agents#tools), [Routines](/guide/routines#tools)). The
layers, each an exception to the one before, are Settings → Tools, the agent,
the project, the routine and the chat. The upgrade (schema 4) gives every agent
and routine an empty list, so every chat, project, agent and routine has the
tools it had. A
routine's **Browser** switch is written into its own list later, at schema 8
(see [Browser is an extension](#browser-is-an-extension)). A project can also
work with an agent now ([Projects](/guide/projects)); one from 0.1.0 works with
none, as before.

## Code mode is a tool, off by default

Code mode, pi's `codemode` tool, is in the tool lists as a group of its own
([Code mode](/guide/extensions#code-mode)). The first start puts it in the
default of Settings → Tools as off, beside what you had switched off there, so
no chat has it until it is switched on for a chat, a project, an agent or every
chat. A later start does not undo what you choose.

## The password moves into the database

A portal used to take its password from `PORTAL_PASSWORD`. It now keeps it, hashed, in its database, chosen in the browser and changed under Settings → Authentication (see [The password](/guide/deploying#the-password)). What the first start after the upgrade does:

- **A `PORTAL_PASSWORD` that was in use is moved in.** The portal hashes it, stores it, and says so once in the log. Nothing changes for the people who sign in, except that the logins made before the upgrade are asked for the password once more: the cookies are signed under the password's hash now. A password shorter than 8 characters is moved too if this portal has been used (it keeps working, with a warning in Settings until it is changed), and is not if the portal is new.
- **The variable is ignored from then on.** Take it out of `.env`, the Compose environment or the Portainer stack. While it is still there and equal to the password nothing is said; a value that differs is reported at each start as ignored, so that editing it does not look like it changed the password. Change the password under Settings → Authentication instead.
- **`change-me` and other examples are not moved.** A `PORTAL_PASSWORD` that is the example, or shorter than 8 characters on a portal that is new, is not taken: the portal shows the page that asks for a password, as a new install does.
- **No `PORTAL_PASSWORD` and no password in the database** is a new install: the page that asks for one. Until it is chosen the portal answers nothing else, and whoever opens it first chooses it.
- **Going back** to a release that reads `PORTAL_PASSWORD` needs the variable set again: that release does not look in the database.

A password that is lost is removed with `npm run reset-password`, or `docker exec -it pithagoras node core/server/dist/reset-password.js` in a container, see [A lost password](/guide/deploying#a-lost-password).

## The server and the web app moved to core/

The portal's own code is in `core/server` and `core/web`, beside the
extensions it ships in `extensions/`. In the image nothing changes for you.
From a checkout, the start command is now `node core/server/dist/index.js`
(`npm start` already is). A service, a script or the restart after an update
that still runs `node server/dist/index.js` keeps working: the build writes
that file, and `reset-password.js` and `sso-only-off.js` beside it, as small
files that load the same ones from `core/server/dist`. Change the command when
it suits you.

## The extensions a portal starts with

The first start after the upgrade installs, once, the extensions a new portal
starts with, from the portal's own `extensions/` folder. Settings → Extensions →
Installed then lists:

| Package | What it brings |
| --- | --- |
| `pithagoras-terminal` | The [terminal](/guide/terminal) panel beside a chat, and its window in voice mode |
| `pithagoras-git` | The [Git](/guide/git) panel |
| `pithagoras-files` | The [Files](/guide/files) panel, and its window in voice mode |
| `pithagoras-canvas` | [Canvases](/guide/canvases) and the agent's canvas tools |
| `pithagoras-media` | [Media](/guide/media): the agent's picture and video tools, the Media page and its settings |
| `pithagoras-themes` | Seven colour themes, chosen under Settings → This browser |

They are ordinary packages from then on
([What a portal starts with](/guide/extensions#what-a-portal-starts-with)): one
you switch off or remove stays so, and a later start does not put it back. With
`PORTAL_DEFAULT_EXTENSIONS=off` none of them is installed: the portal then has
no terminal, Git or Files panel, no canvases and no picture tools until you
install them, and what 0.1.0 kept of the Images page waits for Media.

The others that come with the portal are not installed by the upgrade. They are
listed under Settings → Extensions → Discover → Comes with Pithagoras: Browser
(`pithagoras-browser`), Docker for extensions (`pithagoras-docker`), Voice
(`pithagoras-voice`), Voice servers (`pithagoras-voice-servers`), Understory
(`pithagoras-understory`), Documents (`pithagoras-docs`), Kanban
(`pithagoras-kanban`), Creator mode (`pithagoras-creator`) and Subagents
(`pithagoras-subagent`). The sections
below say which of them a portal that used 0.1.0's add-ons needs.

Notes (`pithagoras-notes`) came with some builds of the main branch after 0.1.0,
in `extensions/notes`, and is a test fixture now. A portal that installed it from
that folder keeps it in pi's list with the folder gone: Settings → Extensions
still lists it, with nothing behind it. Remove it there. 0.1.0 never had it.

## The terminal is an extension

The terminal is the `pithagoras-terminal` extension now
([Terminal](/guide/terminal)), installed on the first start. The button in a
chat's header, the panel and its tabs, and its window in voice mode are the
same. Background jobs and subagents stay the portal's own.

- **Its routes moved:** what was `/api/terminal…` is now
  `/api/x/pithagoras-terminal/terminal…` (see
  [Terminal](/reference/api#terminal-background-jobs-and-subagents)). A script
  that used the old addresses needs the new ones.
- **Once:** a key chosen for "Show or hide the terminal" under Settings →
  Shortcuts is <kbd>T</kbd> again, and where the terminal's panel beside a chat
  had a place or a size set by hand, it starts at the place the panels have by
  default, and keeps what it is given from then on.

## Git is an extension

Git is the `pithagoras-git` extension now ([Git](/guide/git)), installed on
the first start. The button in a chat's header and the panel are the same, and
it has a picker for the repositories inside a chat's folder. A commit message or
a pull request's text that was being written is kept under the same name in the
tab's session storage, so a tab that stays open through the upgrade still has it
after the reload.

- **Its routes moved:** what was `/api/sessions/:id/git…` is now
  `/api/x/pithagoras-git/chats/:id…`, with `?repo=` for a repository inside the
  folder (see [Git](/reference/api#git)). A script that used the old addresses
  needs the new ones.
- **Once:** where Git's panel beside a chat had a place or a size set by hand, it
  starts at the place the panels have by default, and keeps what it is given from
  then on.

## Canvases are an extension

Canvases are the `pithagoras-canvas` extension now, installed on the first
start, with a database of their own. The canvases a portal stored before are
not carried into it: the first start after the upgrade writes each of them out
as a Markdown file in its chat's folder, `canvases/<title>.md` (a taken name
gets a number, as an upload's does), and drops the table they were in. A chat
whose folder is gone has its canvases written to `canvases/` in the data
folder, beside `backups/`; the log says where each one went. They are files
now, to open in Files or ask the agent to read, not canvases. The database was
backed up before, as for any upgrade.

The button in a chat's header, the panel and its window in voice mode are the
same. Its routes moved with it: what was `/api/sessions/:id/canvases…` is now
`/api/x/pithagoras-canvas/chats/:id/canvases…` (see
[Canvases](/reference/api#canvases)), answered the same way. A script that used
the old addresses needs the new ones. Once, a key chosen for "Show or hide
canvases" under Settings → Shortcuts is <kbd>D</kbd> again, and where the
canvases' panel beside a chat had a place or a size set by hand, it starts at
the place the panels have by default, and keeps what it is given from then on.

## Files is an extension

Files is the `pithagoras-files` extension now, installed on the first start
like the terminal and Git: the button in a chat's header, the panel, its
window in voice mode and <kbd>F</kbd> there are the same. An edit that was not
saved when the portal was upgraded comes back as it was. Where a panel's place
or size was set by hand, Files starts at the place the panels have by default
once, and keeps what it is given from then on; a key chosen for "Show or hide
files" under Settings → Shortcuts is <kbd>F</kbd> again. Switched off or
removed, a chat's folder is still the agent's.

Its routes moved with it: what was `/api/sessions/:id/files`, `file`, `folder`,
`unsaved` and `archive` is now `/api/x/pithagoras-files/chats/:id/…` (see
[Files' routes](/guide/files#its-routes)), answered the same way. A script that
used the old addresses needs the new ones. Uploads (`/upload`), pictures and
clips stay where they were.

## Dusk and Warm are in the theme pack

Dusk and Warm were extensions of their own (`pithagoras-theme-dusk` and `pithagoras-theme-warm`). They are themes of the `pithagoras-themes` pack now, with the same colours, so Settings → Extensions lists one package for all seven. The first start after the upgrade takes the two old packages out of pi's list, where their folders no longer exist, and makes sure `pithagoras-themes` is installed and switched on if one of them was switched on. A browser that had Dusk or Warm chosen keeps it: the choice is moved to the pack's theme the first time the page loads. A package of your own that you installed from a folder called `theme-dusk` or `theme-warm`, and that is still there, is left alone. If installing the pack fails, the old entries stay and the next start tries again.

Reload the portal's open tabs after the upgrade. A tab that was open before it still runs the old page, which does not know the pack's themes and gives up the Dusk or Warm choice the first time it asks the server for the extensions.

A portal at 0.1.0 had neither package: for it, the pack is one of the [extensions a portal starts with](#the-extensions-a-portal-starts-with).

## A tool's files are shown under its card

A tool gives the person a file by saying so at the end of its call now
([Files a tool gives](/guide/extension-ui#files-a-tool-gives)), and the chat,
voice mode and the channels show what it says, for any tool. Before, only the
portal's own picture and clip tools could, each in a shape of its own. The
upgrade (schema 6) gives the ends of those calls kept in the chats, and in the
earlier versions of a message, the files they showed, so the pictures and clips
in older chats are shown as they were. Nothing else in a conversation is changed.

## Media is an extension

Media is the `pithagoras-media` extension now, installed on the first start
like Canvases and Files, with a store of its own. The page, its settings, the
agent's picture and video tools and their cards in the chat do what they did,
under new names and addresses:

- **The page** is at `/x/pithagoras-media/media`, in the sidebar's
  **Extensions** group, listed while an image or a video endpoint is set up.
  `/media`, `/images` and `/videos` are gone; a link to one of them needs the
  new address.
- **The settings** are Media's page in Settings, under **Extension settings**,
  at `/settings/x/pithagoras-media`, where **Settings → Agent → Images** was in
  0.1.0, at `/settings/images`, and **Settings → Agent → Media** in the builds
  after it, at `/settings/media`. Both addresses open Settings → Defaults now.
  What was set there, the keys included, is carried over.
- **The tools** are the extension's, in its group, `pithagoras-media`, in the
  tool lists, where the **Media** group was (**Images** in 0.1.0). A lazy mark on
  the group, or a name given to it, in 0.1.0 as well, moves to the new group; a
  tool switched on or off by its name, for a chat, a project, an agent or a
  routine, stays as it was.
- **`show_image` comes with Media.** It is no longer the portal's own: with
  Media switched off or removed the agent has no `show_image`, and the voice
  rule no longer tells it to show pictures with it.
- **The routes moved:** what was `/api/images…`, `/api/videos…`,
  `/api/features/images` and `/api/features/videos` is now under
  `/api/x/pithagoras-media/…` (`/images…`, `/videos…`, `/settings/images` and
  `/settings/videos`, see [Media's routes](/reference/api#media)), answered the
  same way. `GET /api/features` no longer has `images`, and
  `GET /api/features/flags` no longer has `images` and `videos`: Media's
  `GET /api/x/pithagoras-media/state` says the same. A script that used the old
  addresses needs the new ones.

What the portal kept of Media is handed over, not lost. The first start after
the upgrade, which raises the schema to 7, moves it out of the portal into
`handoff/media` in the data folder, a folder only the portal can read:

- the gallery's rows, each with the folder of its chat (`images.json`,
  `videos.json`), and the settings of the image and the video endpoint
  (`settings.json`);
- the page's own pictures, the files the rows name in `images/`
  (`files/images/`), and its clips, all of `videos/` (`files/videos/`);
- the small copies of pictures, the posters and the playable copies of clips,
  `image-thumbs/`, `video-posters/` and `video-copies/` (`cache/`).

It then drops the `images` and `videos` tables and the two settings from its
database. The files are moved by renaming them, so the hand-off needs no room
of its own. A folder of the data folder that is mounted on its own or reached
through a link, such as a `videos/` on a disk of its own, stays where it is (a
link with the folder it leads to), and what is in it is moved. Where that
folder is on another file system than the data folder, as one mounted on its
own is, what is in it is copied into the data folder and then removed where it
was: the data folder needs room for all of it, and keeps it from then on, in
Media's folder once Media has taken it up. The pictures sent with the chats'
messages, in a folder for each chat in `images/`, stay where they were: that is
all `images/` holds now. A start on which the hand-off cannot be finished keeps
the tables and the settings, says so in the log, and goes on with it on the
next start.

Media takes it up when it starts: it moves the hand-off into its own folder and
everything into its place there, with the same ids and file names, and says in
the log how many pictures and videos it took up. `extension-data/pithagoras-media/`
then holds `media.db` (the gallery's rows and the settings), `images/`,
`videos/`, `image-thumbs/`, `video-posters/` and `video-copies/`. A portal that
runs with `PORTAL_DEFAULT_EXTENSIONS=off` does not install Media: the hand-off
waits, nothing of it lost, until Media is installed from Settings →
Extensions → Discover → Comes with Pithagoras. Removing Media later keeps its
folder, and Media installed again has all of it.

From a checkout, `npm run build` installs Media's own packages, better-sqlite3
and sharp, in `extensions/media` the first time; sharp, which makes the small
copies, is no longer one of the server's. The posters and the playable copies
still need an `ffmpeg`, found as before (`FFMPEG_PATH`).

### Going back to a version before it

The backup the upgrade made in `backups/` (`portal-v6-….db` from the version
before) has the gallery's rows and the settings as they were, but not Media's
files. Put the backup back as under [Going back](#going-back), then, before you
start the older version, move the files back to where it looks for them, and
take what is left of the hand-off, and Media's store, out of the way of a later
upgrade. In the data folder, with the portal stopped:

```sh
cd /path/to/data
for from in extension-data/pithagoras-media handoff/media handoff/.media.*; do
  [ -d "$from" ] || continue
  for d in images videos image-thumbs video-posters video-copies; do
    mkdir -p "$d"
    find "$from" -type f \( -path "*/$d/*" -o -path "*/.$d.partial/*" \) \
      ! -path "*.copy/*" ! -name "*.copy" -exec mv {} "$d"/ \;
  done
done
rm -rf handoff/media handoff/.media.*
mv extension-data/pithagoras-media "backups/pithagoras-media-$(date +%Y%m%d-%H%M%S)"
```

In a container, run it with the portal container's own mounts
(`--volumes-from`), so that a folder of `/data` mounted on its own (a disk for
`videos/`, say) has its files put back on it, where the older version will see
them:

```sh
docker stop pithagoras

docker run --rm --volumes-from pithagoras alpine sh -c '
cd /data
for from in extension-data/pithagoras-media handoff/media handoff/.media.*; do
  [ -d "$from" ] || continue
  for d in images videos image-thumbs video-posters video-copies; do
    mkdir -p "$d"
    find "$from" -type f \( -path "*/$d/*" -o -path "*/.$d.partial/*" \) \
      ! -path "*.copy/*" ! -name "*.copy" -exec mv {} "$d"/ \;
  done
done
rm -rf handoff/media handoff/.media.*
mv extension-data/pithagoras-media "backups/pithagoras-media-$(date +%Y%m%d-%H%M%S)"'
```

The files are taken from wherever they are by then: from Media's folder once
Media has taken the hand-off up, and from the hand-off in it, `handoff-media`,
while Media has not finished reading it; from `handoff/media` where Media never
took it up; and from the hidden folders beside it that a start which stopped
half way leaves, such as `handoff/.media.partial` where the upgrade did not
finish leaving it (the log said that what the Media page kept is kept for the
next start). A copy that was cut off half way, named with `.copy` at the end,
is left out: what it was a copy of is still where it came from. Where Media was
never installed, the last `mv` says there is no such file, which does no harm.

What is left of the hand-off is removed: the backup has its rows and its
settings. Left in place, `handoff/media` would be taken by the next upgrade for
one it had left already: that upgrade would drop the tables and the settings
without leaving what the older version has by then, and Media would take up the
old rows and settings in place of what the older version added and changed.

Media's store is set aside in `backups/`, as `pithagoras-media-<date>-<time>`,
where nothing reads it; delete it once you are sure you do not want it. Left in
place, Media would start on it again after a later upgrade: it would keep its
own settings over the ones changed in the older version, and drop from its
gallery the pictures made on its page, whose files are no longer in its folder.

A later upgrade then hands over what the older version has by then, as the
first one did, and Media takes it up into a new store: the older version's rows
and settings, those from before the first upgrade and those made or changed
since, with their files. What Media did between the upgrade and going back is
not in the backup, and is not taken up again. The agent's pictures and clips of
that time are found again in the chats' folders, by the older version and by
Media after a later upgrade, as found ones, without what they were asked for.
The pictures and clips made on Media's page then are listed by neither: their
files are kept, but no row names them. Settings changed on Media's page then
give way to the older version's.

## Browser is an extension

The agent's browser is the `pithagoras-browser` extension now
([The agent's browser](/guide/browser)), which runs its container through
[Docker for extensions](/guide/docker), `pithagoras-docker`. Neither is
installed by an upgrade, nor by a new portal: **a portal that used the browser
keeps it by installing Browser** from Settings → Extensions → Discover → Comes
with Pithagoras. The question before the install lists Docker, which Browser
requires, and on yes installs it first. Until Browser is installed the agent has
no browser tools and there is no Browser page; the browser itself goes on
running, and nothing it kept is lost (see below).

Once it is installed, what the portal did does the same, under new names and
addresses:

- **The page** is at `/x/pithagoras-browser/browser`, in the sidebar's
  **Extensions** group, listed while a browser runs, while the agent has its
  tools, or while a routine's runs have them otherwise than the default.
  `/browser` is gone; a link to it needs the new address.
- **Installing, starting, stopping and removing** the browser, and its password,
  are Browser's page in Settings, under **Extension settings**, at
  `/settings/x/pithagoras-browser`, where the Browser tab of **Settings →
  Add-ons** was.
- **The tools** keep their names, `browser_navigate` and the rest. They are the
  extension's, in its group, `pithagoras-browser`, in the tool lists, where the
  `browser` group was. A lazy mark on the group, or a name given to it, moves to
  the new group; a tool switched on or off by its name, for a chat, a project,
  an agent or a routine, stays as it was.
- **Who may drive it** is the tools' switches alone. What a routine's own
  **Browser** switch said, and the grant of each chat the portal had not yet
  carried into the switches, is written into the tools' switches by the upgrade,
  once (see below). A routine's `browser` field is gone, and so is
  `PUT /api/sessions/:id/browser`.
- **The allowlist** is in Settings → Guard → Sites the agent's tools may
  reach, with what it held. In 0.1.0 it was on the Browser page:
  `PUT /api/browser/allowlist` is now `PUT /api/guard/allowlist`, and the list
  is in `GET /api/guard`, no longer in what the browser's state answers.
- **The routes moved:** what was `/api/browser…` is now under
  `/api/x/pithagoras-browser/…` (`/state`, `/install`, `/start`, `/stop`,
  `/config`, `/suggest-password`, `/connect` and `/cursor`, see
  [Browser's routes](/reference/api#browser)), and the browser's own web UI,
  which was at `/browser-ui/`, is at `/api/x/pithagoras-browser/ui/`. A script or
  a bookmark that used the old addresses needs the new ones.
- **Once:** a key chosen for "Show or hide the browser" under Settings →
  Shortcuts is <kbd>B</kbd> again, and where the browser's panel beside a chat
  had a place or a size set by hand, it starts at the place the panels have by
  default, and keeps what it is given from then on.

**The container and its profile** stay where they are. `pithagoras-browser` and
its volume `pithagoras_browser-profile` stay through the upgrade, the container
running (it was made `unless-stopped`) with its debugging port on this machine's
loopback, and the logins in the volume. Browser takes them over by their names
each time it starts, and never makes them anew: they are then listed under
`pithagoras-browser` in Settings → Docker, and its page works as it did. Until it
is installed they belong to no extension, and Settings → Docker does not show
them. A container installed before its own port was kept to this machine still
listens on every interface until it is removed and installed again, which the
Browser page says.

**What the portal kept of the browser is handed over**, not lost. The first start
after the upgrade, which raises the schema to 8, moves it out of the portal into
`handoff/browser` in the data folder, a folder only the portal can read:

- the browser's six settings as they were stored (`settings.json`): its user, its
  password (the one the container was made with, which the view still signs in
  with), its two ports, whether the cursor is shown, and whether the agent was
  connected;
- the profile of the machine's own Chrome, `browser-profile/`, where the portal
  ran one (from source, without Docker), moved by renaming it (`profile/`).

It then deletes the six settings from its database. `browser_allowlist` stays,
and so does every chat's, project's, agent's and routine's tool switch. A start on
which the hand-off cannot be finished keeps the settings and the profile, says so
in the log, and goes on with it on the next start.

Browser takes it up when it starts: `extension-data/pithagoras-browser/` then
holds `settings.json`, with each setting it did not have of its own, and
`profile/`. Where Browser's folder has a `profile/` of its own already, that one
stays the browser's, and the one handed over is kept beside it as
`profile-handed-over-<date>`. The log says what it took up. With Browser not
installed the hand-off waits, nothing of it lost, until it is.

**Who may drive the browser** was a switch of its own beside the tools' switches
on older portals: a routine's **Browser** switch, off unless switched on, and a
grant for each chat that the portal carried into the tools' switches as the
browser's tools were first seen. Both held the portal's own browser tools, and
the tools a chat had reported of a Playwright MCP server pointed at a browser
(one started with `--cdp-endpoint`, or called `browser`). The upgrade writes both
into the tools' switches, once, for all of those tools:

- each routine: the browser's tools its own tools do not name are switched on in
  them where its **Browser** switch was on, and off where it was off, so its runs
  have the browser they had;
- each run kept after its routine was deleted, which had no browser: the
  browser's tools it did not switch itself are switched off in it;
- the chats, where the portal was still waiting to carry the grants (it had chats,
  and the browser's tools had not been seen since): the browser's tools are
  switched off by default and on in each chat that had the grant, as that carrying
  would have done. Where it had carried some, the rest are; where it had carried
  them all, nothing is written.

From then on the browser's tools follow their switches as any tool does, and so
do the tools of a Playwright MCP server that no chat had reported by the
upgrade, or of one added later. **A new routine has the browser** as a chat in
its place does, where before it started without it. To keep that, switch the
`pithagoras-browser` group off in Settings → Tools and on where it is wanted, or
off in each new routine's **Tools**.

From a checkout, `npm run build` installs Browser's own package, `playwright-core`,
in `extensions/browser` the first time; it is no longer one of the server's.

### Going back to a version before Browser was an extension

The backup the upgrade made in `backups/` (`portal-v7-….db` from the version
before) has the browser's settings and switches as they were. Put it back as
under [Going back](#going-back). Before you stop the portal, remove Browser
under Settings → Extensions: the older version has no such extension (Docker
stays). The container and its volume need nothing: the older version runs them
by their names, whoever took them over. One thing the backup cannot have is a
password set on Browser's page after the upgrade, with the browser installed
again on it: the container was made with that one, and the older version's view
signs in with the one in the backup. Set the same password in the older
version's Settings → Add-ons → Browser (it is in
`backups/pithagoras-browser-<date>-<time>/settings.json` once the script below
has run), or remove the browser there and install it again.

Where the portal ran the machine's own Chrome, its profile goes back to where the
older version looks for it. Then take what is left of the hand-off, and Browser's
folder, out of the way of a later upgrade. In the data folder, with the portal
stopped:

```sh
cd /path/to/data
for from in extension-data/pithagoras-browser/profile \
  extension-data/pithagoras-browser/handoff-browser/profile \
  handoff/browser/profile handoff/.browser.*/profile handoff/.browser.*/.profile.partial; do
  [ -d "$from" ] || continue
  mkdir -p browser-profile
  find "$from" -mindepth 1 -maxdepth 1 -exec mv {} browser-profile/ \;
done
rm -rf handoff/browser handoff/.browser.*
mv extension-data/pithagoras-browser "backups/pithagoras-browser-$(date +%Y%m%d-%H%M%S)"
```

In a container, run the same with the portal container's own mounts:

```sh
docker stop pithagoras

docker run --rm --volumes-from pithagoras alpine sh -c '
cd /data
for from in extension-data/pithagoras-browser/profile \
  extension-data/pithagoras-browser/handoff-browser/profile \
  handoff/browser/profile handoff/.browser.*/profile handoff/.browser.*/.profile.partial; do
  [ -d "$from" ] || continue
  mkdir -p browser-profile
  find "$from" -mindepth 1 -maxdepth 1 -exec mv {} browser-profile/ \;
done
rm -rf handoff/browser handoff/.browser.*
mv extension-data/pithagoras-browser "backups/pithagoras-browser-$(date +%Y%m%d-%H%M%S)"'
```

The profile is taken from wherever it is by then: from Browser's folder once
Browser has taken the hand-off up, and from the hand-off in it,
`handoff-browser`, while Browser has not finished reading it; from
`handoff/browser` where Browser was never installed; and from the hidden folders
beside it that a start which stopped half way leaves. Where there was no local
Chrome, there is nothing to move, and where Browser was never installed, the
last `mv` says there is no such file, which does no harm.

What is left of the hand-off is removed: the backup has the settings. Left in
place, `handoff/browser` would be taken by the next upgrade for one it had left
already, and Browser would take up the old settings in place of what the older
version has by then. Browser's folder is set aside in `backups/`, as
`pithagoras-browser-<date>-<time>`, where nothing reads it; delete it once you are
sure you do not want it. Left in place, Browser would start on it again after a
later upgrade, and keep its own settings over the ones changed in the older
version.

## Voice's service is an extension

The voice service, which builds and runs speech recognition and speech synthesis
in the `pithagoras-voice` container, is the `pithagoras-voice` extension now
([The voice service](/guide/voice-service)), which runs its container through
[Docker for extensions](/guide/docker), `pithagoras-docker`. Voice mode keeps no
engine, address or voice of its own any more: it listens and speaks through an
extension, its source ([Where voice mode listens and speaks](/guide/voice#where-voice-mode-listens-and-speaks)),
and speech servers you run yourself are reached through the
`pithagoras-voice-servers` extension ([Voice servers](/guide/voice-servers)).
None of them is installed by an upgrade, nor by a new portal: **a portal that
used the voice service keeps it by installing Voice**, and **one that listened
and spoke at addresses of its own by installing Voice servers**, from
Settings → Extensions → Discover → Comes with Pithagoras. The question before
Voice's install lists Docker, which Voice requires, and on yes installs it
first; Voice servers needs no Docker.

Until it is installed, voice mode says *Voice mode listens and speaks through
`pithagoras-voice`, which is not running* (or `pithagoras-voice-servers`): the
upgrade made the extension its source (see below). Install it, or stop using it
in Settings → Defaults → Voice mode in the meantime. Nothing voice mode kept is
lost.

**Settings → Add-ons → Voice is gone.** What it held is now:

- **On the voice service's page**, under [Your voice](/guide/voice-service#your-voice):
  the voice it speaks with and the description of the designed voice, your
  voices (the voice library, with its recordings), the input language, and the
  engine settings: speech generation, speech delivery, and Kokoro's voice and
  speed.
- **On Voice servers' page:** the speech recognition and speech synthesis
  addresses, the recognition model, and the dictation endpoint and model. It
  speaks the OpenAI speech request only, so the **Breeze Python** runtime has no
  source that speaks to it; the voice service speaks Breeze and Chatterbox itself.
- **In Settings → Defaults → Voice mode:** speech detection, the speaking
  instructions, the voice model and the providers that reply without thinking
  first, with the source named, its page a click away, and **Stop using**.
- **Listen and speak through** and **Enable voice controls** are gone: a source
  is chosen on its own page with **Use for voice mode**, and voice mode is on
  while it has one.
- **An agent's voice** is chosen from the voices its source offers now, or is
  the source's own choice (**As Voice service chooses**, where it was **As in the
  voice settings**). An agent's saved voice stays: the designed voice, a library
  voice and a Kokoro voice are all voices the voice service offers.
- **The spoken error line** is no longer kept as a file in the data folder's
  `voice` folder: the page asks the source for it as voice mode starts (see
  [Status lines while it works](/guide/voice#status-lines-while-it-works)).

What the portal did for the service does the same, under new names and
addresses:

- **Installing, starting, stopping and removing** the service, its engines, its
  GPU and **Lazy load** are its page in Settings, under **Extension settings**,
  at `/settings/x/pithagoras-voice`, where the **Voice service** part of
  **Settings → Add-ons → Voice** was. **Use installed voice** is **Use for voice
  mode**, beside **Stop using**. Uninstalling it leaves voice mode with no source,
  and your voices with Voice.
- **The routes moved:** what was `/api/voice/install`, `/hardware`, `/gpu`,
  `/start`, `/stop` and `/uninstall` is now under `/api/x/pithagoras-voice/…`,
  `GET /api/voice/install` being `/state`, and `/connect` is `PUT …/chosen`. The
  voices, `/api/voice/presets…`, are Voice's `/voices…`, and its speech settings
  are `GET` and `PUT …/speech` (see
  [The voice service's routes](/reference/api#voice-service)). `/api/voice/error-line`
  is gone. `GET /api/voice` answers the source, its voices and voice mode's own
  settings, with no addresses, `runtime`, `providers`, `managed` or `lazyLoad`;
  `PUT /api/voice` takes those settings alone, and `DELETE /api/voice/provider`
  stops using the source. `…/voice/speech` answers 24 kHz PCM, never WAV (see
  [Voice](/reference/api#voice)). A script that used the old addresses needs the
  new ones.
- `VOICE_GPU`, `VOICE_VRAM_RESERVE_MIB`, `NVIDIA_SMI`, `PORTAL_CONTAINER_NAME`
  and `DOCKER_SOCKET` keep their names and meaning; Voice reads the first three
  now.

**The container and its downloads** stay where they are. `pithagoras-voice` and
its volume `pithagoras_voice-models` stay through the upgrade, and Voice takes
them over by their names each time it starts: the volume as it is, and the
container where it carries the voice service's label (`pithagoras.addon=voice`).
They are then listed under `pithagoras-voice` in Settings → Docker. A container
made on the portal's old container is on a network that is gone once the
portal's container is made again, as a Compose update does: Voice makes it again
once, on the portal's new one, with the engines it was built for and the GPU it
was given, and the volume is kept, so nothing is downloaded again; the system
packages the setup installs in the container are installed again, as on every
remake. Until Voice is installed, they belong to no extension: Settings → Docker
does not show them, and nothing makes the container again, a rebuild of the
portal included.

**The container comes back after the host restarts.** 0.1.0 made it with no
restart policy, so it stayed stopped after a restart until it was started on its
page. Voice makes its container `unless-stopped`, and gives one made before the
same policy in place the first time it finds it, as its server half starts,
without making it again or restarting it: a container that is stopped stays
stopped, and Docker starts it again after the host restarts. Docker 29 and later
start it after the portal's container; older Docker starts both at once, which
can leave it stopped with `cannot join network namespace of a non running
container`, and Voice's page then shows **failed** with **Retry setup**. The
update in place needs Docker for extensions 1.2.0, which this release ships and
Voice requires; installing
Voice installs it, or says that the one installed is too old. A container you
stop on Voice's page, or in Settings → Docker, stays stopped until you start it
(see [The voice service](/guide/voice-service)).

**What the portal kept of voice mode is handed over**, not lost. The first start
after the upgrade, which raises the schema to 9, moves it out of the portal into
the data folder, in folders only the portal can read:

- **`handoff/voice-service`**, for Voice, wherever there was anything of voice
  mode to leave: `settings.json`, with the GPU chosen on the service's page, a
  setup still to come up, whether its speech model was let go of once voice mode
  no longer used it (`lazyLoad`), the voice it spoke with, the designed voice's
  description, the input language and the engine settings, as they were stored;
  `voices.json`, the voice library; and in `voices/` the recording of each
  clone, byte for byte.
- **`handoff/voice-addresses`**, for Voice servers, wherever an address of your
  own was kept, whether voice mode listened there or not: `settings.json`, with
  your speech recognition and speech synthesis addresses, the speech runtime and
  recognition model that went with them, the dictation endpoint and model, the
  input language and Kokoro's voice. Where voice mode was connected to the
  service, these are the addresses that connecting it kept of yours, and a
  dictation endpoint of your own beside the service's; the service's own
  addresses are not among them.

It then removes the voice library (the `voice_presets` table), `voice_gpu`,
`voice_setup_pending` and `voice_before_managed` from its database, and keeps of
the voice settings only those of Settings → Defaults → Voice mode, with the
source:

- where voice mode was on with an extension chosen, that extension;
- where it was on and listened at the service's addresses, Voice;
- where it was on and listened at addresses of your own, Voice servers;
- where it was off, none: choose one on its page.

The spoken error lines kept in the data folder's `voice` folder are deleted, and
the folder with them where nothing else is in it. Each agent's voice stays as it
was. A start on which the hand-off cannot be finished keeps everything, says so
in the log, and goes on with it on the next start; what is saved in Settings →
Defaults → Voice mode in the meantime is kept, and the rest is handed over as it
was.

Voice takes `voice-service` up when it starts: `extension-data/pithagoras-voice/`
then holds `settings.json` with each setting it did not have of its own,
`voices.json` with each voice it did not have, and `voices/<id>.wav` for each
recording. Voice servers takes `voice-addresses` up into
`extension-data/pithagoras-voice-servers/settings.json`, each setting it does
not have: the speech recognition address and model, the dictation endpoint and
model, and the input language (not auto-detect). It takes the speech synthesis
address only where it spoke Kokoro on audio.cpp, which answers the OpenAI
request Voice servers sends, with Kokoro's voice as its voice; an address that
spoke Breeze Python, Breeze on audio.cpp or Chatterbox is not taken, since Voice
servers does not speak those as it starts (its
[custom voices](/guide/voice-servers#custom-voices), which speak Breeze and
Chatterbox, are off), and the log says so. Each says in the log what it
took up. With the extension not installed, its hand-off waits, nothing of it
lost, until it is.

**The Compose overlay is gone:** `docker-compose.voice.yml` and
`deploy/voice-multilingual/` are no longer in the repository. No source speaks
to its `breeze` (Breeze Python), nor to the Chatterbox of its `audiocpp`, which
needs a recording with every phrase. A portal that spoke through them keeps
speaking by installing Voice, which listens as well and runs Breeze and
Chatterbox itself with the voices the upgrade left for it, and choosing it on
its page with **Use for voice mode**. One that keeps the overlay's `whisper`
alone listens to it through [Voice servers](/guide/voice-servers): the upgrade
gave Voice servers its address where voice mode listened there, and elsewhere it
is `http://127.0.0.1:8178/inference` as the **Speech recognition URL**, with no
model. A portal that listened at the overlay's `audiocpp`
(`http://127.0.0.1:7871/v1/audio/transcriptions`, model `qwen3-asr`) listens
there through Voice servers too, as the upgrade gave it that address. That
container, like the systemd unit, read its `server.json` from
`deploy/voice-multilingual/`, so it does not start again once it stops: choose
Voice, with Qwen3-ASR under **Speech engines**, before then.

The overlay's containers are not touched by the upgrade. They keep running as
orphans of the Compose project, and `docker compose up` says it found them.
Once voice mode no longer uses them, remove them:

```sh
docker rm -f <project>-breeze-1 <project>-audiocpp-1
```

`<project>` is the Compose project, the checkout's folder name unless you named
it otherwise; `docker ps -a` lists them. `<project>-whisper-1`, on
`127.0.0.1:8178`, goes the same way where Voice servers does not listen to it.
`docker compose up -d --remove-orphans` removes all three, the whisper one with
them. The source checkouts and models they were built from are in
`voice-runtime/`; delete it once no container of the overlay is left, as the
whisper one reads its model from there. A systemd unit installed from
`deploy/voice-multilingual/` read its `server.json` from the checkout, so stop
and disable it (`systemctl disable --now pithagoras-audio-cpp-multilingual`) and
remove its unit file.

### Going back to a version before Voice was an extension

The backup the upgrade made in `backups/` (`portal-v8-….db` from the version
before) has the voice settings, the voice library and the GPU chosen as they
were, and what connecting the service kept among them.

1. Before you stop the portal, remove Voice and Voice servers under Settings →
   Extensions: the older version has neither extension (Docker stays).
2. Stop the portal.
3. Put `backups/portal-v8-….db` back as `portal.db`, and remove `portal.db-wal`
   and `portal.db-shm` beside it.
4. With the portal stopped, move what is left of the hand-offs, and the two
   extensions' folders, out of the way of a later upgrade. In the data folder:

   ```sh
   cd /path/to/data
   stamp=$(date +%Y%m%d-%H%M%S)
   mkdir -p "backups/voice-$stamp"
   for d in handoff/voice-service handoff/.voice-service.* handoff/voice-addresses handoff/.voice-addresses.* \
            extension-data/pithagoras-voice extension-data/pithagoras-voice-servers; do
     [ -e "$d" ] && mv "$d" "backups/voice-$stamp/"
   done
   ```

   In a container, run the same with the portal container's own mounts:

   ```sh
   docker stop pithagoras

   docker run --rm --volumes-from pithagoras alpine sh -c '
   cd /data
   stamp=$(date +%Y%m%d-%H%M%S)
   mkdir -p "backups/voice-$stamp"
   for d in handoff/voice-service handoff/.voice-service.* handoff/voice-addresses handoff/.voice-addresses.* \
            extension-data/pithagoras-voice extension-data/pithagoras-voice-servers; do
     [ -e "$d" ] && mv "$d" "backups/voice-$stamp/"
   done'
   ```

   Use `mv`, never `rm`. Voices added after the upgrade exist only in Voice's
   folder, as `voices/<id>.wav` with their words in `voices.json`, and the older
   version never sees them: add them again in its Settings → Add-ons → Voice from
   those files. Left in place, Voice's folder would keep its own settings and
   voices over what the next upgrade hands over, so what was changed in the
   older version would not reach it. Delete the folder set aside in `backups/`
   once you are sure you do not want it.
5. Run the previous version (see [Going back](#going-back)). Everything written
   to `portal.db` since the upgrade is lost, as with any restore. The older
   version makes its spoken error line again.

The container and its volume need nothing: a container Voice made carries the
voice service's label as well, and the older version manages it by its name; it
makes it again on the portal's network where it has to. A GPU chosen on the
service's page after the upgrade is in Voice's folder, not in the backup: choose
it again in the older version's Settings → Add-ons → Voice.

**Which backup, and which steps.** The versions that make Understory an
extension (schema 10) and give chats a mode (schema 11) follow this one with no
release between them, so a portal takes all three in one start, to 11, and its
backup is named after the version it came from: `portal-v8-….db` from 8. With
that backup, chats lose their mode, and the modes the person made go. Do these steps and
[Understory's](#going-back-to-a-version-before-understory-was-an-extension)
together, with the commands at the end of that section: before you stop the
portal, remove Voice, Voice servers and Understory under Settings → Extensions
(Docker stays); put the backup back; move aside `handoff/voice-service`,
`handoff/voice-addresses` and `handoff/understory` with their `.<name>.*`
folders, and `extension-data/pithagoras-voice`, `pithagoras-voice-servers` and
`pithagoras-understory`; then run the version before both. With a `portal-v9-….db`, which only a portal that ran this version
alone and stopped at 9 has, Understory's steps take it back to 9, and from there
these take it to 8.

## Understory is an extension

Understory, the agent's memory, which the portal ran in the
`pithagoras-understory` container and set up in Settings → Add-ons → Memory, is
the `pithagoras-understory` extension now
([Memory: Understory](/guide/features#memory-understory)), which runs its
container through [Docker for extensions](/guide/docker), `pithagoras-docker`.
Neither is installed by an upgrade, nor by a new portal: **a portal that used
Understory keeps it by installing Understory** from Settings → Extensions →
Discover → Comes with Pithagoras. The question before the install lists Docker,
which Understory requires, and on yes installs it first. An Understory you run
yourself needs the extension as well: it is what makes it the agent's memory.

Until Understory is installed:

- the agent's `understory` server stays in pi's `mcp.json`, with its token, so
  the chats keep its tools while something answers at its address;
- the chats read the agent's `MEMORY.md` again, as nothing holds the agent's
  memory in its place;
- the Memory page and the Memory tab of Settings → Add-ons are gone, and a
  tidy-up at a set time is not started;
- where Understory thinks with the chat's model, what it asks the model fails,
  filing what the agent adds and tidying up among it: the portal's own route to
  that model is gone.

Nothing Understory kept is lost. Once it is installed, what the portal did does
the same, under new names and addresses:

- **Installing, starting, stopping and removing** Understory, the model that
  keeps the memory and when it tidies up, and switching it on as the agent's
  memory are its page in Settings, under **Extension settings → Memory**, at
  `/settings/x/pithagoras-understory`, where **Settings → Add-ons → Memory**
  was. The Add-ons tab is gone with it: **Subagents** is in **Settings → Tools**,
  and voice mode's settings are at the end of **Settings → Defaults**.
- **The Memory page** is in the sidebar's **Extensions** group, at
  `/x/pithagoras-understory/memory`, with the same `?note=` and `?view=` as
  before. A link to `/memory` no longer opens it.
- **The routes moved:** what was `/api/features/understory…` and
  `/api/memory/…` is now under `/api/x/pithagoras-understory/…`, the
  `understory` of `GET /api/features` being `/state` and
  `PUT /api/features/understory` `/use` (see
  [Understory's routes](/reference/api#understory)). `GET /api/features` is
  gone, and `GET /api/features/flags` no longer has `understory`. A script that
  used the old addresses needs the new ones.
- **The chat's model** is reached through a server the extension runs on the
  portal's loopback, `127.0.0.1:3801` (`UNDERSTORY_LLM_PORT`), in place of the
  portal's own `/understory-llm/v1` route, so it works while the portal serves
  its own TLS as well.
- **A project's switch** for the agent's memory is named for no extension over
  the API: `GET` and `PUT /api/projects/:name/agent` read and change
  `{ agent, memory }` and say `memoryAvailable` (they were `understory` and
  `understoryAvailable`), `POST /api/projects` takes `memory`, and
  `GET /api/projects` marks a project that does without it with `memoryOff`.
- `UNDERSTORY_VOLUME`, `UNDERSTORY_PORT`, `MEMORY_UNDERSTORY_URL`,
  `MEMORY_UNDERSTORY_AUTH_TOKEN`, `UNDERSTORY_LLM_HEADERS_TIMEOUT_MS` and
  `UNDERSTORY_LLM_BODY_TIMEOUT_MS` keep their names and meaning; Understory reads
  them now.

**The container and the memory** stay where they are. `pithagoras-understory`
restarts with Docker, so it keeps running through the upgrade, and its volume
`pithagoras_understory-memory` is kept. Understory takes them over by their
names each time it starts: the volume as it is, and the container where it
carries the label the portal gave it (`pithagoras.addon=understory`). It ends
any run of the portal's that was left going in it, and makes it again once, with
its settings, its memory in the volume and its token: the portal made it to
reach the chat's model at a route that is gone, and on the network of the
portal's container as it was then. They are then listed under
`pithagoras-understory` in Settings → Docker. Until Understory is installed,
they belong to no extension, and Settings → Docker does not show them.

**What the portal kept of Understory is handed over**, not lost. The first
start after the upgrade, which raises the schema to 10, moves it out of the
portal into `handoff/understory` in the data folder, a folder only the portal
can read: `settings.json`, with its four settings as they were stored — the
model that keeps the memory and when it tidies up (a key of your own among
them), the token its container was made with, which the agent's MCP entry
carries, the key it called the portal's model route with, and what the last pass
came to. It then deletes `understory_config`, `understory_token`,
`understory_llm_token` and `understory_last_dream` from its database. A start
on which the hand-off cannot be finished keeps everything, says so in the log,
and goes on with it on the next start. Understory takes the hand-off up when it
starts: `extension-data/pithagoras-understory/settings.json` then holds each
setting it did not have of its own, and the log says what it took up. With
Understory not installed the hand-off waits, nothing of it lost, until it is.
While a hand-off that could not be taken up waits for the next start, Understory
leaves the container the portal made as it is, and its page refuses what would
need the token in the hand-off: saving its settings, which makes the container
again, and switching it on as the agent's memory.

The same upgrade also:

- **says which MCP servers are your own, where you had not.** The guard counted
  what the `understory` server said as your own words, unmarked and unchecked,
  while you had not said which servers are; now it counts only the ones said.
  Where you had not, and Understory was in use (its settings were there, or an
  `understory` server was in `mcp.json`), the upgrade says it for you, once:
  `understory` is in the trusted MCP servers in **Settings → Guard**, where you
  can take it out. A list you had made stays as it was. See
  [Prompt injection](/guide/security#marking-untrusted-output).
- **keeps each project's switch** for the agent's memory, under a name that is no
  extension's (`memory_off` in place of `understory_off`).
- **leaves the agent's MCP entry as it was:** the `understory` server in pi's
  `mcp.json`, its tools' names (`understory_memory_*`), their switches, lazy
  marks and the name given to their group are still the server's.

### Going back to a version before Understory was an extension

**Which backup.** No release came between schema 9 and 11, so a portal at
version 8, or an older one, went to 11 in one start, and the backup the upgrade
made in `backups/` is named after the version it came from: `portal-v8-….db`
from 8. With that backup, chats lose their mode, and the modes the person made
go ([Chats have a mode](#chats-have-a-mode)):

- **With `portal-v8-….db`**, go back from both upgrades at once, to the version
  before Voice was an extension. Before you stop the portal, remove Voice, Voice
  servers and Understory under Settings → Extensions (Docker stays). Put the
  backup in as under [Going back](#going-back). With the portal stopped, move
  `handoff/voice-service`, `handoff/voice-addresses` and `handoff/understory`
  aside, each with the `.<name>.*` folders beside it, and Voice's, Voice
  servers' and Understory's folders in `extension-data/`, as at the end of this
  section. Then run the older version. What both sections say of the containers,
  and of what was changed after the upgrade, holds for it too.
- **With `portal-v9-….db`**, from a portal that stopped at version 9 and went on
  later, the steps of this section take it back to 9. From there, those of
  [Going back to a version before Voice was an extension](#going-back-to-a-version-before-voice-was-an-extension)
  take it to 8.

Either backup has Understory's settings as they were, and each project's switch
under its old name. Put it back as under [Going back](#going-back). Before you stop the
portal, remove Understory under Settings → Extensions: the older version has no
such extension (Docker stays). What was changed on Understory's page after the
upgrade, and what a later pass came to, are in Understory's folder, not in the
backup: set them again in the older version's Settings → Add-ons → Memory. The
token is the same in both, so the agent's MCP entry needs nothing.

The container needs one thing: Understory made it to reach the chat's model at
its own server, which the older version does not run. Make it again from the
older version's **Settings → Add-ons → Memory**: **Save and restart
Understory** shows only once something in the form has changed, so choose the
model it thinks with once more (its source, as it is chosen, is enough) and
press it; the memory in its volume is kept. A container Understory made
carries the portal's label as well, so the older version manages it by its
name.

Then take what is left of the hand-off, and Understory's folder, out of the way
of a later upgrade. In the data folder, with the portal stopped:

```sh
cd /path/to/data
rm -rf handoff/understory handoff/.understory.*
mv extension-data/pithagoras-understory "backups/pithagoras-understory-$(date +%Y%m%d-%H%M%S)"
```

In a container, run the same with the portal container's own mounts:

```sh
docker stop pithagoras

docker run --rm --volumes-from pithagoras alpine sh -c '
cd /data
rm -rf handoff/understory handoff/.understory.*
mv extension-data/pithagoras-understory "backups/pithagoras-understory-$(date +%Y%m%d-%H%M%S)"'
```

Where Understory was never installed, the last `mv` says there is no such file,
which does no harm. Left in place, `handoff/understory` would be taken by the
next upgrade for one it had left already, and Understory's folder would keep its
own settings over the ones changed in the older version. Delete the folder set
aside in `backups/` once you are sure you do not want it.

With `portal-v8-….db`, these take the place of the commands above: Voice's and
Voice servers' hand-offs and folders go aside as well, all of them moved, none
deleted. Voices added after the upgrade are only in Voice's folder
(`voices/<id>.wav`, with their words in `voices.json`), and can be added again
in the older version from there. In the data folder, with the portal stopped:

```sh
cd /path/to/data
stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p "backups/handoff-$stamp"
for d in handoff/voice-service handoff/.voice-service.* handoff/voice-addresses handoff/.voice-addresses.* \
         handoff/understory handoff/.understory.* \
         extension-data/pithagoras-voice extension-data/pithagoras-voice-servers extension-data/pithagoras-understory; do
  if [ -e "$d" ]; then mv "$d" "backups/handoff-$stamp/"; fi
done
```

In a container, run the same with the portal container's own mounts:

```sh
docker stop pithagoras

docker run --rm --volumes-from pithagoras alpine sh -c '
cd /data
stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p "backups/handoff-$stamp"
for d in handoff/voice-service handoff/.voice-service.* handoff/voice-addresses handoff/.voice-addresses.* \
         handoff/understory handoff/.understory.* \
         extension-data/pithagoras-voice extension-data/pithagoras-voice-servers extension-data/pithagoras-understory; do
  if [ -e "$d" ]; then mv "$d" "backups/handoff-$stamp/"; fi
done'
```

## Subagents are an extension

This comes after 0.2.0, which still has the subagent tool in Settings → Tools →
Subagents, and is not one of the steps from 0.1.0. In the release after 0.2.0 the
tool is the `pithagoras-subagent` extension, which comes with the portal
([Subagents](/guide/features#subagents)). **A portal that had it on keeps it on**:
its folder was in pi's packages already, and is loaded as an extension. It is
switched in **Settings → Extensions**, and set up under **Extension settings →
Subagents**. It stays off where it was off.

Its settings were in pi's `settings.json`. The upgrade to schema 12 leaves
`subagentMode`, `subagentMaxParallel` and `subagentModel` in the data folder,
under `handoff/subagent`, and then takes them out of pi's file, which is kept
as it was beside it, as `settings.json.bak`. The extension takes them up as it
starts, into its own folder (`extension-data/pithagoras-subagent`).

What each chat said its subagents run on (*Subagents in this chat run on* in its
model menu) was the portal's, a setting for each chat. The upgrade to schema 14
leaves those that say a model under `handoff/subagent-chats` and takes them out
of the database; the extension takes them up as it starts, into `chats.json` in
its folder, and keeps them from then on, each until its chat is deleted. It
comes after the step that gives chats a parent
([Chats can have child chats](#chats-can-have-child-chats), schema 13) and
before the one that indexes a chat's questions
([Sub-chats in the chat list](#sub-chats-in-the-chat-list), schema 15), and a
portal at schema 11 takes all four in one start.

The subagents beside a chat are drawn by the extension too: the Subagents panel
and its button in the chat's header, a chip in the running tray for each one at
work, *Watch* on the call that started one, and the row in the model menu. They
look the same, apart from the panel's remembered place: a dock side or width
you gave the Subagents panel starts at the default once. Switched off, the
extension takes all of it with it, and a subagent another extension runs over
the [subagent protocol](/guide/extensions#the-subagent-protocol) is not drawn
either.

**A copy of the tool that you installed by hand** from an old clone of the
repository (a folder named `pithagoras-subagent` in pi's packages, without a
`pithagoras` block in its `package.json`) is not the extension: pi loads it as
it did, and it reads its settings from pi's `settings.json`. The upgrade leaves
them there, and says so in the log. Take the copy out of pi's packages and
install the one that comes with the portal, and the next start takes the
settings up.

| Before | Now |
| --- | --- |
| `GET`, `PUT /api/features/subagent` | `/api/x/pithagoras-subagent/settings`, `{ mode, maxParallel, model }`; the old address answers with a 307 to it |
| `PUT /api/features/subagent` with `enabled` | Settings → Extensions: `POST /api/packages` with the `extensions/subagent` folder to install it, `PUT /api/extensions/enabled` to switch it |
| `GET`, `PUT /api/sessions/:id/subagent-model` | `/api/x/pithagoras-subagent/chats/:id/model`, `{ model, default }` (`default` the extension's `model`); the old address answers with a 307 to it |
| `GET /api/features/flags` with `subagent: { enabled }` | Without `subagent`: whether the extension is on is in `GET /api/extensions` |
| The portal answering `subagent:v1:config` with a chat's choice | It answers `{}`; the bundled extension keeps each chat's choice itself |

### Going back to a version before subagents were an extension

Put the backup the upgrade made in as under [Going back](#going-back):
`backups/portal-v11-….db`, or `backups/portal-v12-….db` or
`backups/portal-v13-….db` from a version that had the subagent as an extension
already, which kept each chat's choice of model in the portal still. It holds
each chat's choice as it was at the upgrade; one made since is in
`extension-data/pithagoras-subagent/chats.json`, by chat id under `chats`, to choose again in
the chat's model menu. A version before schema 12 reads the subagent's settings from pi's
`settings.json` again: put
`subagentMode`, `subagentMaxParallel` and `subagentModel` back there, from
`settings.json.bak` where nothing was changed since, or from
`extension-data/pithagoras-subagent/settings.json` (`mode`, `maxParallel` and
`model`). The tool's folder stays in pi's packages, and the older version
loads it as it did. Upgrading again takes up what pi's settings hold then: it
leaves the settings again, and the extension takes each one that you have not
changed on its page since it took them up before. A chat's choice made in the
older version is taken up again too, where the chat has none of its own in the
extension or still has the one the first upgrade gave it; one you chose in the
chat's model menu since stays. A chat that is gone is not taken up.
A choice you cleared in the older version (back to the default) does not reach
the extension: the chat keeps the one it has until you choose again.

## Chats have a mode

A chat has a [mode](/guide/sessions#modes) now, chosen above the message box
before its first message: Standard mode, or Code mode. The upgrade (schema 11)
puts every chat in Standard mode, which is how every chat worked before, and
makes an empty table for the modes the person makes. Nothing is left for an
extension, and nothing needs doing.

**Going back.** The backup is named after the version the database was at,
`portal-v<version>-….db`: from v0.1.0 (schema 3) it is `portal-v3-….db`, and a
build of the main branch can have left any version from 3 to 10. Going back
from `portal-v10-….db`, which a portal that ran a build with schema 10 has, is
only putting the backup in as under [Going back](#going-back): chats lose their
mode, and the modes the person made go with the table. An older backup also
needs the steps that
[Voice's section](#going-back-to-a-version-before-voice-was-an-extension)
and [Understory's](#going-back-to-a-version-before-understory-was-an-extension)
give for it.

## Chats can have child chats

An extension's server half can now make a
[child chat](/guide/extension-ui#child-chats) of a chat, to give part of its
work to; it is deleted with its parent. The upgrade (schema 13) gives every chat
an empty parent, so every chat stays one of its own and listed. It comes after
the step that [leaves the subagent's settings](#subagents-are-an-extension)
(schema 12), and a portal at schema 11 takes both in one start. Nothing is left
for an extension, and nothing needs doing.

**Going back.** From `portal-v12-….db` it is only putting the backup in as
under [Going back](#going-back): the child chats made since go with it.
`portal-v11-….db`, which a portal that came straight from schema 11 has, also
needs what
[Subagents' section](#going-back-to-a-version-before-subagents-were-an-extension)
says for it, and an older backup what [Chats have a mode](#chats-have-a-mode)
says.

## Sub-chats in the chat list

The sidebar and the Sessions page list a chat's
[sub-chats](/guide/sessions#sub-chats) under it, and say when one waits for
you. The upgrade (schema 15) adds an index on the questions a chat asked, so
that the list finds them without reading every event of each sub-chat. It
changes no data; nothing is left for an extension, and nothing needs doing.

**Going back.** From `portal-v14-….db` it is only putting the backup in as
under [Going back](#going-back). `portal-v13-….db`, which a portal that came
straight from schema 13 has, also needs what
[Subagents' section](#going-back-to-a-version-before-subagents-were-an-extension)
says for it, and an older backup what
[Chats can have child chats](#chats-can-have-child-chats) says.

## Subagents work in chats of their own

A subagent no longer runs as a separate `pi` process: it works in a
[child chat](/guide/features#subagents) of the chat that asked, under the guard
and the sandbox as the person the chat works for, in the chat's mode and with
its tools. Something a subagent could do before may now be refused, or wait for
you in its chat (the panel and the tray say so). Its run is in its chat's own
transcript, not in the parent's: a subagent from before the upgrade still shows
in the panel from what the parent kept.

A heartbeat has no `subagent` tool any more: its subagent would be a chat the
heartbeat's rules do not cover, and the guard already refused it. A chat's
subagent is also held to the chat's tool switches as they are when it is given
a task, and marks the chat it works for when the guard marked it.

New: **Keep subagent chats** on the extension's page (off by default), which
lists them as sub-chats and lets the agent continue one by its id, and
**Subagents work in the chat's mode** (on): a subagent's chat is in the mode of
the chat it works for, code mode and your own modes included, and in Standard
mode where you switch it off. Gone:
`PI_SUBAGENT_BIN` and `PI_SUBAGENT_GRACE_MS`, which nothing reads any more. The
database is not changed, so going back needs nothing but the older version; the
subagents' chats it made stay, as chats of their own.

## The guard

What the guard holds a chat to changed in this release
([Prompt injection](/guide/security#suspected-prompt-injection)). For a portal
upgraded from 0.1.0:

- **A chat that read something from outside is not held for it any more.** 0.1.0
  held every chat that had read a result from outside (mail, the web, an MCP
  server, the browser), and read that back from the conversation at each start.
  Now only a result that looks like a prompt injection holds a chat, and 0.1.0
  never marked one, so after the upgrade no chat is held until such a result
  comes. A call it holds then is asked of you where you are there to answer,
  and refused, as before, in a routine's run, a heartbeat, a channel's chat, and
  a conversation in which somebody else is speaking
  ([Asked or refused](/guide/security#asked-or-refused)).
- **What an MCP server returns is outside content**, however the tool is called,
  unless the server is trusted in Settings → Guard. Where Understory was in use,
  the upgrade trusts `understory` (see
  [Understory is an extension](#understory-is-an-extension)).
- **A heartbeat's rules** for `subagent`, `routine_create`, `routine_update` and
  `routine_run` are removed from Settings → People, as 0.1.0 removed everybody
  else's: a heartbeat may not run those tools now.
- **A routine's Injection guard switch** is a set of exemptions, one for each
  rule, in Settings → Guard
  ([The injection guard](/guide/routines#the-injection-guard)). A routine whose
  switch was off is exempt from every rule, as it was, until you switch some back
  on there. The `guard` field of a routine in the API still means all the rules
  or none.

## MCP servers taken out of mcp.json by hand

The portal now notices a server taken out of pi's `mcp.json` outside it, by
hand or by a script, and forgets its tools as it does for one removed in
Settings → MCP ([Disabling](/guide/mcp#disabling)). To tell what was taken out,
it keeps the servers it last saw in the file, in a new setting,
`mcp_configured`. That is filled the first time the portal looks at the file
after the upgrade, and nothing is judged then: a tool left behind by a server
taken out by hand before the upgrade stays listed in Settings → Tools. To be rid
of it, add the server again under its name in Settings → MCP, with any entry,
and remove it there.

The tools of a server whose name has a dot, such as `docs.v2`, belong to it now:
they are grouped under it, go with it when it is switched off or removed, and are
trusted with it where it is trusted in Settings → Guard. Before, they belonged to
no server. Those of a dotted server removed before the upgrade stay listed under
`pi-mcp-adapter`; the same add and remove takes them out.

## pi is 1.1

The portal's pi, and the `pi` in the image, move from 0.82 to 1.1. The
extensions and packages you installed stay at their versions; one written for an
older pi may need an update of its own, as pi 1.0 changed parts of its extension
and provider interfaces. `pi-mcp-adapter` 2.18.0, which the portal installs,
works as before. pi now reads `AGENTS.override.md` before `AGENTS.md` in a
folder. If you use Azure, its provider is renamed from `azure-openai-responses`
to `azure`: rename it in pi's `auth.json`, `models.json` and `settings.json`, or
sign in again. A portal run from a checkout needs Node 22.19 or later.

## Upgrading to 0.1.0 from an earlier build

A portal at 0.1.0 has all of this already. What a build made before 0.1.0 meets
on its first start after the upgrade, as 0.1.0's own release notes gave it:

- **The Upgrading page.** The database is checked, backed up and upgraded, as above. The schema version was raised for 0.1.0, so an install made before it goes through this once.
- **`WORKSPACES_DIR` is required.** An install whose `.env` never set it was mounting the folder `/root/repos` of the host, and Compose now stops until the variable is set. Set it to the folder your repositories are in; for an install that relied on the old default, that is `/root/repos`. The Portainer stack asks for it too.
- **The Portainer stack's data folder.** The first release's Portainer stack ignored `PORTAL_DATA_DIR` and always kept its data in the volume `<stack>_pithagoras-data`. It now mounts the folder that variable names, as `docker-compose.yml` does. If your stack's environment sets `PORTAL_DATA_DIR`, the update would start the portal on that folder, empty if it did not exist, and everything you had would look gone. Either remove the variable to stay on the volume, or stop the stack first and copy the volume into the folder: `docker run --rm -v <stack>_pithagoras-data:/from:ro -v /that/folder:/to alpine cp -a /from/. /to/`.
- **Rules for `subagent` and the routine tools.** `subagent`, `routine_create`, `routine_update` and `routine_run` run what a person writes with your rights, so no rule or approval opens them for anybody else now (see [roles](/people/roles#what-a-colleague-may-do)). A rule the first release let you or an approval make for one of them could never apply, so the upgrade removes it from Settings → People; 0.1.0 kept a heartbeat's, and 0.2.0 removes those too (see [The guard](#the-guard)). A colleague who was allowed to delegate with `subagent` is not any more.
- **Channel packages.** A third-party channel has to say who sent each message (`from` in `ctx.ask`, with the sender's id as a string), or once a primary user is named its messages are turned away like a stranger's. See [Writing a channel](/channels/writing-a-channel).
- **Webhooks without a sender.** A webhook message that names nobody, by `from` in its body or the channel's `senderId`, is answered as a stranger's once a primary user is named. A cron job, CI step or home automation that posted without one ran as you before; give it a sender. The answer is an ordinary reply, not an HTTP error, so a script that only checks the status does not notice.
- **Approvals.** Only `approve` and `always` approve an action now. "yes", "ok" or "go ahead" answer the question without approving anything, and the agent asks again.
- **Slash commands in a channel chat.** A command such as `/compact` runs only when the last person to speak in that conversation was the primary user.
- **Idle chats.** A chat nobody has used for 20 minutes is let go, and the next message starts it again from its saved conversation.
- **Deleting.** Deleting an agent with its folder deletes its routines as well; the sessions of their runs are kept. Deleting an agent or a project stops the background jobs started in its folder.
- **Pictures from other sites** in replies, notes and pull requests are not loaded; the chat says which site the picture was from. The portal's own pictures load as before.
- **The `pi` in the image** is the one the lock names, as the portal's own, instead of the newest published. `pi install` and the Terminal use it.
- **`deploy/cortex-voice` is gone** from the repository. A machine set up from those files keeps running; keep a copy of them if you set one up again.

Such a build then goes on to 0.2.0 as a portal at 0.1.0 does: see
[From 0.1.0 to 0.2.0](#from-0-1-0-to-0-2-0). The password, pi 1.1 and the voice
container are 0.2.0's changes, in their own sections.

## Pin a version

Run a release rather than `latest`, so that going back is changing one value. Each release is published as an image tagged with its version.

- **Portainer stack** (`docker-compose.portainer.yml`): set `PITHAGORAS_VERSION`, for example `0.2.0`, in the stack's environment.
- **Built from source** (`docker-compose.yml`): check out the release tag, for example `git checkout v0.2.0`. Building replaces the image you had, so keep a copy before you upgrade. `docker compose images portal` shows its name, which is `pithagoras-portal` for a checkout in a folder called `pithagoras`:

  ```sh
  docker tag pithagoras-portal:latest pithagoras-portal:previous
  ```

## Going back

1. Stop the portal.
2. Put the backup from `backups/` back as `portal.db`, and remove `portal.db-wal` and `portal.db-shm` beside it.
3. Start the previous version:
   - Portainer: set `PITHAGORAS_VERSION` to the release before.
   - Built from source: `docker tag pithagoras-portal:previous pithagoras-portal:latest`, then `docker compose up -d --no-build portal`.

Going back to a version from before Media was an extension also needs Media's files moved back, and what is left of its hand-off and its store out of the way, before step 3: see [Media is an extension](#going-back-to-a-version-before-it).
Going back to a version from before Browser was an extension needs Browser removed first, and a local Chrome's profile moved back, and what is left of its hand-off and its folder out of the way, before step 3: see [Browser is an extension](#going-back-to-a-version-before-browser-was-an-extension).
Going back to a version from before Voice's service was an extension needs Voice and Voice servers removed first, and what is left of their hand-offs and their folders moved aside, before step 3: see [Voice's service is an extension](#going-back-to-a-version-before-voice-was-an-extension).
Going back to a version from before Understory was an extension needs Understory removed first, and what is left of its hand-off and its folder out of the way, before step 3, and its container made again from the older version afterwards: see [Understory is an extension](#going-back-to-a-version-before-understory-was-an-extension).
Going back from 0.2.0 to 0.1.0 needs all of these at once, in one order: see [Going back to 0.1.0](#going-back-to-0-1-0).

From this version on, an older version does not start on a newer database: it stops at the page described above, because a newer version may have renamed or dropped columns, not only added them. Versions before this one open it anyway and run against it, so put the backup back before you start one of them. The backup from `backups/` is the database as it was before the newer version changed it, which is why going back means putting it back.

### Going back to 0.1.0

0.1.0 does not open a database that 0.2.0 has upgraded: it shows the page that
says the database is at a newer version. Going back is putting back
`backups/portal-v3-….db`, the copy the upgrade made, and moving what the upgrade
took out of the database back to where 0.1.0 looks for it. Everything written to
the database since the upgrade is lost, as with any restore.

1. **Remove the extensions 0.1.0 does not have**, while 0.2.0 still runs, under
   Settings → Extensions: the six it started with (Terminal, Git, Files,
   Canvases, Media and the theme pack), and Browser, Docker for extensions,
   Voice, Voice servers, Understory, Documents, Kanban and Creator mode where
   you installed them. pi's `settings.json` lists each by its folder in the
   image, and 0.1.0's image has none of those folders: 0.1.0 starts all the
   same, and lists them under Settings → Extensions with nothing behind them,
   where they can be removed too. Removing one keeps its folder in
   `extension-data/`, and the containers keep running.
2. **Stop the portal.**
3. **Put the backup back:** `backups/portal-v3-….db` as `portal.db`, with
   `portal.db-wal` and `portal.db-shm` beside it removed.
4. **Move back what the upgrade moved**, with the portal stopped. In the data
   folder:

   ```sh
   cd /path/to/data
   # The pictures of the Images page, where 0.1.0 keeps them.
   mkdir -p images
   for from in extension-data/pithagoras-media handoff/media handoff/.media.*; do
     [ -d "$from" ] || continue
     find "$from" -type f \( -path "*/images/*" -o -path "*/.images.partial/*" \) \
       ! -path "*.copy/*" ! -name "*.copy" -exec mv {} images/ \;
   done
   # The profile of a local Chrome, where 0.1.0 keeps it.
   for from in extension-data/pithagoras-browser/profile \
     extension-data/pithagoras-browser/handoff-browser/profile \
     handoff/browser/profile handoff/.browser.*/profile handoff/.browser.*/.profile.partial; do
     [ -d "$from" ] || continue
     mkdir -p browser-profile
     find "$from" -mindepth 1 -maxdepth 1 -exec mv {} browser-profile/ \;
   done
   # The rest of what 0.2.0 kept, set aside where nothing reads it.
   stamp=$(date +%Y%m%d-%H%M%S)
   mkdir -p "backups/0.2.0-$stamp"
   for d in extension-data handoff; do
     if [ -e "$d" ]; then mv "$d" "backups/0.2.0-$stamp/"; fi
   done
   ```

   In a container, run it with the portal container's own mounts
   (`--volumes-from`), as in [Media's section](#going-back-to-a-version-before-it):

   ```sh
   docker run --rm --volumes-from pithagoras alpine sh -c '
   cd /data
   # The pictures of the Images page, where 0.1.0 keeps them.
   mkdir -p images
   for from in extension-data/pithagoras-media handoff/media handoff/.media.*; do
     [ -d "$from" ] || continue
     find "$from" -type f \( -path "*/images/*" -o -path "*/.images.partial/*" \) \
       ! -path "*.copy/*" ! -name "*.copy" -exec mv {} images/ \;
   done
   # The profile of a local Chrome, where 0.1.0 keeps it.
   for from in extension-data/pithagoras-browser/profile \
     extension-data/pithagoras-browser/handoff-browser/profile \
     handoff/browser/profile handoff/.browser.*/profile handoff/.browser.*/.profile.partial; do
     [ -d "$from" ] || continue
     mkdir -p browser-profile
     find "$from" -mindepth 1 -maxdepth 1 -exec mv {} browser-profile/ \;
   done
   # The rest of what 0.2.0 kept, set aside where nothing reads it.
   stamp=$(date +%Y%m%d-%H%M%S)
   mkdir -p "backups/0.2.0-$stamp"
   for d in extension-data handoff; do
     if [ -e "$d" ]; then mv "$d" "backups/0.2.0-$stamp/"; fi
   done'
   ```

5. **Set `PORTAL_PASSWORD` again**, to the password: 0.1.0 reads it from there,
   not from the database.
6. **Start 0.1.0:** `PITHAGORAS_VERSION=0.1.0` in the Portainer stack, or the
   image you kept (see [Going back](#going-back)).
7. **Make Understory's container again**, if you used Understory, from 0.1.0's
   Settings → Add-ons → Memory: choose the model it thinks with once more and
   press **Save and restart Understory**. Understory made the container to reach
   the chat's model at a server 0.1.0 does not run. The memory in its volume is
   kept.

What the backup cannot hold stays with 0.2.0's folders in
`backups/0.2.0-<date>-<time>`: settings changed on an extension's page after the
upgrade, voices added to Voice (`extension-data/pithagoras-voice/voices/`, with
their words in `voices.json`), and what the Media page made since. Delete the
folder once you are sure you do not want it. Left in place, `handoff/` would be
taken by the next upgrade for what it had left already, and each extension's
folder would keep its own settings over what 0.1.0 changed.

Also:

- **The canvases** the upgrade wrote out as Markdown stay in the chats' folders.
  The backup has them as canvases, so each is there twice.
- **pi goes back to 0.82** with the image. A package installed after the upgrade
  that needs pi 1.x does not load, and an Azure provider renamed to `azure`
  needs its old name, `azure-openai-responses`.
- **The voice container** keeps the `unless-stopped` policy Voice gave it, so
  Docker starts it after the host restarts, with Docker 29 or later as above.
  0.1.0 manages it by its name, as before.
- **A chat's mode, the modes you made, and a routine's exemptions** set in
  Settings → Guard are not in the backup. A routine has the Injection guard
  switch it had.
