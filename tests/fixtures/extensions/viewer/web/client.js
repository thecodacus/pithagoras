/**
 * A stand-in for the portal's own specs: an extension with what an app like
 * the browser brings, through the hooks any extension has, so that a spec of
 * the portal's own tests the portal with it and needs none of the extensions
 * the portal ships, any of which can be removed.
 *
 *   voice.window   "Viewer" in the middle, that can be maximized and is kept loaded while minimized, with a frame of
 *                  its own in which Escape restores it; `window.viewerLoads` counts the frame's loads
 *   nav.page       "Viewer", listed while a spec says so with `window.viewerListed(true)`
 *
 * Plain JavaScript with the portal's React, as the Notes example is: nothing
 * to build.
 */
export default function (portal) {
  const { React } = portal;
  const h = React.createElement;

  const Icon = (props) => h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, ...props }, h("rect", { x: 3, y: 5, width: 18, height: 14, rx: 2 }));

  let listed = false;
  const listeners = new Set();
  window.viewerListed = (on) => {
    listed = on;
    for (const heard of listeners) heard();
  };
  const useListed = () => React.useSyncExternalStore((heard) => (listeners.add(heard), () => listeners.delete(heard)), () => listed);

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

  portal.slots.register("voice.window", { id: "viewer", title: "Viewer", icon: Icon, place: "middle", maximizable: true, keepLoaded: true, component: Viewer });

  portal.slots.register("nav.page", { id: "viewer", title: "Viewer", icon: Icon, useShown: useListed, component: () => h("p", null, "The viewer's page") });
}
