/**
 * Small helpers the portal has for itself and the Memory page needs as well:
 * an extension draws on the portal's interface, not on its code.
 */

/** Whether the system asks for less motion. */
export const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** "800", "6k", "20.5k": a count of tokens. */
export const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : String(n));

/** A React event carries it on `nativeEvent`, a DOM one on itself. */
type KeyEvent = { key: string; keyCode?: number; nativeEvent?: { isComposing?: boolean }; isComposing?: boolean };

/** An input method has the key: composing, or Safari's keydown just after it ended (keyCode 229). */
const isComposing = (e: KeyEvent): boolean => Boolean(e.nativeEvent?.isComposing ?? e.isComposing) || e.keyCode === 229;

/** Escape that means "never mind", not Escape that dismisses an input method's candidates. */
export const isEscape = (e: KeyEvent): boolean => e.key === "Escape" && !isComposing(e);
