/** A row of the channels table. */
export interface ChannelRow {
  id: string;
  slug: string;
  kind: string;
  name: string;
  enabled: number;
  config: string;
  instructions: string;
  relay_progress: number;
  relay_tools: number;
  agent_id: string;
  created_at: string;
  updated_at: string;
}

/** What a channel was configured with; nothing at all when it cannot be read. */
export const parseConfig = (raw: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};
