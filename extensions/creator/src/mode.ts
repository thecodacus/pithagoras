/**
 * What both halves of Creator mode say: the mode as the picker above the message box offers it, and the reasons of its
 * rows in Settings → Audit. In English, as the server half gives them; the page shows each in its language through
 * the extension's own texts (de.ts), which the browser half adds.
 */

/** A text to be translated where it is shown: marked so that the texts' check (tests/i18n.test.mts) finds it. */
export const msg = <T extends string>(text: T): T => text;

/** Creator mode, as the server half offers it (`portal.modes.provide`): asked first, with what choosing it grants. */
export const MODE = {
  id: "creator",
  label: msg("Creator mode"),
  description: msg("The agent writes extensions for the portal, installs them, and calls their tools in this chat."),
  confirm: msg(
    "The agent in this chat will write extensions and install them into the portal. It installs without asking you, except after this chat has read something that may be a prompt injection. An installed extension runs with the portal's own rights, outside the sandbox: it can read and change everything the portal can, including Docker where the portal is given it. Its tools are offered in every chat and run there without asking you, and its pages run in every browser signed in to the portal, with that sign-in. Its server half runs in a process of its own, which is ended if it hangs or uses too much memory: that keeps the portal running, and does not limit what the code can do. Every install is recorded in Settings → Audit, and each extension can be switched off or removed in Settings → Extensions.",
  ),
};

/** What an audit row of Creator's says was done. */
export const DONE = { installed: msg("Installed"), again: msg("Installed again"), removed: msg("Removed") };
