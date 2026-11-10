import { z } from "zod";
import { transaction } from "./db.js";
import {
  TODAY_SQL,
  travelDate,
  profileComplete,
  httpError,
  requireParticipant,
  blockedWithCrew,
} from "./travel-rules.js";
const fail = (s, m) => {
  throw httpError(s, m);
};
const uuid = z.uuid();
const tripSchema = z
  .object({
    title: z.string().trim().min(3).max(65),
    from: z.string().trim().min(1).max(60),
    destination: z.string().trim().min(1).max(60),
    start: z.iso.date(),
    end: z.iso.date(),
    min: z.number().int().min(0).max(1000000),
    max: z.number().int().min(0).max(1000000),
    going: z.number().int().min(1).max(19),
    seats: z.number().int().min(1).max(19),
    category: z.enum(["Mountains", "Beach", "Adventure", "Weekend"]),
    mode: z.enum(["Bus", "Train", "Shared cab", "Self-drive", "Flight"]),
    description: z.string().trim().min(25).max(1200),
    plan: z.string().trim().max(2000).default(""),
    rules: z.string().trim().max(1200).default(""),
    women: z.boolean(),
    age: z.literal(true),
  })
  .refine((t) => t.end >= t.start, {
    message: "Return date must be on or after departure.",
  })
  .refine((t) => t.max >= t.min, {
    message: "Maximum budget must be at least the minimum.",
  })
  .refine((t) => t.going + t.seats <= 20, {
    message: "Groups can have at most 20 travelers.",
  });
const selectTrips = `SELECT t.*,COALESCE(o.display_name,'No active organizer') AS host,c.display_name AS creator,
 (SELECT count(*)::int FROM trip_members m WHERE m.trip_id=t.id) AS member_count,
 EXISTS(SELECT 1 FROM trip_members m WHERE m.trip_id=t.id AND m.user_id=$1) AS is_member,
 EXISTS(SELECT 1 FROM trip_participants p WHERE p.trip_id=t.id AND p.user_id=$1) AS participated,
 (SELECT count(*)::int FROM reviews r WHERE r.trip_id=t.id) AS review_count,
 (SELECT round(avg(r.rating),1)::float FROM reviews r WHERE r.trip_id=t.id) AS average_rating
 FROM trips t JOIN users c ON c.id=t.owner_id LEFT JOIN users o ON o.id=t.organizer_id`;
