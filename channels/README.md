# Channel packages

The channels that ship with the portal: `telegram` (long polling), `slack` (Socket
Mode), `discord` (the Gateway), `signal` (a signal-cli daemon you run, see
[Signal](https://thecodacus.github.io/pithagoras/channels/signal)) and `webhook` (a
listener). They are loaded from this folder, none of them needs a dependency, and each is a package in the same form as one
you would write: there is nothing special about them beyond where they live.

How a channel works, what its package looks like (`manifest`, `start(ctx)`, and
`ctx.ask` with who sent the message) and how to install a third-party one are in the
docs, and in `docs/channels/` of this repository:

- [Agent and channels](https://thecodacus.github.io/pithagoras/channels/): what a channel is, sessions, the supervisor.
- [Writing a channel](https://thecodacus.github.io/pithagoras/channels/writing-a-channel): the package, `ctx`, and the identity every message has to carry.
