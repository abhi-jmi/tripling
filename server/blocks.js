import { z } from "zod";
import { transaction, lockTravelers } from "./db.js";
import { httpError, requireParticipant, prefix } from "./travel-rules.js";
const uuid = z.uuid();
const fail = (s, m) => {
  throw httpError(s, m);
};
export async function tripNotices(db, tripIds, target = null) {
  const filter = {
    ended_at: null,
    context_trip_id: { $in: tripIds },
    ...(target
      ? { $or: [{ blocker_id: target }, { blocked_id: target }] }
      : {}),
  };
  const records = await db.all("user_blocks", filter, {
      sort: { created_at: -1 },
    }),
    ids = records.flatMap((b) => [b.blocker_id, b.blocked_id]);
  const users = new Map(
    (
      await db.all(
        "users",
        { id: { $in: ids } },
        { projection: { _id: 0, id: 1, display_name: 1 } },
      )
    ).map((u) => [u.id, u.display_name]),
  );
  const trips = new Map(
    (
      await db.all(
        "trips",
        { id: { $in: tripIds } },
        { projection: { _id: 0, id: 1, title: 1 } },
      )
    ).map((t) => [t.id, t.title]),
  );
  return records.map((b) => ({
    id: b.id,
    context_trip_id: b.context_trip_id,
    category: b.category,
    reason: b.reason,
    created_at: b.created_at,
    blocker: users.get(b.blocker_id),
    blocked: users.get(b.blocked_id),
    title: trips.get(b.context_trip_id),
  }));
}
export function registerBlockRoutes(app, pool, { requireUser, throttle }) {
  app.get("/api/travelers", requireUser, async (req, res) => {
    await throttle(req, `traveler-search:${req.user.id}`, 150);
    const q = z
      .string()
      .trim()
      .min(1)
      .max(101)
      .parse(req.query.q || "");
    const users = await pool.all(
      "users",
      { display_name: prefix(q) },
      {
        projection: { _id: 0, id: 1, display_name: 1, bio: 1 },
        sort: { display_name: 1, id: 1 },
        limit: 20,
      },
    );
    res.json({
      travelers: users.map((u) => ({
        id: u.id,
        name: u.display_name,
        bio: u.bio,
      })),
    });
  });
  app.get("/api/travelers/:id", requireUser, async (req, res) => {
    const id = uuid.parse(req.params.id),
      u = await pool.one(
        "users",
        { id },
        { projection: { _id: 0, id: 1, display_name: 1, bio: 1 } },
      );
    if (!u) fail(404, "Traveler not found.");
    const mine = await pool.all("trip_participants", { user_id: req.user.id }),
      their = await pool.all("trip_participants", {
        user_id: id,
        trip_id: { $in: mine.map((p) => p.trip_id) },
      });
    const shared = await pool.all(
      "trips",
      { id: { $in: their.map((p) => p.trip_id) } },
      { projection: { _id: 0, id: 1, title: 1 }, sort: { starts_on: -1 } },
    );
    const notices = await tripNotices(
        pool,
        mine.map((p) => p.trip_id),
        id,
      ),
      own = await pool.one("user_blocks", {
        blocker_id: req.user.id,
        blocked_id: id,
        ended_at: null,
      });
    res.json({
      user: { id: u.id, name: u.display_name, bio: u.bio },
      sharedTrips: shared,
      notices,
      myBlockId: own?.id || null,
    });
  });
  app.post("/api/blocks", requireUser, async (req, res) => {
    await throttle(req, `block:${req.user.id}`, 30);
    const d = z
      .object({
        userId: uuid,
        tripId: uuid.nullable().default(null),
        category: z.enum([
          "Harassment",
          "Safety concern",
          "Spam",
          "Communication / boundaries",
          "Other",
        ]),
        reason: z
          .string()
          .trim()
          .min(20, "Explain the reason in at least 20 characters.")
          .max(1000),
      })
      .parse(req.body);
    if (d.userId === req.user.id) fail(400, "You cannot block yourself.");
    try {
      const id = await transaction(pool, async (db) => {
        await lockTravelers(db, [req.user.id, d.userId]);
        if (!(await db.one("users", { id: d.userId })))
          fail(404, "Traveler not found.");
        if (d.tripId) {
          await requireParticipant(db, d.tripId, req.user.id);
          await requireParticipant(db, d.tripId, d.userId);
        }
        return (
          await db.insert("user_blocks", {
            blocker_id: req.user.id,
            blocked_id: d.userId,
            context_trip_id: d.tripId,
            category: d.category,
            reason: d.reason,
          })
        ).id;
      });
      res.status(201).json({ id });
    } catch (e) {
      if (e.code === 11000) fail(409, "You already blocked this traveler.");
      throw e;
    }
  });
  app.delete("/api/blocks/:id", requireUser, async (req, res) => {
    const id = uuid.parse(req.params.id),
      r = await pool.update(
        "user_blocks",
        { id, blocker_id: req.user.id, ended_at: null },
        { $set: { ended_at: new Date() } },
      );
    if (!r.matchedCount)
      fail(404, "Active block not found. Only its author can end it.");
    res.json({ ok: true });
  });
  app.post("/api/blocks/:id/report", requireUser, async (req, res) => {
    await throttle(req, `block-report:${req.user.id}`, 20);
    const id = uuid.parse(req.params.id),
      { reason } = z
        .object({ reason: z.string().trim().min(15).max(600) })
        .parse(req.body),
      block = await pool.one("user_blocks", { id });
    if (!block?.context_trip_id) fail(404, "Trip notice not found.");
    await requireParticipant(pool, block.context_trip_id, req.user.id);
    await pool.insert("block_reason_reports", {
      block_id: id,
      reporter_id: req.user.id,
      reason,
    });
    res.status(201).json({ ok: true });
  });
}
