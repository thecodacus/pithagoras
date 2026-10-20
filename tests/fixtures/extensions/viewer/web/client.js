/**
 * A stand-in for the portal's own specs: an extension with what an app like
 * the browser brings, through the hooks any extension has, so that a spec of
 * the portal's own tests the portal with it and needs none of the extensions
 * the portal ships, any of which can be removed.
 *
 *   chat.panel     "Viewer", the second of two beside the conversation, with the console's: black from edge to edge
 *                  (`bleed`), filled by a frame of its own (named "viewer-pane") that takes no pointer, so that a press
 *                  on it is the panel's, with a Fullscreen of its own in its head; `window.viewerPanel` is its handle,
 *                  once drawn
 *   voice.window   "Viewer" in the middle, that can be maximized and is kept loaded while minimized, with a frame of
 *                  its own in which Escape restores it; `window.viewerLoads` counts the frame's loads. Its button in
 *                  the toolbar is as a spec says with `window.viewerButton({ hidden, live, title })`, and
 *                  `window.viewerButtonMounts` counts the times the hook that says so is mounted
 *   nav.page       "Viewer", listed while a spec says so with `window.viewerListed(true)`
 *
 * Plain JavaScript with the portal's React, as the Notes example is: nothing
 * to build.
 */
export default function (portal) {
  const { React } = portal;
  const h = React.createElement;

  const Icon = (props) => h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, ...props }, h("rect", { x: 3, y: 5, width: 18, height: 14, rx: 2 }));

  /** Something a spec says from outside, and a hook that draws again when it does. */
  const told = (first) => {
    let value = first;
    const listeners = new Set();
    return {
      set: (next) => {
        value = next;
        for (const heard of listeners) heard();
      },
      use: () => React.useSyncExternalStore((heard) => (listeners.add(heard), () => listeners.delete(heard)), () => value),
    };
  };
  const listed = told(false);
  window.viewerListed = listed.set;
  const button = told({});
  window.viewerButton = button.set;
  window.viewerButtonMounts = 0;
  const useButton = () => {
    React.useEffect(() => {
      window.viewerButtonMounts++;
    }, []);
    return button.use();
  };

  window.viewerLoads = 0;

  function Viewer({ maximized, restore }) {
    const latest = React.useRef({ maximized, restore });
    latest.current = { maximized, restore };
    // Escape in the frame is the frame's and never reaches the stage: heard there, it restores the window as the stage's does.
    const hear = (frame) => {
      window.viewerLoads++;
      frame.contentWindow.addEventListener(
        "keydown",
        (e) => {
          if (e.code !== "Escape" || !latest.current.maximized) return;
          e.preventDefault();
          latest.current.restore();
        },
        true,
      );
    };
    return h("iframe", {
      title: "What the viewer shows",
      srcDoc: "<body style='margin:0;padding:24px;font:14px sans-serif'>In view.</body>",
      onLoad: (e) => hear(e.currentTarget),
      style: { border: 0, width: "100%", height: "100%", background: "#fff" },
    });
  }

  portal.slots.register("chat.panel", {
    id: "viewer",
    title: "Viewer",
    icon: Icon,
    bleed: true,
    component: function Pane({ panel }) {
      React.useEffect(() => {
        window.viewerPanel = panel;
      }, [panel]);
      return h(
        "div",
        { className: "viewer-pane", style: { flex: 1, minHeight: 0, display: "flex" } },
        h("iframe", {
          name: "viewer-pane",
          title: "What the viewer's panel shows",
          srcDoc: "<body style='height:3000px;margin:0;padding:12px;background:#171a20;color:#d1d8e3;font:14px sans-serif'>In view.</body>",
          style: { flex: 1, border: 0, pointerEvents: "none" },
        }),
      );
    },
    actions: ({ panel }) => h("button", { type: "button", onClick: () => panel.fullscreen(), className: "rounded px-1.5 py-0.5 text-[11px]" }, "Fullscreen"),
    useButton: () => ({ title: "What the viewer shows" }),
  });

  portal.slots.register("voice.window", { id: "viewer", title: "Viewer", icon: Icon, place: "middle", maximizable: true, keepLoaded: true, useButton, component: Viewer });

  portal.slots.register("nav.page", { id: "viewer", title: "Viewer", icon: Icon, useShown: listed.use, component: () => h("p", null, "The viewer's page") });
}
