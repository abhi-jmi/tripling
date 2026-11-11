// PostgreSQL is used only by this one-time, read-only export utility.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { transaction, withDefaults } from "../server/db.js";
import { migrate } from "../server/migrate.js";
export const TRANSFER_COLLECTIONS = [
  "users",
  "trips",
  "trip_members",
  "trip_participants",
  "join_requests",
  "saved_trips",
  "messages",
  "reports",
  "hidden_trips",
  "notifications",
  "reviews",
  "legal_documents",
  "legal_acceptances",
  "user_blocks",
  "block_reason_reports",
  "oauth_identities",
];
const required = new Set([
  "users",
  "trips",
  "trip_members",
  "join_requests",
  "saved_trips",
  "messages",
  "reports",
  "hidden_trips",
  "notifications",
  "reviews",
  "legal_documents",
  "legal_acceptances",
]);
const dateFields = new Set([
  "created_at",
  "updated_at",
  "accepted_at",
  "joined_at",
  "first_joined_at",
  "last_joined_at",
  "left_at",
  "ended_at",
  "read_at",
  "expires_at",
]);
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function makeSnapshot(collections, sourceMigrations = []) {
  const payload = {
    format: "tripling-postgres-to-mongodb-v1",
    exportedAt: new Date().toISOString(),
    sourceMigrations,
    collections,
  };
  return { ...payload, checksum: hash(payload) };
}
export function verifySnapshot(snapshot) {
  const { checksum, ...payload } = snapshot;
  if (
    payload.format !== "tripling-postgres-to-mongodb-v1" ||
    checksum !== hash(payload)
  )
    throw new Error("Snapshot format/checksum is invalid.");
  for (const name of TRANSFER_COLLECTIONS)
    if (!Array.isArray(payload.collections[name]))
      throw new Error("Snapshot is missing a collection.");
  for (const name of Object.keys(payload.collections))
    if (!TRANSFER_COLLECTIONS.includes(name))
      throw new Error("Unknown snapshot collection.");
  const c = payload.collections,
    users = new Set(c.users.map((u) => u.id)),
    trips = new Set(c.trips.map((t) => t.id));
  const names = new Set(),
    ids = new Set();
  for (const u of c.users) {
    if (
      typeof u.id !== "string" ||
      ids.has(u.id) ||
      typeof u.email !== "string" ||
      u.email !== u.email.toLowerCase() ||
      names.has(u.email)
    )
      throw new Error("Snapshot contains invalid or duplicate accounts.");
    ids.add(u.id);
    names.add(u.email);
  }
  for (const [name, rows] of Object.entries(c))
    for (const row of rows) {
      for (const key of [
        "user_id",
        "owner_id",
        "organizer_id",
        "author_id",
        "traveler_id",
        "reporter_id",
        "blocker_id",
        "blocked_id",
      ])
        if (row[key] != null && !users.has(row[key]))
          throw new Error("Snapshot has an orphaned user reference.");
      for (const key of ["trip_id", "context_trip_id"])
        if (row[key] != null && !trips.has(row[key]))
          throw new Error("Snapshot has an orphaned trip reference.");
      for (const key of dateFields)
        if (row[key] != null && !Number.isFinite(new Date(row[key]).getTime()))
          throw new Error("Snapshot contains an invalid timestamp.");
    }
  const members = new Set(
    c.trip_members.map((m) => m.trip_id + ":" + m.user_id),
  );
  for (const t of c.trips) {
    if (t.organizer_id && !members.has(t.id + ":" + t.organizer_id))
      throw new Error("Trip organizer is not an active member.");
    const count = c.trip_members.filter((m) => m.trip_id === t.id).length;
    if (count + (t.existing_travelers - 1) > t.capacity)
      throw new Error("Snapshot contains an overbooked trip.");
  }
  const policies = new Set(
    c.legal_documents.map((d) => d.slug + ":" + d.version),
  );
  for (const a of c.legal_acceptances)
    if (!policies.has(a.slug + ":" + a.version))
      throw new Error("Snapshot is missing an accepted legal version.");
  return payload;
}
export async function exportPostgres(pgClient) {
  await pgClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const collections = {};
    for (const name of TRANSFER_COLLECTIONS) {
      const exists = (
        await pgClient.query("SELECT to_regclass($1) AS name", [
          `public.${name}`,
        ])
      ).rows[0].name;
      if (!exists && required.has(name))
        throw new Error("Source is missing a required application table.");
      collections[name] = exists
        ? (await pgClient.query(`SELECT * FROM public."${name}"`)).rows
        : [];
    }
    // Pre-feature production databases have no organizer/participant columns yet.
    const members = new Set(
      collections.trip_members.map((m) => m.trip_id + ":" + m.user_id),
    );
    for (const t of collections.trips)
      if (!Object.hasOwn(t, "organizer_id"))
        t.organizer_id = members.has(t.id + ":" + t.owner_id)
          ? t.owner_id
          : null;
    for (const m of collections.trip_members)
      if (
        !collections.trip_participants.some(
          (p) => p.trip_id === m.trip_id && p.user_id === m.user_id,
        )
      )
        collections.trip_participants.push({
          trip_id: m.trip_id,
          user_id: m.user_id,
          first_joined_at: m.joined_at,
          last_joined_at: m.joined_at,
          left_at: null,
        });
    const sourceMigrations = (
      await pgClient.query(
        "SELECT name,checksum,applied_at FROM schema_migrations ORDER BY name",
      )
    ).rows;
    const snapshot = makeSnapshot(collections, sourceMigrations);
    verifySnapshot(snapshot);
    await pgClient.query("COMMIT");
    return snapshot;
  } catch (e) {
    await pgClient.query("ROLLBACK");
    throw e;
  }
}
function mongoDocument(name, row) {
  const data = { ...row };
  for (const key of dateFields)
    if (data[key] != null) data[key] = new Date(data[key]);
  if (name === "messages" || name === "notifications")
    data.id = String(data.id);
  // Stable IDs for relational composite keys make verification deterministic.
  const key =
    name === "legal_documents"
      ? `${data.slug}:${data.version}`
      : name === "legal_acceptances"
        ? `${data.user_id}:${data.slug}:${data.version}`
        : [
              "trip_members",
              "trip_participants",
              "join_requests",
              "saved_trips",
              "hidden_trips",
            ].includes(name)
          ? `${data.trip_id}:${data.user_id}`
          : name === "oauth_identities"
            ? `${data.provider}:${data.subject}`
            : data.id;
  return withDefaults(name, { ...data, _id: key ?? data.id });
}
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .filter((k) => k !== "_id")
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export async function verifyImported(
  db,
  snapshot,
  { allowNewPolicies = false } = {},
) {
  verifySnapshot(snapshot);
  for (const name of TRANSFER_COLLECTIONS) {
    const rows = await db.all(name);
    if (
      rows.length !== snapshot.collections[name].length &&
      !(
        allowNewPolicies &&
        name === "legal_documents" &&
        rows.length >= snapshot.collections[name].length
      )
    )
      throw new Error("Imported collection count does not match snapshot.");
    for (const source of snapshot.collections[name]) {
      const expected = mongoDocument(name, source),
        actual = rows.find((r) =>
          expected.id && source.id
            ? r.id === expected.id
            : name === "legal_documents"
              ? r.slug === source.slug && r.version === source.version
              : name === "legal_acceptances"
                ? r.user_id === source.user_id &&
                  r.slug === source.slug &&
                  r.version === source.version
                : name === "oauth_identities"
                  ? r.provider === source.provider &&
                    r.subject === source.subject
                  : r.trip_id === source.trip_id &&
                    r.user_id === source.user_id,
        );
      if (!actual) throw new Error("Imported record is missing.");
      // Verify every source field, including hashes, IDs, dates, consent and content.
      for (const key of Object.keys(source)) {
        const expectedValue = expected[key];
        if (
          JSON.stringify(canonical(actual[key])) !==
          JSON.stringify(canonical(expectedValue))
        )
          throw new Error("Imported record differs from snapshot.");
      }
    }
  }
  return true;
}
export async function importSnapshot(db, snapshot) {
  verifySnapshot(snapshot);
  await migrate(db);
  const prior = await db.one("data_transfers", { checksum: snapshot.checksum });
  if (prior?.status === "verified") {
    await verifyImported(db, snapshot);
    return { alreadyImported: true };
  }
  for (const name of TRANSFER_COLLECTIONS)
    if (await db.count(name))
      throw new Error(
        "Destination must be empty; existing application data will never be overwritten.",
      );
  await transaction(db, async (target) => {
    // One atomic import, including the transfer marker. A failed/oversized import rolls back.
    await target.insert("data_transfers", {
      _id: "postgres-cutover",
      checksum: snapshot.checksum,
      status: "importing",
      sourceMigrations: snapshot.sourceMigrations,
      exportedAt: snapshot.exportedAt,
    });
    for (const name of TRANSFER_COLLECTIONS)
      for (const row of snapshot.collections[name])
        await target.database
          .collection(name)
          .insertOne(mongoDocument(name, row), target.opts());
    await verifyImported(target, snapshot);
    await target.update(
      "data_transfers",
      { _id: "postgres-cutover" },
      { $set: { status: "verified", verifiedAt: new Date() } },
    );
  });
  return { alreadyImported: false };
}
export async function writeSnapshot(path, snapshot) {
  await writeFile(path, JSON.stringify(snapshot), { mode: 0o600, flag: "wx" });
}
export async function readSnapshot(path) {
  const snapshot = JSON.parse(await readFile(path, "utf8"));
  verifySnapshot(snapshot);
  return snapshot;
}
