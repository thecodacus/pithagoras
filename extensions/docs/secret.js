/**
 * Shapes that secrets have: a private key, and the tokens of the services most
 * often pasted. A save that holds one is warned about, and the agent is not
 * let to write one; history keeps what is saved, so it is better not saved at all.
 */
export const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abpors]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/;
export const SECRET_WARNING = "This document looks like it holds a secret (a private key or a token). Its history keeps every revision: take it out, and see the guide on how to remove it from the history.";

const EVERYWHERE = new RegExp(SECRET.source, "g");
/** What in `text` has the shape of a secret, each as it is written. */
export const secretsIn = (text) => text.match(EVERYWHERE) ?? [];
