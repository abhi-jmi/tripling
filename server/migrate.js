import { readFile } from "node:fs/promises";
export const COLLECTIONS = [
  "users",
  "sessions",
  "auth_rate_limits",
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
  "location_catalog",
  "place_coordinates",
  "oauth_identities",
  "oauth_flows",
  "oauth_pending",
  "data_transfers",
];
const indexes = {
  users: [
    [{ id: 1 }, { unique: true }],
    [{ email: 1 }, { unique: true }],
    [{ display_name: 1 }, {}],
  ],
  sessions: [
    [{ token_hash: 1 }, { unique: true }],
    [{ expires_at: 1 }, { expireAfterSeconds: 0 }],
    [{ user_id: 1 }, {}],
  ],
  auth_rate_limits: [
    [{ bucket_key: 1, window_start: 1 }, { unique: true }],
    [{ expires_at: 1 }, { expireAfterSeconds: 0 }],
  ],
  trips: [
    [{ id: 1 }, { unique: true }],
    [{ status: 1, starts_on: 1 }, {}],
    [{ organizer_id: 1 }, {}],
  ],
  trip_members: [
    [{ trip_id: 1, user_id: 1 }, { unique: true }],
    [{ user_id: 1 }, {}],
  ],
  trip_participants: [
    [{ trip_id: 1, user_id: 1 }, { unique: true }],
    [{ user_id: 1 }, {}],
  ],
  join_requests: [
    [{ trip_id: 1, user_id: 1 }, { unique: true }],
    [{ trip_id: 1, status: 1 }, {}],
  ],
  saved_trips: [[{ user_id: 1, trip_id: 1 }, { unique: true }]],
  hidden_trips: [[{ user_id: 1, trip_id: 1 }, { unique: true }]],
  messages: [
    [{ id: 1 }, { unique: true }],
    [{ trip_id: 1, created_at: -1, id: -1 }, {}],
  ],
  notifications: [[{ user_id: 1, created_at: -1 }, {}]],
  reviews: [[{ trip_id: 1, author_id: 1, traveler_id: 1 }, { unique: true }]],
  legal_documents: [
    [{ slug: 1, version: 1 }, { unique: true }],
    [{ slug: 1, published: -1, created_at: -1 }, {}],
  ],
  legal_acceptances: [[{ user_id: 1, slug: 1, version: 1 }, { unique: true }]],
  user_blocks: [
    [
      { blocker_id: 1, blocked_id: 1 },
      { unique: true, partialFilterExpression: { ended_at: null } },
    ],
    [{ context_trip_id: 1 }, {}],
  ],
  place_coordinates: [
    [{ key: 1 }, { unique: true }],
    [{ expires_at: 1 }, { expireAfterSeconds: 0 }],
  ],
  location_catalog: [[{ name: 1 }, { unique: true }]],
  oauth_identities: [
    [{ provider: 1, subject: 1 }, { unique: true }],
    [{ provider: 1, user_id: 1 }, { unique: true }],
  ],
  oauth_flows: [
    [{ state_hash: 1 }, { unique: true }],
    [{ expires_at: 1 }, { expireAfterSeconds: 0 }],
  ],
  oauth_pending: [
    [{ token_hash: 1 }, { unique: true }],
    [{ expires_at: 1 }, { expireAfterSeconds: 0 }],
  ],
};
export async function migrate(db) {
  // Idempotent, named indexes; do not drop or recreate application collections.
  for (const name of COLLECTIONS) {
    try {
      await db.database.createCollection(name);
    } catch (e) {
      if (e.code !== 48) throw e;
    }
    for (const [key, options] of indexes[name] || [])
      await db.database.collection(name).createIndex(key, options);
  }
  const locations = JSON.parse(
    await readFile(new URL("./locations.json", import.meta.url), "utf8"),
  );
  for (const name of locations)
    await db.update(
      "location_catalog",
      { name },
      { $setOnInsert: { name } },
      { upsert: true },
    );
  await db.removeMany("sessions", { expires_at: { $lte: new Date() } });
  await db.removeMany("oauth_flows", { expires_at: { $lte: new Date() } });
  await db.removeMany("oauth_pending", { expires_at: { $lte: new Date() } });
}
