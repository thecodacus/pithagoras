# Models and providers

**Settings → Providers** is where the agent's models come from, and
**Settings → Defaults** is what a new chat starts with. Both are the web side of
pi's own files, so what is set up here works for pi on the command line too.

## Providers

Each provider is a card in the list, with a dot for whether it answers.
**Add a provider** offers:

| Kind | For |
| --- | --- |
| llama.cpp | A `llama-server` on this machine or the network. Shows how far it is through a long prompt |
| llama-swap | A gateway that starts the right `llama-server` for each model |
| Ollama | Ollama's OpenAI endpoint, at port 11434 by default |
| OpenRouter | Hosted, with a key |
| Another hosted service | Anything pi already knows the catalogue of — Anthropic, OpenAI and so on — filed under the name pi knows it by |
| Custom endpoint | Any OpenAI-compatible server. The address is the base of its API, usually ending in `/v1` |

A server is reached by **Address** and, when it wants one, an **API key**. Its
models are looked up as soon as it answers, and you tick the ones to offer.
**Filter models** narrows a long list; **Add a model by its id** covers a server
that lists none. A chosen model the server no longer lists is marked *Not listed
by the server right now* rather than dropped. Each model shows whether it *Sees
images* and *Thinks*, and its context **Window**.

A hosted service needs no address: pi ships its catalogue, and every model from
it is in the model menu once a key is set.

### Where things are kept

pi keeps servers reached by URL in `models.json`, and keys for hosted services
in `auth.json`, both under `~/.pi/agent` (on the data volume in the container —
see [Volumes](/guide/deploying#volumes)). The portal writes them the way pi
reads them and keeps whatever it knows nothing about, so a file edited by hand
survives. A `models.json` with comments is copied to a `.bak` file before it is
rewritten, and one that cannot be read is left untouched with the reason.

Keys are stored in `auth.json`, readable by the portal's user only, and are never
sent back to the browser: the card shows *key set*, or a short hint of it.
Leaving the field empty keeps the stored key. A key written as `$NAME` is read
from the environment; a service whose key is already in the environment shows
*key from the environment*, and removing the provider does not touch that.

Removing a provider does not change the model that was chosen from it. A chat
that is sent to a model that has no provider any more answers "There is no model
to answer with" and says where to pick another: Settings → Models.

The kind — llama-swap, Ollama — is something pi has no field for. It is kept in
`portal-providers.json` beside pi's files, and a server without an entry is told
by its name and address.

### Status dots

*Online · 42 ms* and *Offline* come from asking each server now. Choose **Ask
again** to check. A server that answers but lists no models says so.

### Provider packages

A service pi does not know of on its own — LiteLLM, Cohere, a gateway — often
comes as a package that adds it. **Provider packages** searches npm for them and
installs one in a click, into [Extensions](/guide/extensions). A package's models
show in the model menu of chats started after it is installed; most want a key
or address of their own, which appear under *Extension settings* when it can be
set there. Packages run inside pi with the agent's own rights, so install ones
you trust.

### Setup assistant

Opened from the Providers page (**Setup assistant**), and offered on its own,
once, when the portal has no model to talk to. It takes four steps — where the
models come from, what new chats start with (model and effort), which of the
portal's own extensions to have (a set such as Developer or Creative, or a
choice by hand; see [What a portal starts with](/guide/extensions#what-a-portal-starts-with)),
and what the agent can do besides, with a shortlist of packages. **Back** returns
to the step before, and **Set up later** dismisses it in this browser; everything
can be changed later in Settings, and **Setup assistant** on the Providers page
opens it again.

## Defaults

**Settings → Defaults** holds what new chats start with. Each chat keeps its own
choice under the chat box, and a running chat is never rewritten.

- **Default provider** and **Default model** — empty inherits pi's own default,
  shown as the placeholder.
- **Default effort** — the thinking level. Clicking the active level again goes
  back to pi's default. It only applies to a model that thinks.
- **Default context window in tokens** — how many tokens a chat may hold before
  it is compacted, in every chat. A model that declares less keeps its own number,
  and one set for a model from its context pill wins over this. Useful for a
  server that gives each chat less than the model declares — llama.cpp with
  `--parallel` gives each chat a share of the total. Not available with
  `EXECUTOR=container`, where pi runs beyond the portal's reach.
- **Kept when compacting** — how much of the most recent conversation is kept
  word for word; only what is older becomes a summary. pi's default is a third of
  a 64k window, which is why compacting can look as though it did nothing. On a
  window under 120k the portal holds the number to a sixth of the window, so a
  small window is not left with nothing to compact; the number here is the most it
  keeps.
- **Routine reports** — where a scheduled run reports to. See
  [Routines](/guide/routines).

The order in which these are resolved, from a session's own choice down to a
last-resort constant, is in [Settings](/guide/settings#where-a-model-comes-from).
