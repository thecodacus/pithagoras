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

A password that is lost is removed with `npm run reset-password`, or `docker exec -it pithagoras node server/dist/reset-password.js` in a container, see [A lost password](/guide/deploying#a-lost-password).

## Upgrading from the first release

What the first start after an install of version 0.1.0, or of any build made before this one, shows and needs:

- **The Upgrading page.** The database is checked, backed up and upgraded, as above. The schema version was raised for this release, so an install made before it goes through this once.
- **A voice add-on.** The container of a voice add-on that an older version made is made again, with the engines and the card it had, the next time it is started or installed from Settings → Add-ons; the models and builds in its volume are kept. Rebuilding the portal does not touch it until then.
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

From this version on, an older version does not start on a newer database: it stops at the page described above, because a newer version may have renamed or dropped columns, not only added them. Versions before this one open it anyway and run against it, so put the backup back before you start one of them. The backup from `backups/` is the database as it was before the newer version changed it, which is why going back means putting it back.
