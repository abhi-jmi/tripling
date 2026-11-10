import { z } from "zod";
import { transaction } from "./db.js";
import { httpError, requireParticipant } from "./travel-rules.js";
const uuid = z.uuid();
const fail = (s, m) => {
  throw httpError(s, m);
};
export function registerBlockRoutes(app, pool, { requireUser, throttle }) {
  app.get("/api/travelers", requireUser, async (req, res) => {
    await throttle(req, `traveler-search:${req.user.id}`, 150);
    const q = z
      .string()
      .trim()
      .min(1)
      .max(101)
      .parse(req.query.q || "");
    const r = await pool.query(
      "SELECT id,display_name AS name,bio FROM users WHERE lower(left(display_name,char_length($1)))=lower($1) ORDER BY lower(display_name),id LIMIT 20",
      [q],
    );
    res.json({ travelers: r.rows });
  });
  app.get("/api/travelers/:id", requireUser, async (req, res) => {
    const id = uuid.parse(req.params.id);
    const {
      rows: [user],
    } = await pool.query(
      "SELECT id,display_name AS name,bio FROM users WHERE id=$1",
      [id],
    );
    if (!user) fail(404, "Traveler not found.");
    const shared = await pool.query(
      "SELECT t.id,t.title FROM trip_participants a JOIN trip_participants b ON a.trip_id=b.trip_id JOIN trips t ON t.id=a.trip_id WHERE a.user_id=$1 AND b.user_id=$2 ORDER BY t.starts_on DESC",
      [req.user.id, id],
    );
    const notices = await pool.query(
      "SELECT b.id,b.context_trip_id,b.category,b.reason,b.created_at,a.display_name AS blocker,v.display_name AS blocked,t.title FROM user_blocks b JOIN users a ON a.id=b.blocker_id JOIN users v ON v.id=b.blocked_id JOIN trips t ON t.id=b.context_trip_id JOIN trip_participants p ON p.trip_id=b.context_trip_id AND p.user_id=$1 WHERE b.ended_at IS NULL AND (b.blocked_id=$2 OR b.blocker_id=$2) ORDER BY b.created_at DESC",
      [req.user.id, id],
    );
    const own = await pool.query(
      "SELECT id FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2 AND ended_at IS NULL",
      [req.user.id, id],
    );
    res.json({
      user,
      sharedTrips: shared.rows,
      notices: notices.rows,
      myBlockId: own.rows[0]?.id || null,
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
    const id = await transaction(pool, async (db) => {
      // Serialize block creation with requests/approvals/leaving in all affected groups.
      await db.query(
        "SELECT t.id FROM trips t WHERE EXISTS(SELECT 1 FROM trip_members m WHERE m.trip_id=t.id AND m.user_id IN ($1,$2)) ORDER BY t.id FOR UPDATE",
        [req.user.id, d.userId],
      );
      if (
        !(await db.query("SELECT id FROM users WHERE id=$1", [d.userId]))
          .rowCount
      )
        fail(404, "Traveler not found.");
      if (d.tripId) {
        await requireParticipant(db, d.tripId, req.user.id);
        await requireParticipant(db, d.tripId, d.userId);
      }
      try {
        const r = await db.query(
          "INSERT INTO user_blocks(blocker_id,blocked_id,context_trip_id,category,reason) VALUES($1,$2,$3,$4,$5) RETURNING id",
          [req.user.id, d.userId, d.tripId, d.category, d.reason],
        );
        return r.rows[0].id;
      } catch (e) {
        if (e.code === "23505") fail(409, "You already blocked this traveler.");
        throw e;
      }
    });
    res.status(201).json({ id });
  });
  app.delete("/api/blocks/:id", requireUser, async (req, res) => {
    const id = uuid.parse(req.params.id);
    const r = await pool.query(
      "UPDATE user_blocks SET ended_at=now() WHERE id=$1 AND blocker_id=$2 AND ended_at IS NULL RETURNING id",
      [id, req.user.id],
    );
    if (!r.rowCount)
      fail(404, "Active block not found. Only its author can end it.");
    res.json({ ok: true });
  });
  app.post("/api/blocks/:id/report", requireUser, async (req, res) => {
    await throttle(req, `block-report:${req.user.id}`, 20);
    const id = uuid.parse(req.params.id),
      { reason } = z
        .object({ reason: z.string().trim().min(15).max(600) })
        .parse(req.body);
    const {
      rows: [block],
    } = await pool.query(
      "SELECT context_trip_id FROM user_blocks WHERE id=$1",
      [id],
    );
    if (!block?.context_trip_id) fail(404, "Trip notice not found.");
    await requireParticipant(pool, block.context_trip_id, req.user.id);
    await pool.query(
      "INSERT INTO block_reason_reports(block_id,reporter_id,reason) VALUES($1,$2,$3)",
      [id, req.user.id, reason],
    );
    res.status(201).json({ ok: true });
  });
}