function serialize(t) {
  const lifecycle =
    t.status === "canceled"
      ? "canceled"
      : t.ends_on < travelDate()
        ? "completed"
        : t.starts_on > travelDate()
          ? "upcoming"
          : "ongoing";
  return {
    id: t.id,
    ownerId: t.owner_id,
    organizerId: t.organizer_id,
    creator: t.creator,
    title: t.title,
    destination: t.destination,
    from: t.from_city,
    start: t.starts_on,
    end: t.ends_on,
    min: t.budget_min,
    max: t.budget_max,
    seats: Math.max(
      0,
      t.capacity - (t.existing_travelers - 1) - t.member_count,
    ),
    total: t.capacity,
    category: t.category,
    tags: [t.category, ...(t.women_only ? ["Women only"] : [])],
    women: t.women_only,
    description: t.description,
    plan: t.plan,
    rules: t.rules,
    mode: t.mode,
    host: t.host,
    initials: t.host
      .split(/\s+/)
      .map((s) => s[0])
      .slice(0, 2)
      .join("")
      .toUpperCase(),
    image: t.image,
    status: t.status,
    lifecycle,
    isMember: t.is_member,
    participated: t.participated,
    reviewCount: t.review_count,
    averageRating: t.average_rating,
  };
}
function requireNames(req) {
  if (!profileComplete(req.user))
    fail(
      409,
      "Please complete your mandatory first and last name in your profile.",
    );
}
async function notify(db, user, trip, body) {
  await db.query(
    "INSERT INTO notifications(user_id,trip_id,body) VALUES($1,$2,$3)",
    [user, trip, body],
  );
}
async function reviewEligible(db, trip, user) {
  return (
    (
      await db.query(
        `SELECT 1 FROM trip_participants p JOIN trips t ON t.id=p.trip_id WHERE p.trip_id=$1 AND p.user_id=$2 AND (p.first_joined_at AT TIME ZONE 'Asia/Kolkata')::date<=t.ends_on AND (p.left_at IS NULL OR (p.left_at AT TIME ZONE 'Asia/Kolkata')::date>=t.starts_on)`,
        [trip, user],
      )
    ).rowCount > 0
  );
}
export function registerTripRoutes(
  app,
  pool,
  { requireUser, throttle, publicUser },
) {
  app.get("/api/locations", async (req, res) => {
    const q = z
      .string()
      .trim()
      .max(60)
      .parse(req.query.q || "");
    const r = await pool.query(
      `SELECT name FROM (SELECT DISTINCT ON(lower(name)) name FROM (SELECT name FROM location_catalog UNION ALL SELECT destination AS name FROM trips UNION ALL SELECT from_city AS name FROM trips) all_names WHERE lower(left(name,char_length($1)))=lower($1) ORDER BY lower(name),name) matches ORDER BY lower(name) LIMIT 15`,
      [q],
    );
    res.json({ locations: r.rows.map((r) => r.name) });
  });
  app.get("/api/bootstrap", async (req, res) => {
    const id = req.user?.id || null;
    const r = await pool.query(
      `${selectTrips} WHERE (NOT EXISTS(SELECT 1 FROM hidden_trips h WHERE h.trip_id=t.id AND h.user_id=$1) OR EXISTS(SELECT 1 FROM trip_participants p WHERE p.trip_id=t.id AND p.user_id=$1)) ORDER BY t.created_at DESC`,
      [id],
    );
    const result = {
      user: req.user ? publicUser(req.user) : null,
      today: travelDate(),
      trips: r.rows.map(serialize),
      saved: [],
      requests: [],
      incoming: [],
      notifications: [],
      hidden: [],
      blocks: [],
    };
    if (id) {
      const [s, j, i, n, h, b] = await Promise.all([
        pool.query("SELECT trip_id FROM saved_trips WHERE user_id=$1", [id]),
        pool.query(
          "SELECT trip_id,status,note FROM join_requests WHERE user_id=$1 AND status IN ('pending','accepted')",
          [id],
        ),
        pool.query(
          "SELECT j.trip_id,j.user_id,j.note,j.status,u.display_name,u.bio,t.title FROM join_requests j JOIN trips t ON t.id=j.trip_id JOIN users u ON u.id=j.user_id WHERE t.organizer_id=$1 AND t.ends_on>=" +
            TODAY_SQL +
            " AND j.status='pending' ORDER BY j.updated_at",
          [id],
        ),
        pool.query(
          "SELECT id,trip_id,body,read_at,created_at FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 30",
          [id],
        ),
        pool.query("SELECT trip_id FROM hidden_trips WHERE user_id=$1", [id]),
        pool.query(
          "SELECT b.id,b.blocked_id,b.reason,b.category,b.context_trip_id,b.created_at,u.display_name AS name FROM user_blocks b JOIN users u ON u.id=b.blocked_id WHERE b.blocker_id=$1 AND b.ended_at IS NULL ORDER BY b.created_at DESC",
          [id],
        ),
      ]);
      result.saved = s.rows.map((r) => r.trip_id);
      result.requests = j.rows;
      result.incoming = i.rows;
      result.notifications = n.rows;
      result.hidden = h.rows.map((r) => r.trip_id);
      result.blocks = b.rows;
    }
    res.json(result);
  });
  app.post("/api/trips", requireUser, async (req, res) => {
    requireNames(req);
    await throttle(req, `create:${req.user.id}`, 30);
    const d = tripSchema.parse(req.body);
    if (!req.user.adult_confirmed)
      fail(403, "Confirm your 18+ profile before creating a trip.");
    if (d.start < travelDate()) fail(400, "Departure must be today or later.");
    if (d.women && req.user.gender !== "woman")
      fail(403, "Set your eligibility before creating a women-only trip.");
    const image =
      d.category === "Beach"
        ? "goa"
        : d.category === "Adventure"
          ? "rishikesh"
          : d.category === "Weekend"
            ? "udaipur"
            : "manali";
    const id = await transaction(pool, async (db) => {
      const r = await db.query(
        "INSERT INTO trips(owner_id,organizer_id,title,destination,from_city,starts_on,ends_on,budget_min,budget_max,existing_travelers,capacity,category,mode,women_only,description,plan,rules,image) VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id",
        [
          req.user.id,
          d.title,
          d.destination,
          d.from,
          d.start,
          d.end,
          d.min,
          d.max,
          d.going,
          d.going + d.seats,
          d.category,
          d.mode,
          d.women,
          d.description,
          d.plan,
          d.rules,
          image,
        ],
      );
      await db.query(
        "INSERT INTO trip_members(trip_id,user_id) VALUES($1,$2)",
        [r.rows[0].id, req.user.id],
      );
      return r.rows[0].id;
    });
    res.status(201).json({ id });
  });
  app.post("/api/trips/:id/cancel", requireUser, (req, res) =>
    res
      .status(405)
      .json({
        error:
          "Trip records cannot be canceled or deleted by users. Leave the trip instead; its history is retained.",
      }),
  );
  app.delete("/api/trips/:id", requireUser, (req, res) =>
    res
      .status(405)
      .json({
        error:
          "Trip records are retained. You can leave a trip, but cannot delete it.",
      }),
  );
  app.put("/api/trips/:id/save", requireUser, async (req, res) => {
    const id = uuid.parse(req.params.id),
      { saved } = z.object({ saved: z.boolean() }).parse(req.body);
    if (!(await pool.query("SELECT id FROM trips WHERE id=$1", [id])).rowCount)
      fail(404, "Trip not found.");
    if (saved)
      await pool.query(
        "INSERT INTO saved_trips(user_id,trip_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [req.user.id, id],
      );
    else
      await pool.query(
        "DELETE FROM saved_trips WHERE user_id=$1 AND trip_id=$2",
        [req.user.id, id],
      );
    res.json({ saved });
  });
  app.post("/api/trips/:id/requests", requireUser, async (req, res) => {
    requireNames(req);
    await throttle(req, `request:${req.user.id}`, 50);
    const id = uuid.parse(req.params.id),
      { note } = z
        .object({ note: z.string().trim().min(15).max(600) })
        .parse(req.body);
    if (!req.user.adult_confirmed)
      fail(403, "Complete your 18+ profile before joining.");
    await transaction(pool, async (db) => {
      const {
        rows: [t],
      } = await db.query("SELECT * FROM trips WHERE id=$1 FOR UPDATE", [id]);
      if (!t || t.status !== "open") fail(404, "Trip is not available.");
      if (t.ends_on < travelDate())
        fail(400, "This trip has ended; joining is closed.");
      if (!t.organizer_id)
        fail(
          409,
          "This trip has no active organizer. Its record remains available, but new requests are closed.",
        );
      if (t.women_only && req.user.gender !== "woman")
        fail(403, "Only eligible travelers can request this women-only trip.");
      const members = await db.query(
        "SELECT user_id FROM trip_members WHERE trip_id=$1",
        [id],
      );
      if (members.rows.some((m) => m.user_id === req.user.id))
        fail(409, "You are already a member.");
      if (await blockedWithCrew(db, id, req.user.id))
        fail(
          403,
          "Joining is unavailable because of traveler-group restrictions.",
        );
      if (t.capacity - (t.existing_travelers - 1) - members.rowCount <= 0)
        fail(409, "This trip has no open spots.");
      const existing = await db.query(
        "SELECT status FROM join_requests WHERE trip_id=$1 AND user_id=$2",
        [id, req.user.id],
      );
      if (existing.rows[0]?.status === "pending")
        fail(409, "Your request is already pending.");
      await db.query(
        "INSERT INTO join_requests(trip_id,user_id,note,status) VALUES($1,$2,$3,'pending') ON CONFLICT(trip_id,user_id) DO UPDATE SET note=$3,status='pending',updated_at=now()",
        [id, req.user.id, note],
      );
      await notify(
        db,
        t.organizer_id,
        id,
        "A traveler requested to join your trip.",
      );
    });
    res.status(201).json({ status: "pending" });
  });
  app.delete("/api/trips/:id/requests", requireUser, async (req, res) => {
    const id = uuid.parse(req.params.id);
    const organizerId = await transaction(pool, async (db) => {
      const {
        rows: [t],
      } = await db.query("SELECT * FROM trips WHERE id=$1 FOR UPDATE", [id]);
      if (!t) fail(404, "Trip not found.");
      await db.query(
        "UPDATE join_requests SET status='canceled',updated_at=now() WHERE trip_id=$1 AND user_id=$2",
        [id, req.user.id],
      );
      await db.query(
        "DELETE FROM trip_members WHERE trip_id=$1 AND user_id=$2",
        [id, req.user.id],
      );
      let organizer = t.organizer_id;
      if (organizer === req.user.id) {
        const remaining = await db.query(
          "SELECT user_id FROM trip_members WHERE trip_id=$1 ORDER BY joined_at,user_id LIMIT 1",
          [id],
        );
        organizer = remaining.rows[0]?.user_id || null;
        await db.query("UPDATE trips SET organizer_id=$2 WHERE id=$1", [
          id,
          organizer,
        ]);
        if (organizer)
          await notify(
            db,
            organizer,
            id,
            "The previous organizer left. You are now the organizer of this retained trip.",
          );
        else
          await db.query(
            "UPDATE join_requests SET status='rejected',updated_at=now() WHERE trip_id=$1 AND status='pending'",
            [id],
          );
      }
      return organizer;
    });
    res.json({ ok: true, organizerId });
  });
  app.put("/api/trips/:id/requests/:userId", requireUser, async (req, res) => {
    requireNames(req);
    const id = uuid.parse(req.params.id),
      userId = uuid.parse(req.params.userId),
      { status } = z
        .object({ status: z.enum(["accepted", "rejected"]) })
        .parse(req.body);
    await transaction(pool, async (db) => {
      const {
        rows: [t],
      } = await db.query("SELECT * FROM trips WHERE id=$1 FOR UPDATE", [id]);
      if (!t) fail(404, "Trip not found.");
      if (t.organizer_id !== req.user.id)
        fail(403, "Only the current organizer can review requests.");
      if (t.status !== "open" || t.ends_on < travelDate())
        fail(409, "This trip is no longer accepting travelers.");
      const {
        rows: [request],
      } = await db.query(
        "SELECT j.*,u.gender,u.adult_confirmed,u.first_name,u.last_name FROM join_requests j JOIN users u ON u.id=j.user_id WHERE j.trip_id=$1 AND j.user_id=$2",
        [id, userId],
      );
      if (request?.status !== "pending")
        fail(409, "The request is no longer pending.");
      if (status === "accepted") {
        if (
          !request.adult_confirmed ||
          !profileComplete(request) ||
          (t.women_only && request.gender !== "woman")
        )
          fail(403, "This traveler is no longer eligible.");
        if (await blockedWithCrew(db, id, userId))
          fail(
            403,
            "Approval is unavailable because of traveler-group restrictions.",
          );
        const {
          rows: [m],
        } = await db.query(
          "SELECT count(*)::int AS n FROM trip_members WHERE trip_id=$1",
          [id],
        );
        if (t.capacity - (t.existing_travelers - 1) - m.n <= 0)
          fail(409, "No spots remain.");
        await db.query(
          "INSERT INTO trip_members(trip_id,user_id) VALUES($1,$2)",
          [id, userId],
        );
      }
      await db.query(
        "UPDATE join_requests SET status=$3,updated_at=now() WHERE trip_id=$1 AND user_id=$2",
        [id, userId, status],
      );
      await notify(
        db,
        userId,
        id,
        status === "accepted"
          ? "Your join request was accepted. Group chat is ready."
          : "Your join request was declined.",
      );
    });
    res.json({ status });
  });
  app.get("/api/trips/:id/members", requireUser, async (req, res) => {
    const id = uuid.parse(req.params.id);
    await requireParticipant(pool, id, req.user.id);
    const r = await pool.query(
      "SELECT u.id,u.display_name AS name,u.bio,(m.user_id IS NOT NULL) AS active FROM trip_participants p JOIN users u ON u.id=p.user_id LEFT JOIN trip_members m ON m.trip_id=p.trip_id AND m.user_id=p.user_id WHERE p.trip_id=$1 ORDER BY p.first_joined_at",
      [id],
    );
    const blocks = await pool.query(
      "SELECT b.id,b.blocker_id,b.blocked_id,b.category,b.reason,b.created_at,a.display_name AS blocker,v.display_name AS blocked FROM user_blocks b JOIN users a ON a.id=b.blocker_id JOIN users v ON v.id=b.blocked_id WHERE b.context_trip_id=$1 AND b.ended_at IS NULL ORDER BY b.created_at DESC",
      [id],
    );
    for (const member of r.rows)
      member.canReview = await reviewEligible(pool, id, member.id);
    res.json({
      members: r.rows,
      blocks: blocks.rows,
      canReview: await reviewEligible(pool, id, req.user.id),
    });
  });
  app.get("/api/trips/:id/messages", requireUser, async (req, res) => {
    const id = uuid.parse(req.params.id);
    await requireParticipant(pool, id, req.user.id, { current: true });
    const r = await pool.query(
      `SELECT m.id,m.user_id,u.display_name AS name,m.body,m.created_at FROM messages m JOIN users u ON u.id=m.user_id WHERE m.trip_id=$1 AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE b.ended_at IS NULL AND ((b.blocker_id=$2 AND b.blocked_id=m.user_id) OR (b.blocked_id=$2 AND b.blocker_id=m.user_id))) ORDER BY m.id DESC LIMIT 100`,
      [id, req.user.id],
    );
    res.json({ messages: r.rows.reverse() });
  });
  app.post("/api/trips/:id/messages", requireUser, async (req, res) => {
    requireNames(req);
    await throttle(req, `chat:${req.user.id}`, 150);
    const id = uuid.parse(req.params.id),
      { body } = z
        .object({ body: z.string().trim().min(1).max(2000) })
        .parse(req.body);
    await transaction(pool, async (db) => {
      const {
        rows: [t],
      } = await db.query("SELECT * FROM trips WHERE id=$1 FOR UPDATE", [id]);
      await requireParticipant(db, id, req.user.id, { current: true });
      if (!t || t.status !== "open" || t.ends_on < travelDate())
        fail(409, "Past or inactive trip chats are read-only.");
      await db.query(
        "INSERT INTO messages(trip_id,user_id,body) VALUES($1,$2,$3)",
        [id, req.user.id, body],
      );
    });
    res.status(201).json({ ok: true });
  });
  app.post("/api/reports", requireUser, async (req, res) => {
    const d = z
      .object({
        tripId: uuid,
        reason: z.string().trim().min(1).max(100),
        note: z.string().trim().max(600).default(""),
      })
      .parse(req.body);
    await throttle(req, `report:${req.user.id}`, 30);
    await transaction(pool, async (db) => {
      const {
        rows: [t],
      } = await db.query("SELECT owner_id FROM trips WHERE id=$1", [d.tripId]);
      if (!t) fail(404, "Trip not found.");
      if (t.owner_id === req.user.id)
        fail(400, "You cannot report your own trip.");
      await db.query(
        "INSERT INTO reports(reporter_id,trip_id,reason,note) VALUES($1,$2,$3,$4)",
        [req.user.id, d.tripId, d.reason, d.note],
      );
      await db.query(
        "INSERT INTO hidden_trips(user_id,trip_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [req.user.id, d.tripId],
      );
    });
    res.status(201).json({ ok: true });
  });
  app.post("/api/notifications/read", requireUser, async (req, res) => {
    await pool.query(
      "UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL",
      [req.user.id],
    );
    res.json({ ok: true });
  });
  app.post("/api/trips/:id/reviews", requireUser, async (req, res) => {
    requireNames(req);
    const id = uuid.parse(req.params.id),
      d = z
        .object({
          travelerId: uuid,
          rating: z.number().int().min(1).max(5),
          body: z.string().trim().min(10).max(1000),
        })
        .parse(req.body);
    const {
      rows: [t],
    } = await pool.query("SELECT * FROM trips WHERE id=$1", [id]);
    if (!t || t.status !== "open" || t.ends_on >= travelDate())
      fail(400, "Reviews open after a trip has ended.");
    if (d.travelerId === req.user.id) fail(400, "You cannot review yourself.");
    if (
      !(await reviewEligible(pool, id, req.user.id)) ||
      !(await reviewEligible(pool, id, d.travelerId))
    )
      fail(
        403,
        "Reviews require registered participation overlapping the trip dates.",
      );
    try {
      await pool.query(
        "INSERT INTO reviews(trip_id,author_id,traveler_id,rating,body) VALUES($1,$2,$3,$4,$5)",
        [id, req.user.id, d.travelerId, d.rating, d.body],
      );
    } catch (e) {
      if (e.code === "23505")
        fail(409, "You already reviewed this traveler for this trip.");
      throw e;
    }
    res.status(201).json({ ok: true });
  });
  app.get("/api/trips/:id/reviews", async (req, res) => {
    const id = uuid.parse(req.params.id);
    const r = await pool.query(
      "SELECT r.id,r.rating,r.body,r.created_at,a.display_name AS author,v.display_name AS traveler FROM reviews r JOIN users a ON a.id=r.author_id JOIN users v ON v.id=r.traveler_id WHERE r.trip_id=$1 ORDER BY r.created_at DESC LIMIT 50",
      [id],
    );
    res.json({ reviews: r.rows });
  });
}
