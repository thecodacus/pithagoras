# Routines

A routine is a standing instruction and a schedule. When it fires the agent is
given the instruction, does the work, and goes quiet again — nobody is waiting
on the other end, so a run may take as long as it takes.

Routines live in the sidebar next to Sessions and Agents. By default they run in the
first agent's home directory and share its memory; **Runs in** gives one another
[agent's](/guide/agents) home or a project instead, and its runs work in that folder. Each place keeps its own session, so
moving a routine back picks up where it left off. If the folder is later removed,
the routine says so and its runs fail until another place is chosen.

## Scheduling

Either a five-field cron expression (`0 9 * * 1-5`) or one of the `@shorthands`,
**or** a single moment for a one-off. Never both — a routine that repeats and a
routine that happens once are different things, and the form says so rather than
guessing. As in cron, Sunday is `0` or `7`, and days and months can be written
by name: `30 8 * * mon-fri`, `0 9 1 jan *`.

**Run now** on a one-off whose moment is still to come is a try-out: the moment
stays, and it runs then as well. Giving a one-off that has already run a new
time switches it back on.

A one-off catches up: if its moment passed while the portal was down, it still
runs when the portal comes back. A recurring one does not — it simply waits for
its next slot, because ten missed hourly runs firing at once helps nobody.

A run that a restart cuts off — an update, a crash — is listed as **interrupted**,
with a note saying so, instead of staying "running". A recurring routine carries
on with its next slot. A one-off is switched off and is **not** run again by
itself: the run may have done part of what it was asked, and doing that twice
can be worse than not finishing. Look at what it did, then run it again by hand
or give it a new time.

A run that you stop with Stop in its chat is listed as **stopped**, with the note
"Stopped before it finished." and what the agent had written by then, not as a
success with half an answer. A recurring routine carries on with its next slot;
a one-off is switched off and does not count as done, as after a restart.

By default a routine keeps one session, so a run can see what the last one did —
"nothing new since yesterday" needs yesterday. **Fresh session each run** gives
each one a clean start instead, for work where history is only noise. Its agent is
let go when the run ends, unless a build or a server it started in the background
is still running: the agent is kept until that is over, as for an idle chat (see
[Extensions](/guide/extensions)).

A run that is still going after an hour is listed as an error. In a fresh session
it is stopped then, as pressing Stop in its chat would; in the session a routine
keeps, it carries on there.

## Reporting back

A run's closing account is stored, and stored is where it stays unless the
routine has somewhere to report. Give it one and the agent gets a `report` tool.

The agent decides **whether** a run is worth reporting and writes the message
itself. It does not decide **where** — that is configuration, so a routine
cannot start messaging somewhere it was never pointed at.

Two places to set it:

- **Settings → Defaults → Routine reports** is the portal-wide default. Every
  routine inherits it, including one the agent creates for itself from a chat.
- **A routine's own page** overrides that: a different conversation, or *Never
  report* for one that should stay quiet whatever the default is.

A destination is a conversation that already exists — you pick "telegram —
Sam Rivera", not a chat id. Only channels that can start a conversation appear;
a webhook cannot, because it only ever answers a request that is already open.

A routine created from a conversation that came through a channel reports back
**into that conversation** — asking for a morning summary in Telegram means
"tell me here". The portal-wide default applies to routines created any other
way, a chat in the portal's own pages included, and to conversations whose
channel cannot be messaged out of the blue.

What a routine says into a conversation becomes part of it. Ask "what did you
mean by that?" the next morning and the agent knows what "that" was, because the
report is folded into the conversation's next turn rather than only being
delivered.

::: tip Silence is a result
The agent is told to skip the report when a run was uneventful. A report that
says nothing happened trains you to ignore the next one — and the next one might
be the one that mattered.
:::

## The injection guard

By default a run that reads something untrusted — logs pulled over the network,
a web page, mail — cannot then push, write onto `PATH`, upload data or read
credentials. That is the [guard](/guide/security), and for most routines it
never comes up.

It gets in the way of one honest shape of work: **read the logs, then fix what
they say**. Fetching the logs taints the session, and the fix is a push. Grepping
those logs for the word `token` looks like reading credentials. Nothing is
wrong, and the run stops anyway.

**Settings → Guard** lets that routine alone do what a rule holds back, one rule
at a time: the log-fixing routine above needs `publish` and maybe
`read-credentials` off, and nothing else. Every other rule still holds for it,
and its runs read the change at their next call. The routine's own page says how
its rules stand, with a link to change them. A routine from before the Guard page
whose one switch was off is exempt from every rule until you switch some back on.
Two things stay:

- Untrusted content is still labelled as untrusted, so the agent knows what it
  is reading. That half never gets in the way.
- Anything it does that the rules would have stopped is recorded in **Audit** as
  `allowed-by-exemption`, with the rule that would have fired.

::: warning Turn it off for the routine, not the habit
The rules exist for when the log line was written by somebody who wanted the
agent to read it. Exempt the routine that needs it, leave the rest alone, and
read the audit occasionally.
:::

## Tools

**Tools** on a routine's page is the same list a chat's tools control and a
project's show, grouped the same way (built in, each extension, each MCP
server). What you switch there is what every run of the routine starts with,
saved as each switch is flipped, apart from the form's **Save**. A routine's
switches are exceptions to what the layers under it leave, both ways: a tool on
where they have it off, off where they have it on. A tool the routine never
mentioned keeps following them, so a later change to the default still reaches it.

