/**
 * A stand-in for the portal's own specs: an extension that draws the agent in
 * voice mode where the orb is (`voice.avatar`), so that a spec of the portal's
 * own tests that with it and needs none an app would bring, which can be
 * removed.
 *
 *   puppet    "Puppet": a square on a canvas of its own that grows with the levels, read in a frame of its own. Its
 *             box says what it is given (`data-mode`, `data-still`, `data-agent`) and what it read last
 *             (`data-input`, `data-output`, to two places). `window.puppetMounts` counts the times it is mounted,
 *             `window.puppetRenders` the times it is drawn, and `window.puppetModes` lists the modes it was given,
 *             each once in a row
 *   waiting   "Waiting": draws the portal's orb and nothing else, as an avatar still loading would
 *   broken    "Broken": throws as it is drawn
 *   later     "Later": the puppet, drawn once a chunk of its own (later.js, which holds nothing) is fetched, as an
 *             avatar too heavy for the extension's first file is
 *
 * German for its texts, through `portal.locale`. Plain JavaScript with the
 * portal's React, as the Notes example is: nothing to build.
 */
export default function (portal) {
  const { React } = portal;
  const h = React.createElement;

  window.puppetMounts = 0;
  window.puppetRenders = 0;
  window.puppetModes = [];

  function Puppet({ agent, mode, levels, still }) {
    window.puppetRenders++;
    const box = React.useRef(null);
    const canvas = React.useRef(null);
    React.useEffect(() => {
      window.puppetMounts++;
    }, []);
    React.useEffect(() => {
      if (window.puppetModes.at(-1) !== mode) window.puppetModes.push(mode);
    }, [mode]);
    React.useEffect(() => {
      const el = canvas.current;
      const ctx = el.getContext("2d");
      let frame = 0;
      const draw = () => {
        // Read through `levels` each time: the object in it is replaced.
        const { input, output } = levels.current;
        box.current.dataset.input = input.toFixed(2);
        box.current.dataset.output = output.toFixed(2);
        const size = el.clientWidth;
        if (size && el.width !== size) el.width = el.height = size;
        ctx.clearRect(0, 0, el.width, el.height);
        const side = el.width * (0.3 + 0.7 * Math.max(input, output));
        ctx.fillStyle = "#c9a2ff";
        ctx.fillRect((el.width - side) / 2, (el.height - side) / 2, side, side);
        // A picture is drawn once.
        if (!still) frame = requestAnimationFrame(draw);
      };
      draw();
      return () => cancelAnimationFrame(frame);
    }, [levels, still]);
    return h(
      "div",
      { ref: box, "data-testid": "puppet", "data-mode": mode, "data-still": String(still), "data-agent": agent.id, style: { position: "absolute", inset: 0 } },
      h("canvas", { ref: canvas, style: { width: "100%", height: "100%" } }),
    );
  }

  portal.slots.register("voice.avatar", { id: "puppet", title: "Puppet", description: "A square that follows the voice", component: Puppet });
  portal.slots.register("voice.avatar", { id: "waiting", title: "Waiting", component: ({ orb }) => orb });
  portal.slots.register("voice.avatar", {
    id: "broken",
    title: "Broken",
    component: () => {
      throw new Error("The puppet's strings are cut");
    },
  });
  portal.slots.register("voice.avatar", { id: "later", title: "Later", component: portal.ui.lazy(() => import("./later.js").then(() => ({ Later: Puppet })), "Later") });

  portal.locale.add("de", { Puppet: "Puppe", "A square that follows the voice": "Ein Quadrat, das der Stimme folgt", Waiting: "Wartet", Broken: "Kaputt", Later: "Später" });
}
