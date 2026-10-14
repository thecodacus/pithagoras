/** A request the store refuses: its HTTP status, what to say, and what else the answer carries. */
export class DocError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
