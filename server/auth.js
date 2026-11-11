import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
// Bound memory use from scrypt under concurrent sign-in attempts.
let running = 0;
const waiters = [];
async function derive(password, salt) {
  if (running >= 4) {
    if (waiters.length >= 16)
      throw Object.assign(
        new Error("Login is busy. Please try again shortly."),
        { status: 503 },
      );
    await new Promise((resolve) => waiters.push(resolve));
  } else running++;
  try {
    return await scrypt(password, salt, 64, options);
  } finally {
    const next = waiters.shift();
    if (next) next();
    else running--;
  }
}
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = await derive(password, salt);
  return `scrypt-v1$${salt}$${hash.toString("hex")}`;
}
export async function verifyPassword(password, encoded) {
  const [version, salt, expected] = encoded.split("$");
  if (
    version !== "scrypt-v1" ||
    !/^[a-f0-9]{32}$/.test(salt) ||
    !/^[a-f0-9]{128}$/.test(expected)
  )
    return false;
  const hash = await derive(password, salt);
  return timingSafeEqual(hash, Buffer.from(expected, "hex"));
}
export const dummyHash = await hashPassword(randomBytes(32).toString("hex"));
export const cookieName =
  process.env.NODE_ENV === "production"
    ? "__Host-tripling"
    : "tripling_session";
export function sessionToken(req) {
  const part = (req.headers.cookie || "")
    .split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${cookieName}=`));
  const token = part?.slice(cookieName.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export function cookieOptions(production) {
  return {
    httpOnly: true,
    secure: production,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 86400000,
  };
}
export async function issueSession(db, req, res, userId, production) {
  const previous = sessionToken(req);
  if (previous) await db.remove("sessions", { token_hash: digest(previous) });
  const token = randomBytes(32).toString("hex");
  await db.insert("sessions", {
    token_hash: digest(token),
    user_id: userId,
    expires_at: new Date(Date.now() + 7 * 86400000),
  });
  res.cookie(cookieName, token, cookieOptions(production));
}
export function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.display_name,
    firstName: row.first_name || "",
    lastName: row.last_name || "",
    profileComplete: !!row.first_name?.trim() && !!row.last_name?.trim(),
    googleLinked: !!row.google_linked,
    city: row.city,
    gender: row.gender,
    bio: row.bio,
    age: row.adult_confirmed,
  };
}
