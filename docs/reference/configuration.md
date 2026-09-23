# Configuration

Configuration comes from four places. Knowing which one wins saves a lot of
confusion.

## The four layers

| Layer | Set from | Applies to |
| --- | --- | --- |
| Session | The pills under the composer | One session |
| Portal | Settings → General | New sessions |
| Environment | Compose / `.env` | The deployment |
| pi | `~/.pi/agent/settings.json` | pi itself, everywhere |

For model, effort and provider, they resolve in that order — first non-empty
wins, with a last-resort constant behind pi:

```
session → portal override → environment → pi settings.json → fallback
```

Everything past the session layer is a *default*. A session that has made its
own choice keeps it, and changing a default never rewrites a running session.

::: tip Empty means inherit
`PI_PROVIDER`, `PI_MODEL` and `PI_THINKING_LEVEL` are overrides, and they are
empty in the compose file on purpose. Give them a value and pi's own
`settings.json` can never be reached. The same is true in Settings → General:
an empty field inherits, and clearing one hands the setting back.
:::

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORTAL_PASSWORD` | — | Required. The single login password. |
| `PORTAL_SECRET` | random | Signs the cookie. Set it to survive restarts. |
| `PORT` | `4100` | Listen port. |
| `DATA_DIR` | `./data` (image: `/data`) | Where `portal.db` lives. |
| `SESSION_DIR` | `./data/sessions` (image: `/data/sessions`) | Per-session working areas. |
| `WORKSPACE_ROOT` | `/workspaces` | Directories sessions can be created against. |
| `BIN_DIR` | `/data/bin` | Persistent CLI installation directory added to PATH. |
| `PI_CODING_AGENT_DIR` | `$HOME/.pi/agent` | Override pi’s settings/package directory. |
| `LLAMA_BASE_URL` | — | Read by pi’s installed llama extension; not by the portal directly. |
| `CHANNELS_DIR` | `/data/channels` | Installed channel packages. |
| `AGENT_HOME` | `/data/agent-home` | The agent session's directory. |
| `HOME` | `/data/home` | pi's home — its settings and packages. |
| `EXECUTOR` | `host` | `host` or `container`. |
| `PI_IMAGE` | `pithagoras-runner:latest` | Image for the container executor. |
| `TASK_MEMORY_MB` | `2048` | Container executor memory ceiling. |
| `TASK_CPUS` | `2` | Container executor CPU ceiling. |
| `TASK_PIDS_LIMIT` | `512` | Container executor process ceiling. |
| `PI_PROVIDER` | — | Override for pi's `defaultProvider`. |
| `PI_MODEL` | — | Override for pi's `defaultModel`. |
| `PI_THINKING_LEVEL` | — | Override for pi's `defaultThinkingLevel`. |

The host executor inherits the portal environment. The container executor currently forwards `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PI_PROVIDER`, and `PI_MODEL`; it does not forward arbitrary extension variables. Explicit session provider/model choices are passed as CLI arguments.

Both Compose files forward `PI_IMAGE` and the three `TASK_*` limits. These limits apply only to `EXECUTOR=container`: memory must be an integer of at least 6 MiB, CPUs must be positive (fractions are allowed), and the process limit must be a positive integer. Empty values inherit defaults; zero, negative and non-numeric values are rejected explicitly.

`HOME` on the data volume is load-bearing. Point it back at the container
filesystem and every image rebuild silently wipes the pi packages you installed.

## pi's settings.json

Lives at `$HOME/.pi/agent/settings.json` — `/data/home/.pi/agent/settings.json`
in the container. Editable from Settings → Advanced, which validates it as JSON
before writing; a broken file stops every future session from starting.

```json
{
  "defaultProvider": "llama-server=http://192.168.1.101:8080",
  "defaultModel": "qwen36-35b-a3b-mtp",
  "defaultThinkingLevel": "high",
  "packages": ["npm:pi-llama-cpp"],
  "llamaServerUrl": "http://192.168.1.101:8080",
  "compaction": { "enabled": true }
}
```

Extension settings live here too, alongside pi's own. That is why the portal
writes single keys rather than replacing the file: a wholesale overwrite would
take the `packages` list with it.

## Portal settings

Stored in the `settings` table, edited in Settings → General. Saving an empty
value **deletes** the row rather than storing an empty string, which is what
makes "inherit" reachable again after you have set something.

The `GET /api/settings` response separates the three so a client can tell them
apart:

```json
{
  "settings": { "provider": "llama-server=…", "model": "qwen36-35b-a3b-mtp" },
  "stored":   {},
  "defaults": { "provider": "llama-server=…", "model": "qwen36-35b-a3b-mtp" }
}
```

`stored` empty and `settings` matching `defaults` means everything is inherited
— nothing is pinned.
