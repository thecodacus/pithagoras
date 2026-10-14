/**
 * What a request's `Range` header asks for of a file of a known size (RFC 9110, section 14), for the files a
 * player seeks in: a clip is much too large to be sent whole every time the person drags the slider.
 *
 * Only a single range of bytes is served. A header that is not a byte range, or names several, or is not
 * well formed, is no range: the whole file is sent, which a client is always allowed to be answered with.
 */
export type ByteRange = { kind: "all" } | { kind: "range"; start: number; end: number } | { kind: "unsatisfiable" };

/** The bytes from `start` to `end`, both included, that `header` asks for, or why none can be sent. */
export function parseRange(header: string | undefined, size: number): ByteRange {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
  if (!match) return { kind: "all" };
  const [, first, last] = match;
  if (first === "" && last === "") return { kind: "all" };
  if (first === "") {
    // The last `n` bytes.
    const n = Number(last);
    if (!Number.isSafeInteger(n) || n === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "range", start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(first);
  if (!Number.isSafeInteger(start) || start >= size) return { kind: "unsatisfiable" };
  if (last === "") return { kind: "range", start, end: size - 1 };
  const end = Number(last);
  // A last byte before the first is a header that makes no sense: no range.
  if (!Number.isSafeInteger(end) || end < start) return { kind: "all" };
  return { kind: "range", start, end: Math.min(end, size - 1) };
}
