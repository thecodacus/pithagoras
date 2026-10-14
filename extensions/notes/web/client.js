/**
 * The Notes extension's half in the portal's page: plain JavaScript, loaded as
 * it is. It is called once with the portal, and puts what it draws into the
 * portal's slots:
 *
 *   chat.panel          the chat's notes, beside the conversation
 *   chat.header.action  a button that pins the agent's last reply
 *   chat.tool           how a call of its own `note` tool is drawn
 *   voice.window        the same notes, in voice mode
 *   nav.page            every chat's notes, on a page in the sidebar
 *
 * Components are made with the portal's own React (`portal.React`), without
 * JSX, so nothing here needs building. The look is in client.css, in the
 * portal's own colours.
 */
export default function (portal) {
  const { React, ui, t } = portal;
  const { useEffect, useState, useSyncExternalStore } = React;
  const h = React.createElement;

  // Its own texts in another language: English is what the code says.
  portal.locale.add("de", {
    Notes: "Notizen",
    "Pin a note…": "Notiz anheften…",
    "New note": "Neue Notiz",
    Pin: "Anheften",
    All: "Alle",
    Agent: "Agent",
    You: "Du",
    "Nothing pinned yet. Ask the agent to note something, or pin a note yourself.": "Noch nichts angeheftet. Bitte den Agenten, etwas zu notieren, oder hefte selbst eine Notiz an.",
    "Remove this note": "Diese Notiz entfernen",
    "Pin the agent's last reply to Notes": "Die letzte Antwort des Agenten an die Notizen heften",
    "The agent has not replied yet": "Der Agent hat noch nicht geantwortet",
    "Discard the note you were writing?": "Die angefangene Notiz verwerfen?",
    "It has not been pinned.": "Sie wurde nicht angeheftet.",
    Discard: "Verwerfen",
    "Pinned to Notes": "An die Notizen geheftet",
    "Open Notes": "Notizen öffnen",
    "Every chat's notes. A note is kept with the chat it was pinned in.": "Die Notizen aller Chats. Eine Notiz bleibt bei dem Chat, in dem sie angeheftet wurde.",
    "No chat has notes yet.": "Noch hat kein Chat Notizen.",
  });

  const icon = (path) => () =>
    h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h("path", { d: path }));
  const NoteIcon = icon("M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3ZM15 3v6h6M8 13h8M8 17h5");
  const PinIcon = icon("M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z");

  // How many notes each chat has, as the server half says: to a page as it
  // opens the chat, and again when the number changes. Kept here, outside any
  // component, so that it is there before the panel is ever opened.
  const counts = new Map();
  const watching = new Set();
  portal.server.on((chatId, data) => {
    if (!data || data.type !== "count") return;
    counts.set(chatId, data.count);
    for (const watcher of watching) watcher();
  });
  const useCount = (chatId) =>
    useSyncExternalStore(
      (watcher) => (watching.add(watcher), () => watching.delete(watcher)),
      () => counts.get(chatId) ?? 0,
    );

  /** The chat's notes as its pi extension holds them: asked for when drawn, then heard as they change. */
  function useNotes(channel) {
    const [notes, setNotes] = useState(null);
    const [error, setError] = useState("");
    useEffect(() => {
      const off = channel.on((data) => {
        if (data && data.type === "notes") setNotes(data.notes);
      });
      channel.send({ type: "ready" }).catch((e) => setError(e.message));
      return off;
    }, [channel]);
    return { notes, error };
  }

  function NotesList({ notes, channel }) {
    if (notes === null) return h("p", { className: "pn-empty" }, t("Loading…"));
    if (notes.length === 0) return h("p", { className: "pn-empty" }, t("Nothing pinned yet. Ask the agent to note something, or pin a note yourself."));
    return h(
      "ul",
      { className: "pn-list" },
      notes.map((note) =>
        h(
          "li",
          { key: note.id },
          h("span", { className: "pn-by" }, note.by === "agent" ? t("Agent") : t("You")),
          h("p", null, note.text),
          h("button", { type: "button", "aria-label": t("Remove this note"), title: t("Remove"), onClick: () => channel.send({ type: "remove", id: note.id }).catch(() => {}) }, "✕"),
        ),
      ),
    );
  }

  // Whose notes are shown: said in the panel's head, used in its body. What the two share is the panel's own state.
  const WHOSE = ["all", "agent", "you"];
  const LABEL = { all: "All", agent: "Agent", you: "You" };

  function NotesTabs({ panel }) {
    portal.locale.use();
    const shown = panel.state ?? "all";
    return h(
      "div",
      { className: "chat-tabs", role: "tablist", "aria-label": t("Notes"), onKeyDown: ui.tabKeys },
      WHOSE.map((whose) => h("button", { key: whose, type: "button", role: "tab", "aria-selected": shown === whose, tabIndex: shown === whose ? 0 : -1, onClick: () => panel.setState(whose) }, t(LABEL[whose]))),
    );
  }

  function NotesPanel({ channel, panel }) {
    portal.locale.use();
    const { notes, error } = useNotes(channel);
    // Opened with something to pin (`panels.open("notes", { draft })`): it is in the box.
    const [text, setText] = useState(panel?.params?.draft ?? "");
    useEffect(() => {
      if (panel?.params?.draft) setText(panel.params.draft);
    }, [panel?.params]);
    // A note being written would be lost: the panel is not the one closed to make room, and asks before it is closed by hand.
    const writing = text.trim() !== "";
    useEffect(() => {
      if (!panel) return;
      panel.keep(writing);
      panel.guardClose(writing ? () => ui.confirm({ title: t("Discard the note you were writing?"), message: t("It has not been pinned."), confirmLabel: t("Discard"), danger: true }) : null);
    }, [writing]);
    // Kept in the box until it has been taken: a note that could not be sent is not lost, and says why.
    const [failed, setFailed] = useState("");
    const pin = (event) => {
      event.preventDefault();
      if (!writing) return;
      setFailed("");
      channel.send({ type: "add", text }).then(
        () => setText((now) => (now === text ? "" : now)),
        (e) => setFailed(e.message),
      );
    };
    if (error) return h("p", { className: "pn-empty", role: "alert" }, error);
    const whose = panel?.state ?? "all";
    return h(
      "div",
      { className: "pn-panel" },
      h(
        "form",
        { className: "pn-add", onSubmit: pin },
        h("input", { value: text, onChange: (event) => setText(event.target.value), placeholder: t("Pin a note…"), "aria-label": t("New note") }),
        h("button", { type: "submit", disabled: !writing }, t("Pin")),
      ),
      failed && h("p", { className: "pn-empty", role: "alert" }, failed),
      h(NotesList, { notes: notes && (whose === "all" ? notes : notes.filter((note) => note.by === whose)), channel }),
    );
  }

  function PinLastReply({ channel, panels }) {
    portal.locale.use();
    const [nothing, setNothing] = useState(false);
    useEffect(
      () =>
        channel.on((data) => {
          if (data && data.type === "nothing-to-pin") setNothing(true);
        }),
      [channel],
    );
    useEffect(() => {
      if (!nothing) return;
      const timer = setTimeout(() => setNothing(false), 2500);
      return () => clearTimeout(timer);
    }, [nothing]);
    const pin = () => {
      channel.send({ type: "pin-last" }).catch(() => {});
      panels.open("notes");
    };
    const label = nothing ? t("The agent has not replied yet") : t("Pin the agent's last reply to Notes");
    return h("button", { type: "button", className: "pn-pin", title: label, "aria-label": label, onClick: pin }, h(PinIcon));
  }

  /** A call of the `note` tool in the conversation: the note it pinned, and a way to the panel, in place of the portal's card. */
  function NoteCall({ call, panels, card }) {
    portal.locale.use();
    // While it runs, and when it failed, the portal's own card says it best.
    if (call.status !== "done") return card;
    return h(
      "div",
      { className: "pn-call" },
      h(PinIcon),
      h("div", null, h("span", { className: "pn-by" }, t("Pinned to Notes")), h("p", null, String(call.input.text ?? ""))),
      h("button", { type: "button", onClick: () => panels.open("notes") }, t("Open Notes")),
    );
  }

  /**
   * Every chat's notes. A page outside a chat has no pi extension to ask, so
   * this is the server half's to answer: its own route, asked as the portal's
   * own are.
   */
  function NotesPage() {
    portal.locale.use();
    const [chats, setChats] = useState(null);
    const [error, setError] = useState(null);
    const load = () => {
      setError(null);
      portal.api
        .json(portal.api.url("/notes"))
        .then((body) => setChats(body.chats))
        .catch(setError);
    };
    useEffect(load, []);
    return h(
      "div",
      { className: "pn-page" },
      h(ui.PageHeader, { icon: h(NoteIcon), title: t("Notes"), description: t("Every chat's notes. A note is kept with the chat it was pinned in.") }),
      error
        ? h(ui.LoadFailed, { error, onRetry: load })
        : chats === null
          ? h(ui.RowsSkeleton, { rows: 3, label: t("Loading…") })
          : chats.length === 0
            ? h(ui.Empty, null, t("No chat has notes yet."))
            : chats.map((chat) =>
                h(
                  "section",
                  { key: chat.id, className: "pn-chat" },
                  h("button", { type: "button", onClick: () => portal.navigate(`/s/${chat.id}`) }, chat.title || t("Untitled chat")),
                  h("ul", { className: "pn-list" }, chat.notes.map((note) => h("li", { key: note.id }, h("span", { className: "pn-by" }, note.by === "agent" ? t("Agent") : t("You")), h("p", null, note.text)))),
                ),
              ),
    );
  }

  portal.slots.register("chat.panel", {
    id: "notes",
    title: "Notes",
    icon: NoteIcon,
    component: NotesPanel,
    header: NotesTabs,
    // Its button says how many there are, from what the server half told this page: the chat's pi is not started for it.
    useButton: ({ chat }) => {
      const count = useCount(chat.id);
      return { title: count ? `${t("Notes")} (${count})` : t("Notes") };
    },
  });
  portal.slots.register("chat.header.action", { id: "pin-last", component: PinLastReply });
  portal.slots.register("chat.tool", { id: "note", tool: "note", component: NoteCall });
  portal.slots.register("voice.window", { id: "notes", title: "Notes", icon: NoteIcon, component: NotesPanel });
  portal.slots.register("nav.page", { id: "notes", title: "Notes", icon: NoteIcon, component: NotesPage });

  // What anything else in the page can ask of Notes: pin this, in the chat on screen.
  portal.commands.register("pithagoras-notes.pin", (text) => portal.panels.open("pithagoras-notes/notes", { draft: String(text ?? "") }));
}
