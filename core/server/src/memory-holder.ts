import type { MemoryHolder } from "@pithagoras/extension-api/server";

/**
 * What holds the agent's memory in place of MEMORY.md, where something does
 * (`portal.memory.hold`).
 *
 * While it holds it, a chat with the person does not read MEMORY.md and is told
 * the holder's rule in its place (sdk-client.ts), a project linked to an agent
 * can do without it (memoryHeldAt in project-agent.ts), and the agent's setup
 * says which holds it (agent-setup.ts). There is one: the first to ask has it,
 * and one that asks while another does is refused, with a line in the log.
 */

export type { MemoryHolder };

let holding: { owner: string; holder: MemoryHolder } | undefined;

/** `owner` holds the agent's memory, unless another does already. Returns what lets it go. */
export function holdMemory(owner: string, holder: MemoryHolder): () => void {
  if (holding) {
    console.log(`[portal] ${owner} cannot hold the agent's memory: ${holding.owner} holds it already, as ${holding.holder.label}`);
    return () => {};
  }
  const mine = { owner, holder };
  holding = mine;
  return () => {
    if (holding === mine) holding = undefined;
  };
}

/** The holder, while it holds the memory now: asked each time a chat's prompt is built. */
export function memoryHolder(): MemoryHolder | undefined {
  return holding?.holder.on() ? holding.holder : undefined;
}