The layers, each an exception to the one before it:

1. **Settings → Tools**, the default for every conversation;
2. **the agent** whose home the routine runs in (see [Agents](/guide/agents#tools));
3. **the project** it runs in (see [Projects](/guide/projects#tools));
4. **the routine**;
5. **the run's own chat**, which can still switch a tool for itself and has the last word.

An agent and a project do not both apply to one place: a project is under the
workspace root, an agent's home is not.

Deleting a routine takes its layer with it. The chats of its runs are kept, and a
person who goes on with one has what the layers under the routine's leave, and
what that chat switched itself: a tool the routine had off is on again there
where those layers have it on.

### The browser

The [browser](/guide/browser)'s tools, Browser's group (`pithagoras-browser`) in
that list, are tools like any other here: having them is having the browser,
which is signed into the agent's own accounts, and a routine's runs have them as
the layers above say until the routine switches them. A new routine has them
wherever a chat in its place would. To keep routines away from the browser
unless one is switched on for it, switch the group off in Settings → Tools and on
where it is wanted: in the routines that need it, and in chats, projects or
agents. A routine had a **Browser** switch of its own once,
which held them off unless it was on: a portal upgraded from then has what each
routine's switch said written into its tools (see
[Upgrading](/guide/upgrading#browser-is-an-extension)). Every page a run opens
is recorded in [Audit](/guide/sessions#audit).

## Letting the agent manage them

Your conversations with an agent get `routines_list`, `routine_create`,
`routine_update` and `routine_run`: a chat started with **+** or **New** in an
agent's home, a chat on the Agents page, and a conversation that came through a
channel. So "remind me every morning to check the backups" writes the routine
instead of telling you where the button is. They are for you: a routine runs as
you, so a colleague or a guest cannot make, change or run one through the agent,
whatever is [allowed](/people/rules) for them. A routine made from a chat runs in
the home of the agent you asked, unless you name a project, and one made from a chat
in the portal reports to the portal-wide default (see
[Reporting back](#reporting-back)), as such a chat has no channel to answer on.

A chat working in a project or any other folder that is not an agent's home does
not get them — a session working inside your repository has no business
rescheduling anything. Neither does a routine run: a routine that can
create routines can build a chain with nobody watching it.

There is no delete tool. Disabling stops a routine firing and leaves it visible,
so a misheard "cancel the morning thing" is recoverable. Deleting stays a
deliberate act in the UI.
