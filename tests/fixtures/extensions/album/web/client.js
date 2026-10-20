/**
 * A stand-in for the portal's own specs: an extension with what a gallery of
 * pictures brings, through the hooks any extension has, so that a spec of the
 * portal's own tests the portal with it and needs none of the extensions the
 * portal ships, any of which can be removed.
 *
 *   nav.page       "Album": its pictures in the portal's preview, each marked for the viewer to give focus back
 *                  to; the portal's viewer, with a button of the album's beside its own; which pictures it shows,
 *                  kept in the page's address, and the address it found when it was first drawn; the portal's
 *                  dialog, which asks before a name typed in it is lost; a slideshow of its own over the page, which
 *                  goes as the portal's dialogs do; and the way to its page in Settings
 *   settings.page  "Album", with a mark of its own in Settings' list: a field that asks before what is typed in it
 *                  is lost, and a group that folds, which Settings' search opens
 *   chat.tool      plot_sales: the portal's card in the chat, and on its card in voice mode a tile of the album's
 *                  and what the card says
 *
 * Plain JavaScript with the portal's React, as the Notes example is: nothing
 * to build.
 */
const PICTURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==";
const PICTURES = [
  { id: "dunes", src: PICTURE, alt: "Dunes at noon", caption: "Dunes at noon" },
  { id: "harbour", src: PICTURE, alt: "A harbour at dusk", caption: "A harbour at dusk" },
];

export default function (portal) {
  const { React, ui } = portal;
  const h = React.createElement;

  const Icon = (props) => h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, "data-testid": "album-icon", ...props }, h("rect", { x: 3, y: 3, width: 18, height: 18, rx: 2 }), h("circle", { cx: 9, cy: 9, r: 2 }));

  function Rename({ onClose }) {
    const [name, setName] = React.useState("");
    return h(
      ui.Modal,
      { title: "Rename the album", subtitle: "As the sidebar lists it", onClose, unsaved: name !== "", footer: h("button", { type: "button", className: ui.classes.primary, onClick: onClose }, "Done") },
      h("input", { "aria-label": "Album name", className: ui.classes.input, value: name, onChange: (e) => setName(e.target.value) }),
    );
  }

  /** Its own part over the page: when it goes, a picture of it leaves, as the portal's dialogs do. */
  function Slideshow({ onClose }) {
    const leaving = ui.useLeaveRef("dialog");
    return h(
      "div",
      { ref: leaving, role: "dialog", "aria-label": "Slideshow", style: { position: "fixed", inset: 0, zIndex: 55, display: "grid", placeItems: "center", background: "rgb(0 0 0 / .8)" } },
      h("figure", null, h("img", { src: PICTURES[0].src, alt: PICTURES[0].alt, width: 240, height: 240 }), h("button", { type: "button", onClick: onClose }, "Close the slideshow")),
    );
  }

  function Album() {
    // Which pictures are shown is in the address, so that Back and a link keep it.
    const { path, search } = portal.useLocation();
    // What a page that reads its address once, as it is first drawn, goes by.
    const [first] = React.useState(() => path + search);
    const onlyMarked = new URLSearchParams(search).get("show") === "marked";
    const [marks, setMarks] = React.useState([]);
    const [open, setOpen] = React.useState(null);
    const [renaming, setRenaming] = React.useState(false);
    const [showing, setShowing] = React.useState(false);
    const shown = onlyMarked ? PICTURES.filter((p) => marks.includes(p.id)) : PICTURES;
    const show = (marked) => portal.navigate(marked ? `${path}?show=marked` : path, { replace: true });
    const mark = (id) => setMarks((was) => (was.includes(id) ? was.filter((m) => m !== id) : [...was, id]));
    return h(
      "div",
      { style: { padding: 24 } },
      h("p", { "data-testid": "album-address" }, path + search),
      h("p", { "data-testid": "album-first-address" }, first),
      h(
        "div",
        { role: "group", "aria-label": "Shown" },
        h("button", { type: "button", "aria-pressed": !onlyMarked, onClick: () => show(false) }, "All"),
        h("button", { type: "button", "aria-pressed": onlyMarked, onClick: () => show(true) }, "Marked"),
      ),
      shown.map((p) => h(ui.ImagePreview, { key: p.id, state: "done", src: p.src, title: p.caption, pictureId: p.id, onOpen: () => setOpen(p.id) })),
      open &&
        h(ui.ImageViewer, {
          pictures: shown,
          startId: open,
          onClose: () => setOpen(null),
          anchor: (id) => document.querySelector(`[data-picture-id="${id}"]`),
          actions: (p) => h("button", { type: "button", className: ui.classes.viewerButton, "aria-pressed": marks.includes(p.id), "aria-label": `Mark ${p.alt}`, onClick: () => mark(p.id) }, "★"),
        }),
      h("button", { type: "button", onClick: () => setRenaming(true) }, "Rename the album"),
      renaming && h(Rename, { onClose: () => setRenaming(false) }),
      h("button", { type: "button", onClick: () => setShowing(true) }, "Start the slideshow"),
      showing && h(Slideshow, { onClose: () => setShowing(false) }),
      h("button", { type: "button", onClick: () => portal.navigate(`/settings/x/${portal.extension}`) }, "Album settings"),
    );
  }

  function AlbumSettings() {
    const [title, setTitle] = React.useState("");
    ui.useUnsavedDraft(title !== "");
    return h(
      "div",
      { "data-testid": "album-settings" },
      h(ui.Section, { title: "Pictures" }, h("input", { "aria-label": "Album title", className: ui.classes.input, value: title, onChange: (e) => setTitle(e.target.value) })),
      h("div", { style: { height: 1600 } }),
      h(ui.DetailsGroup, { title: "Cover", summary: "The first picture" }, h("p", null, "The picture in front.")),
    );
  }

  portal.slots.register("nav.page", { id: "album", title: "Album", icon: Icon, component: Album });

  portal.slots.register("settings.page", {
    id: "album",
    title: "Album",
    icon: Icon,
    search: [{ title: "Album cover", section: "Cover", words: "front picture" }],
    component: AlbumSettings,
  });

  portal.slots.register("chat.tool", {
    id: "plot",
    tool: "plot_sales",
    component: ({ card }) => card,
    tile: ({ call, chat }) => h("span", { "data-testid": "album-tile" }, `${call.status} ${typeof call.since} ${chat.id}`),
    describe: (call) => ({ label: "Drawing a chart", detail: String(call.input?.title ?? "") }),
  });
}
