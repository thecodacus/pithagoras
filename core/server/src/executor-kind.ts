import type { ExecutorKind } from "./executors/index.js";

/**
 * Where pi runs, as the portal was started: in this process, or in a container it launches.
 * Here rather than in the session manager so that the database code can ask too, which the manager imports.
 */
export const EXECUTOR_KIND = (process.env.EXECUTOR || "host") as ExecutorKind;
