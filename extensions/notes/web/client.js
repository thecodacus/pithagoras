/**
 * The Notes extension's half in the portal's page: plain JavaScript, loaded as
 * it is. It is called once with the portal, and puts what it draws into the
 * portal's slots:
 *
 *   chat.panel          the chat's notes, beside the conversation
 *   chat.header.action  a button that pins the agent's last reply
 *   nav.page            a page in the sidebar
 *
 * Components are made with the portal's own React (`portal.React`), without
 * JSX, so nothing here needs building. The look is in client.css, in the
 * portal's own colours.
 */
export default function (portal) {
  const { React } = portal;
  const { useEffect, useState } = React;
  const h = React.createElement;

  const icon = (path) => () =>
    h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h("path", { d: path }));
  const NoteIcon = icon("M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3ZM15 3v6h6M8 13h8M8 17h5");
  const PinIcon = icon("M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z");

  /** The chat's notes as its extension holds them: asked for when drawn, then heard as they change. */
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

  function NotesPanel({ channel }) {
    const { notes, error } = useNotes(channel);
    const [text, setText] = useState("");
    const pin = (event) => {
      event.preventDefault();
      if (!text.trim()) return;
      channel.send({ type: "add", text }).catch(() => {});
      setText("");
    };
    if (error) return h("p", { className: "pn-empty", role: "alert" }, error);
    return h(
      "div",
      { className: "pn-panel" },
      h(
        "form",
        { className: "pn-add", onSubmit: pin },
        h("input", { value: text, onChange: (event) => setText(event.target.value), placeholder: "Pin a note…", "aria-label": "New note" }),
        h("button", { type: "submit", disabled: !text.trim() }, "Pin"),
      ),
      notes === null
        ? h("p", { className: "pn-empty" }, "Loading…")
        : notes.length === 0
          ? h("p", { className: "pn-empty" }, "Nothing pinned yet. Ask the agent to note something, or pin a note yourself.")
          : h(
              "ul",
              { className: "pn-list" },
              notes.map((note) =>
                h(
                  "li",
                  { key: note.id },
                  h("span", { className: "pn-by" }, note.by === "agent" ? "Agent" : "You"),
                  h("p", null, note.text),
                  h("button", { type: "button", "aria-label": "Remove this note", title: "Remove", onClick: () => channel.send({ type: "remove", id: note.id }).catch(() => {}) }, "✕"),
                ),
              ),
            ),
    );
  }

  function PinLastReply({ channel, panels }) {
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
    const label = nothing ? "The agent has not replied yet" : "Pin the agent's last reply to Notes";
    return h("button", { type: "button", className: "pn-pin", title: label, "aria-label": label, onClick: pin }, h(PinIcon));
  }

  /**
   * A page outside any chat has no pi extension to ask: what it shows comes
   * from the portal's own API, with the login of whoever is looking.
   */
  function NotesPage() {
    const [chats, setChats] = useState(null);
    const [error, setError] = useState("");
    useEffect(() => {
      fetch("/api/sessions")
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`The portal answered ${response.status}`))))
        .then((body) => setChats(body.sessions))
        .catch((e) => setError(e.message));
    }, []);
    return h(
      "div",
      { className: "pn-page" },
      h("h2", null, "Notes"),
      h("p", { className: "pn-lead" }, "Notes are kept with the chat they were pinned in. Open a chat and its Notes panel to read them."),
      error
        ? h("p", { className: "pn-empty", role: "alert" }, error)
        : chats === null
          ? h("p", { className: "pn-empty" }, "Loading…")
          : h(
              "ul",
              { className: "pn-chats" },
              chats.map((chat) => h("li", { key: chat.id }, h("button", { type: "button", onClick: () => portal.navigate(`/s/${chat.id}`) }, chat.title || "Untitled chat"))),
            ),
    );
  }

  portal.slots.register("chat.panel", { id: "notes", title: "Notes", icon: NoteIcon, component: NotesPanel });
  portal.slots.register("chat.header.action", { id: "pin-last", component: PinLastReply });
  portal.slots.register("nav.page", { id: "notes", title: "Notes", icon: NoteIcon, component: NotesPage });
}
