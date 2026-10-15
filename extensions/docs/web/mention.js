/**
 * Does a comment ask the agent: `@agent` as a name of its own, not part of a
 * longer one (`@agents`, `@agent-x`), not the end of an address
 * (`me@agent.example`) and not in code (`@agent` after a backtick). The page
 * and the server half both ask, so that they agree on what a mention is.
 */
const MENTION = /(?<![\w@`/.])@agent(?![\w@-]|\.\w)/i;
export const asksAgent = (text) => typeof text === "string" && MENTION.test(text);
