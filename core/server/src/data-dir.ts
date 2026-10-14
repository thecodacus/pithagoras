import path from "node:path";

/**
 * Where the portal keeps its database and what belongs with it.
 *
 * A module of its own so the entry can lock it before anything that opens the
 * database is loaded.
 */
export const DATA_DIR = process.env.DATA_DIR || "./data";

/**
 * A folder of the data directory, which `variable` can put somewhere else. Its
 * default is inside DATA_DIR, where a portal started from source can write, and
 * not at a fixed `/data`, which only the image has.
 */
export const dataFolder = (variable: string, name: string): string => path.resolve(process.env[variable] || path.join(DATA_DIR, name));

/** Where third-party channel packages are installed, without making it: for comparing a path with it. */
export const channelsPath = (): string => dataFolder("CHANNELS_DIR", "channels");
