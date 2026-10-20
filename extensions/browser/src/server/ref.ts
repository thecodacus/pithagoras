/**
 * Playwright's own ref shape: frame then element, `f1e17`, or bare `e17`.
 * Distinctive enough to tell a ref from an attribute selector — nobody writes
 * `[e17]` meaning an element with an `e17` attribute.
 */
export const REF_TOKEN = /^(?:f\d+)?e\d+$/;

/**
 * A snapshot prints refs as `[ref=f1e17]`, and pasting that in whole is the
 * obvious thing to do. Playwright reads a bracketed value as a CSS attribute
 * selector, matches nothing, and reports it as "does not match any elements" —
 * which reads like the ref expired, so the next move is to take another
 * snapshot and get the same result. Agents have burned whole sessions on it.
 *
 * Peel off the decoration and keep it only if a ref is what is underneath.
 * Shape-based rather than a list of known mistakes: the first version matched
 * `[ref=x]` exactly, the model moved to `[x]` the next day, and the same error
 * came back. Anything that does not reduce to a ref is returned exactly as it
 * arrived, so real selectors — `[disabled]`, `a[href="..."]`, `#id` — are
 * never touched.
 *
 * One reading for both the portal's own browser tools and the guard, which
 * normalises the arguments of a Playwright MCP's: two of them had drifted apart.
 */
export function bareRef(value: string): string {
  const stripped = value
    .trim()
    .replace(/^\[|\]$/g, "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim()
    .replace(/^(?:aria-)?ref\s*=\s*/i, "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
  return REF_TOKEN.test(stripped) ? stripped : value;
}
