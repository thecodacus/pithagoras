import { useState } from "react";
import type { Portal } from "@pithagoras/extension-api";
import "./client.css";

/** A panel whose state is React's own hooks, styled by its own stylesheet, with a part it loads only when asked for. */
export default function (portal: Portal) {
  function Counter() {
    const [count, setCount] = useState(0);
    const [later, setLater] = useState<string | null>(null);
    return (
      <div className="bundled-sample">
        <button type="button" onClick={() => setCount(count + 1)}>
          Count {count}
        </button>
        <button type="button" onClick={() => void import("./later").then((part) => setLater(part.said()))}>
          Load the rest
        </button>
        {later && <p>{later}</p>}
      </div>
    );
  }
  portal.slots.register("chat.panel", { id: "sample", title: "Bundled", component: Counter });
}
