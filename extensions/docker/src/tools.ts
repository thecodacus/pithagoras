import type { AgentDocker } from "./agent";

/**
 * The agent's Docker tools, in each chat (agent.ts does the work). Off until somebody switches them on (`offByDefault`):
 * they run containers on the portal's machine.
 */

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const NAME = { type: "string", description: "A container's name, or a project's for all of its containers, as docker_list gives them." };

export function registerTools(pi: any, docker: () => AgentDocker): void {
  const add = (name: string, description: string, parameters: object, execute: (p: any, signal?: AbortSignal) => Promise<unknown>) =>
    pi.registerTool({
      name,
      label: name.replace("_", " "),
      description,
      parameters,
      offByDefault: true,
      execute: async (_id: string, p: any, signal?: AbortSignal) => {
        const result = await execute(p, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });

  add(
    "docker_run",
    "Build and start containers from a Dockerfile or a compose file in this chat's folder. `file` is its path in the folder; a .yml or .yaml file is a compose file, any other a Dockerfile. " +
      "Images are pulled and built as needed and the containers run in the background; running the same file again brings them up to date. " +
      "A Dockerfile's container may be given `ports` (\"8080:80\", the machine's port first) and `environment`; a compose file says its own. " +
      "Folders mounted into a container must be in this chat's folder. Refused: privileged containers, added capabilities, the machine's devices, and sharing the machine's network, processes or IPC. " +
      "Where you run as a user of your own (the sandbox), every container and the build run as you too, whatever the file says: an image that needs root inside its container does not work then.",
    object(
      {
        file: { type: "string", description: "The Dockerfile or compose file, as a path in this chat's folder." },
        ports: { type: "array", items: { type: "string" }, description: "For a Dockerfile: ports to publish, as \"8080:80\"." },
        environment: { type: "object", additionalProperties: { type: "string" }, description: "For a Dockerfile: the container's environment." },
      },
      ["file"],
    ),
    (p, signal) => docker().run(p.file, { ports: p.ports, environment: p.environment }, signal),
  );
  add("docker_list", "List the containers this chat's folder runs (from docker_run): name, project, service, image, state and published ports.", object({}), async () => ({ containers: await docker().list() }));
  add("docker_start", "Start a stopped container, or every container of a project.", object({ name: NAME }, ["name"]), (p) => docker().start(p.name));
  add("docker_stop", "Stop a container, or every container of a project.", object({ name: NAME }, ["name"]), (p) => docker().stop(p.name));
  add(
    "docker_delete",
    "Delete a container, or every container of a project. Once a project has no container left, its networks and the images built for it go too, and its volumes when `volumes` is true (what they hold is lost).",
    object({ name: NAME, volumes: { type: "boolean", description: "Delete the project's volumes too, once it has no container left." } }, ["name"]),
    (p) => docker().remove(p.name, p.volumes === true),
  );
  add(
    "docker_logs",
    "Read the end of what a container wrote, or what each container of a project wrote.",
    object({ name: NAME, tail: { type: "integer", description: "How many lines from the end: 200 unless said, at most 5000." } }, ["name"]),
    (p) => docker().logs(p.name, p.tail),
  );
}
