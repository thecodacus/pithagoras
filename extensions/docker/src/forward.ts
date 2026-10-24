import { createHash } from "node:crypto";

/**
 * The forwarder: the way onto a network of an extension's that has no way out (`networks.reach`) for a portal in the
 * machine's network namespace, on the machine itself or in a container with the network mode `host`, to which Docker
 * adds no network. One for each container it leads to: the container `<container>-forward`, and a network of its own
 * by the same name. It is on both. Its own is not internal, as Docker publishes no port of a container that is only on
 * internal networks, and nothing else is on it, so that no other container (the agent's, on Docker's default bridge)
 * reaches its port; on the extension's, it passes each connection on to the container, by its name. Its port is
 * published on the machine's 127.0.0.1 alone. It is made, as any container of the extension's is, with the extension's
 * name on it, and shown under that extension in Settings → Docker.
 */

/**
 * Pinned by its tag, as the compose runner's image is: the program below is run by this Node, which is the portal's own
 * language, so that the tests run the very program with their own. Downloaded the first time a forwarder is made.
 */
export const FORWARDER_IMAGE = "node:22.23.4-alpine3.23";

/** The label a forwarder and its own network carry: the network of the extension's it leads onto. */
export const FORWARDS_LABEL = "pithagoras.forwards";
/** The label that says what a forwarder was made with: the mark `forwarderSpec` gives. */
export const FORWARD_SPEC_LABEL = "pithagoras.forward-spec";

/** The forwarder's name for `container`, which its own network has too. */
export const forwarderName = (container: string) => `${container}-forward`;

/**
 * The forwarder's program. It listens on FORWARD_PORT, and passes each connection on to FORWARD_TO_HOST:FORWARD_TO_PORT,
 * which is looked up anew for each, by its name on the network: a container that came back at another address is
 * reached. A side that ends its writing is passed on as such (half-closed), and a side that closes, or fails, closes
 * the other. No delay on small writes: a WebSocket's frames are small. It ends at Docker's stop (SIGTERM), which Node
 * as a container's first process does not do by itself: Docker would wait its ten seconds, then kill it, each time the
 * forwarder is made again or removed. The create body gives the same port to both; they are two so that a test can run
 * it beside its target on one loopback.
 */
export const FORWARD_SCRIPT = `const net = require("node:net");
const to = { host: process.env.FORWARD_TO_HOST, port: Number(process.env.FORWARD_TO_PORT), allowHalfOpen: true };
net.createServer({ allowHalfOpen: true }, (from) => {
  const on = net.connect(to);
  for (const s of [from, on]) s.setNoDelay(true);
  const close = () => { from.destroy(); on.destroy(); };
  for (const s of [from, on]) { s.on("error", close); s.on("close", close); }
  from.pipe(on).pipe(from);
}).listen(Number(process.env.FORWARD_PORT), "0.0.0.0");
process.on("SIGTERM", () => process.exit(0));
`;

type Network = { Id: string; Name: string };

/**
 * What the forwarder to `port` of `container` is made with: Docker's create body, on its own network (`door`) and the
 * extension's (`island`) from the start, unprivileged, with its root read-only, and started again by Docker after the
 * machine restarts. Its labels carry the network it leads onto and its mark: the first 16 hex of the SHA-256 of the body
 * without its labels, with the two networks' ids. A forwarder whose mark is not this one (another port, another image
 * or program, a network made again) is not as it would be made now.
 */
export function forwarderSpec(container: string, port: number, island: Network, door: Network) {
  const body = {
    Image: FORWARDER_IMAGE,
    // The image's own `node`.
    User: "1000:1000",
    Cmd: ["node", "-e", FORWARD_SCRIPT],
    Env: [`FORWARD_PORT=${port}`, `FORWARD_TO_HOST=${container}`, `FORWARD_TO_PORT=${port}`],
    ExposedPorts: { [`${port}/tcp`]: {} },
    HostConfig: {
      NetworkMode: door.Name,
      PortBindings: { [`${port}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(port) }] },
      RestartPolicy: { Name: "unless-stopped" },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: true,
      Memory: 128 * 1024 ** 2,
      PidsLimit: 64,
      LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } },
    },
    NetworkingConfig: { EndpointsConfig: { [door.Name]: {}, [island.Name]: {} } },
  };
  const mark = createHash("sha256").update(JSON.stringify({ body, island: island.Id, door: door.Id })).digest("hex").slice(0, 16);
  return { ...body, Labels: { [FORWARDS_LABEL]: island.Name, [FORWARD_SPEC_LABEL]: mark } };
}
