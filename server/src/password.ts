import crypto from "node:crypto";

/**
 * The portal's password as it is kept: hashed, in the portal's own settings.
 *
 * Nothing here touches the database or the environment, so that the command that
 * removes a lost password can use the names without starting a login.
 */

/** The hash of the password; absent while no password has been chosen. */
export const PASSWORD_KEY = "portal_password";
/** Set once the portal has held a password of its own: after that, `PORTAL_PASSWORD` is never read as one again. */
export const PASSWORD_HELD_KEY = "portal_password_held";
/** Set while the password is one that was moved in from `PORTAL_PASSWORD` and is shorter than the minimum. */
export const PASSWORD_SHORT_KEY = "portal_password_short";

export const MIN_PASSWORD_LENGTH = 8;
/** The example in the old .env.example and the README, which is public: nobody's password. */
export const EXAMPLE_PASSWORD = "change-me";

/**
 * 64 MiB and about 0.3 s a login: N=2^16, r=8, p=2 is one of OWASP's equivalent settings for scrypt (the first
 * on its list, N=2^17 with p=1, takes twice the memory). The memory is what holds off offline guessing on a copied
 * database. 64 MiB is small enough for a portal in a container with a limit: the thread pool does four at a time,
 * so a flood of logins holds 256 MiB at most, and the throttle in front of the login lets ten through per source.
 * Node's default, which this was, is a quarter of the memory.
 */
const COST = { N: 65536, r: 8, p: 2 };
const KEY_BYTES = 32;
/** What a stored cost may ask of this machine: a damaged row does not get to allocate gigabytes. */
const MAX_MEMORY = 128 * 1024 * 1024;

type Cost = { N: number; r: number; p: number };

const derive = (password: string, salt: Buffer, length: number, cost: Cost): Promise<Buffer> =>
  // Node's own limit is 32 MiB, under what the cost above needs.
  new Promise((resolve, reject) => crypto.scrypt(password, salt, length, { ...cost, maxmem: 2 * MAX_MEMORY }, (e, key) => (e ? reject(e) : resolve(key))));

/**
 * `scrypt:N:r:p:salt:hash`, the cost in the string, so that it can be raised
 * later without a password having to be asked for again. Derived off the main
 * thread: a login must not hold up everyone else's requests while it is checked.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await derive(password, salt, KEY_BYTES, COST);
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("hex"), key.toString("hex")].join(":");
}

/** Whether `password` is the one `stored` is the hash of. Also reads `salt:hash`, which is how earlier portals remembered theirs. */
export async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  let cost: Cost = { N: 16384, r: 8, p: 1 };
  let salt: string | undefined;
  let hash: string | undefined;
  if (parts.length === 2) [salt, hash] = parts;
  else if (parts.length === 6 && parts[0] === "scrypt") {
    cost = { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) };
    [salt, hash] = parts.slice(4);
  }
  if (!salt || !hash || 128 * cost.N * cost.r > MAX_MEMORY) return false;
  const expected = Buffer.from(hash, "hex");
  if (expected.length === 0) return false;
  try {
    return crypto.timingSafeEqual(await derive(password, Buffer.from(salt, "hex"), expected.length, cost), expected);
  } catch {
    // A cost the hash names that this machine cannot work out is not a match.
    return false;
  }
}

/** Why `password` cannot be the portal's password, in a sentence for the person who chose it; null where it can. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `The password has to be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password === EXAMPLE_PASSWORD) return "That is the example password, which everybody knows. Choose another.";
  return null;
}
