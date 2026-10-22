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
  at `/settings/x/pithagoras-media`, where **Settings → Agent → Media** was.
  `/settings/media` is gone. What was set there, the keys included, is carried
  over.
- **The tools** are the extension's, in its group, `pithagoras-media`, in the
  tool lists, where the **Media** group was. A lazy mark on the Media group, or
  a name given to it, moves to the new group; a tool switched on or off by its
  name, for a chat, a project, an agent or a routine, stays as it was.
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
- **The allowlist** stays where it was, Settings → Guard → Sites the agent's
  tools may reach.
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
remake. Until Voice is installed, they belong to no extension, and Settings →
Docker does not show them.

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
servers does not speak those, and the log says so. Each says in the log what it
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

## Upgrading from the first release

What the first start after an install of version 0.1.0, or of any build made before this one, shows and needs:

- **The Upgrading page.** The database is checked, backed up and upgraded, as above. The schema version was raised for this release, so an install made before it goes through this once.
- **A voice add-on.** The container of a voice add-on that an older version made is made again, with the engines and the card it had, the next time it is started or installed from the voice service's page (see [Voice's service is an extension](#voice-s-service-is-an-extension)); the models and builds in its volume are kept. Rebuilding the portal does not touch it until then.
- **`WORKSPACES_DIR` is required.** An install whose `.env` never set it was mounting the folder `/root/repos` of the host, and Compose now stops until the variable is set. Set it to the folder your repositories are in; for an install that relied on the old default, that is `/root/repos`. The Portainer stack asks for it too.
- **The password.** It is kept in the portal's database now, no longer read from `PORTAL_PASSWORD`; see [The password moves into the database](#the-password-moves-into-the-database). A `PORTAL_PASSWORD` that is still `change-me`, the example of the first release's `.env.example`, is not taken as the password.
- **The Portainer stack's data folder.** The first release's Portainer stack ignored `PORTAL_DATA_DIR` and always kept its data in the volume `<stack>_pithagoras-data`. It now mounts the folder that variable names, as `docker-compose.yml` does. If your stack's environment sets `PORTAL_DATA_DIR`, the update would start the portal on that folder, empty if it did not exist, and everything you had would look gone. Either remove the variable to stay on the volume, or stop the stack first and copy the volume into the folder: `docker run --rm -v <stack>_pithagoras-data:/from:ro -v /that/folder:/to alpine cp -a /from/. /to/`.
- **Rules for `subagent` and the routine tools.** `subagent`, `routine_create`, `routine_update` and `routine_run` run what a person writes with your rights, so no rule or approval opens them for anybody else now (see [roles](/people/roles#what-a-colleague-may-do)). A rule the first release let you or an approval make for one of them could never apply, so the upgrade removes it from Settings → People, a heartbeat's own excepted. A colleague who was allowed to delegate with `subagent` is not any more.
- **Channel packages.** A third-party channel has to say who sent each message (`from` in `ctx.ask`, with the sender's id as a string), or once a primary user is named its messages are turned away like a stranger's. See [Writing a channel](/channels/writing-a-channel).
- **Webhooks without a sender.** A webhook message that names nobody, by `from` in its body or the channel's `senderId`, is answered as a stranger's once a primary user is named. A cron job, CI step or home automation that posted without one ran as you before; give it a sender. The answer is an ordinary reply, not an HTTP error, so a script that only checks the status does not notice.
- **Approvals.** Only `approve` and `always` approve an action now. "yes", "ok" or "go ahead" answer the question without approving anything, and the agent asks again.
- **Slash commands in a channel chat.** A command such as `/compact` runs only when the last person to speak in that conversation was the primary user.
- **Idle chats.** A chat nobody has used for 20 minutes is let go, and the next message starts it again from its saved conversation.
- **Deleting.** Deleting an agent with its folder deletes its routines as well; the sessions of their runs are kept. Deleting an agent or a project stops the background jobs started in its folder.
- **Pictures from other sites** in replies, notes and pull requests are not loaded; the chat says which site the picture was from. The portal's own pictures load as before.
- **The `pi` in the image** is the one the lock names, as the portal's own, instead of the newest published. `pi install` and the Terminal use it.
- **pi is 1.1.** The portal's pi, and the `pi` in the image, move from 0.82 to 1.1. The extensions and packages you installed stay at their versions; one written for an older pi may need an update of its own, as pi 1.0 changed parts of its extension and provider interfaces. `pi-mcp-adapter` 2.18.0, which the portal installs, works as before. pi now reads `AGENTS.override.md` before `AGENTS.md` in a folder. If you use Azure, its provider is renamed from `azure-openai-responses` to `azure`: rename it in pi's `auth.json`, `models.json` and `settings.json`, or sign in again.
- **`deploy/cortex-voice` is gone** from the repository. A machine set up from those files keeps running; keep a copy of them if you set one up again.

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

From this version on, an older version does not start on a newer database: it stops at the page described above, because a newer version may have renamed or dropped columns, not only added them. Versions before this one open it anyway and run against it, so put the backup back before you start one of them. The backup from `backups/` is the database as it was before the newer version changed it, which is why going back means putting it back.
