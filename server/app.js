import express from "express";
import helmet from "helmet";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { transaction } from "./db.js";
import {
  cookieName,
  cookieOptions,
  digest,
  dummyHash,
  hashPassword,
  issueSession,
  publicUser,
  sessionToken,
  verifyPassword,
} from "./auth.js";
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
const uuid = z.uuid();
const email = z
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
const password = z
  .string()
  .min(10, "Use at least 10 characters for your password.")
  .max(128);
const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
const signupSchema = z
  .object({
    email,
    password,
    confirmPassword: z.string().max(128),
    age: z.literal(true, { error: "You must be 18 or older to sign up." }),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });
const profileSchema = z.object({
  name: z.string().trim().min(1).max(50),
  city: z.string().trim().max(60),
  gender: z.enum(["", "woman", "other"]),
  bio: z.string().trim().max(500),
  age: z.literal(true, { error: "You must be 18 or older to use Tripling." }),
});
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
const tripSelect = `SELECT t.*,u.display_name AS host,
 (SELECT count(*)::int FROM trip_members m WHERE m.trip_id=t.id AND m.user_id<>t.owner_id) AS additional_members,
 EXISTS(SELECT 1 FROM trip_members m WHERE m.trip_id=t.id AND m.user_id=$1) AS is_member
 FROM trips t JOIN users u ON u.id=t.owner_id`;
function serializeTrip(t) {
  const seats = t.capacity - t.existing_travelers - t.additional_members;
  return {
    id: t.id,
    ownerId: t.owner_id,
    title: t.title,
    destination: t.destination,
    from: t.from_city,
    start: t.starts_on,
    end: t.ends_on,
    min: t.budget_min,
    max: t.budget_max,
    seats,
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
      .map((v) => v[0])
      .slice(0, 2)
      .join("")
      .toUpperCase(),
    image: t.image,
    status: t.status,
    isMember: t.is_member,
  };
}
export function createApp(
  pool,
  {
    production = process.env.NODE_ENV === "production",
    publicOrigin = process.env.PUBLIC_ORIGIN,
  } = {},
) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: production ? [] : null,
        },
      },
      strictTransportSecurity: production ? undefined : false,
    }),
  );
  app.use(express.json({ limit: "32kb" }));
  app.get("/healthz", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      const origin = req.get("origin");
      let valid = false;
      try {
        const url = new URL(origin);
        valid = publicOrigin
          ? url.origin === new URL(publicOrigin).origin
          : url.host === req.get("host") &&
            url.protocol === (production ? "https:" : "http:");
      } catch {}
      if (!valid)
        return res
          .status(403)
          .json({ error: "Request origin is not allowed." });
      if (!req.is("application/json"))
        return res.status(415).json({ error: "Use JSON for API requests." });
    }
    next();
  });
  app.use("/api", async (req, res, next) => {
    try {
      const token = sessionToken(req);
      if (token) {
        const result = await pool.query(
          "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()",
          [digest(token)],
        );
        req.user = result.rows[0] || null;
      }
      next();
    } catch (e) {
      next(e);
    }
  });
  const requireUser = (req, res, next) =>
    req.user
      ? next()
      : res.status(401).json({ error: "Please log in to continue." });
  async function throttle(req, key, limit) {
    const window = Math.floor(Date.now() / 900000);
    const result = await pool.query(
      "INSERT INTO auth_rate_limits(bucket_key,window_start) VALUES($1,$2) ON CONFLICT(bucket_key,window_start) DO UPDATE SET attempts=auth_rate_limits.attempts+1 RETURNING attempts",
      [digest(key), window],
    );
    if (result.rows[0].attempts > limit)
      fail(429, "Too many attempts. Please try again in 15 minutes.");
  }
  app.post("/api/auth/signup", async (req, res) => {
    await throttle(req, `signup:${req.ip}`, 10);
    const data = signupSchema.parse(req.body);
    const hash = await hashPassword(data.password);
    try {
      const user = await transaction(pool, async (db) => {
        const result = await db.query(
          "INSERT INTO users(email,password_hash,adult_confirmed) VALUES($1,$2,true) RETURNING *",
          [data.email, hash],
        );
        await issueSession(db, req, res, result.rows[0].id, production);
        return result.rows[0];
      });
      res.status(201).json({ user: publicUser(user) });
    } catch (e) {
      if (e.code === "23505")
        fail(
          409,
          "An account cannot be created with these details. Try logging in.",
        );
      throw e;
    }
  });
  app.post("/api/auth/login", async (req, res) => {
    await throttle(req, `login-ip:${req.ip}`, 40);
    const data = loginSchema.parse(req.body);
    await throttle(req, `login-email:${data.email}`, 10);
    const result = await pool.query("SELECT * FROM users WHERE email=$1", [
      data.email,
    ]);
    const user = result.rows[0];
    const valid = await verifyPassword(
      data.password,
      user?.password_hash || dummyHash,
    );
    if (!user || !valid) fail(401, "Email or password is incorrect.");
    await transaction(pool, (db) =>
      issueSession(db, req, res, user.id, production),
    );
    res.json({ user: publicUser(user) });
  });
  app.get("/api/auth/session", (req, res) =>
    res.json({ user: req.user ? publicUser(req.user) : null }),
  );
  app.post("/api/auth/logout", async (req, res) => {
    const token = sessionToken(req);
    if (token)
      await pool.query("DELETE FROM sessions WHERE token_hash=$1", [
        digest(token),
      ]);
    res.clearCookie(cookieName, {
      ...cookieOptions(production),
      maxAge: undefined,
    });
    res.json({ ok: true });
  });
  app.put("/api/profile", requireUser, async (req, res) => {
    const d = profileSchema.parse(req.body);
    const result = await pool.query(
      "UPDATE users SET display_name=$2,city=$3,gender=$4,bio=$5,adult_confirmed=true WHERE id=$1 RETURNING *",
      [req.user.id, d.name, d.city, d.gender, d.bio],
    );
    res.json({ user: publicUser(result.rows[0]) });
  });
  app.get("/api/bootstrap", async (req, res) => {
    const id = req.user?.id || null;
    const rows = await pool.query(
      `${tripSelect} WHERE (t.status='open' AND t.ends_on>=CURRENT_DATE OR t.owner_id=$1 OR EXISTS(SELECT 1 FROM trip_members m WHERE m.trip_id=t.id AND m.user_id=$1) OR EXISTS(SELECT 1 FROM join_requests j WHERE j.trip_id=t.id AND j.user_id=$1 AND j.status IN ('pending','accepted'))) AND (NOT EXISTS(SELECT 1 FROM hidden_trips h WHERE h.trip_id=t.id AND h.user_id=$1) OR t.owner_id=$1 OR EXISTS(SELECT 1 FROM join_requests j WHERE j.trip_id=t.id AND j.user_id=$1 AND j.status IN ('pending','accepted'))) ORDER BY t.created_at DESC`,
      [id],
    );
    const result = {
      user: req.user ? publicUser(req.user) : null,
      trips: rows.rows.map(serializeTrip),
      saved: [],
      requests: [],
      incoming: [],
      notifications: [],
      hidden: [],
    };
    if (id) {
      const [saved, requests, incoming, notifications, hidden] =
        await Promise.all([
          pool.query("SELECT trip_id FROM saved_trips WHERE user_id=$1", [id]),
          pool.query(
            "SELECT trip_id,status,note FROM join_requests WHERE user_id=$1 AND status IN ('pending','accepted')",
            [id],
          ),
          pool.query(
            "SELECT j.trip_id,j.user_id,j.note,j.status,u.display_name,u.bio,t.title FROM join_requests j JOIN trips t ON t.id=j.trip_id JOIN users u ON u.id=j.user_id WHERE t.owner_id=$1 AND j.status='pending' ORDER BY j.updated_at",
            [id],
          ),
          pool.query(
            "SELECT id,trip_id,body,read_at,created_at FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 30",
            [id],
          ),
          pool.query("SELECT trip_id FROM hidden_trips WHERE user_id=$1", [id]),
        ]);
      result.saved = saved.rows.map((r) => r.trip_id);
      result.requests = requests.rows;
      result.incoming = incoming.rows;
      result.notifications = notifications.rows;
      result.hidden = hidden.rows.map((row) => row.trip_id);
    }
    res.json(result);
  });
  app.post("/api/trips", requireUser, async (req, res) => {
    await throttle(req, `create:${req.user.id}`, 30);
    const d = tripSchema.parse(req.body);
    if (!req.user.adult_confirmed)
      fail(403, "Complete your 18+ traveler profile before creating a trip.");
    if (d.start < new Date().toISOString().slice(0, 10))
      fail(400, "Departure must be today or later.");
    if (d.women && req.user.gender !== "woman")
      fail(
        403,
        "Set your eligibility in your profile before creating a women-only trip.",
      );
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
        `INSERT INTO trips(owner_id,title,destination,from_city,starts_on,ends_on,budget_min,budget_max,existing_travelers,capacity,category,mode,women_only,description,plan,rules,image) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
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
  app.post("/api/trips/:id/cancel", requireUser, async (req, res) => {
    const id = uuid.parse(req.params.id);
    await transaction(pool, async (db) => {
      const r = await db.query("SELECT * FROM trips WHERE id=$1 FOR UPDATE", [
        id,
      ]);
      const trip = r.rows[0];
      if (!trip) fail(404, "Trip not found.");
      if (trip.owner_id !== req.user.id)
        fail(403, "Only the organizer can cancel this trip.");
      if (trip.status === "canceled") return;
      await db.query("UPDATE trips SET status='canceled' WHERE id=$1", [id]);
      await db.query(
        "UPDATE join_requests SET status='rejected',updated_at=now() WHERE trip_id=$1 AND status='pending'",
        [id],
      );
      await db.query(
        "INSERT INTO notifications(user_id,trip_id,body) SELECT user_id,trip_id,'The organizer canceled this trip.' FROM join_requests WHERE trip_id=$1 AND status IN ('accepted','rejected')",
        [id],
      );
    });
    res.json({ ok: true });
  });
  app.put("/api/trips/:id/save", requireUser, async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { saved } = z.object({ saved: z.boolean() }).parse(req.body);
    if (saved) {
      const found = await pool.query(
        "SELECT id FROM trips WHERE id=$1 AND status='open'",
        [id],
      );
      if (!found.rowCount) fail(404, "Trip not available.");
      await pool.query(
        "INSERT INTO saved_trips(user_id,trip_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [req.user.id, id],
      );
    } else
      await pool.query(
        "DELETE FROM saved_trips WHERE user_id=$1 AND trip_id=$2",
        [req.user.id, id],
      );
    res.json({ saved });
  });
  app.post("/api/trips/:id/requests", requireUser, async (req, res) => {
    await throttle(req, `request:${req.user.id}`, 50);
    const id = uuid.parse(req.params.id);
    const { note } = z
      .object({ note: z.string().trim().min(15).max(600) })
      .parse(req.body);
    if (!req.user.adult_confirmed)
      fail(403, "Complete your 18+ profile before requesting to join.");
    await transaction(pool, async (db) => {
      const r = await db.query("SELECT * FROM trips WHERE id=$1 FOR UPDATE", [
        id,
      ]);
      const t = r.rows[0];
      if (!t || t.status !== "open") fail(404, "Trip is not available.");
      if (t.ends_on < new Date().toISOString().slice(0, 10))
        fail(400, "This trip has already ended.");
      if (t.owner_id === req.user.id)
        fail(400, "You are already the organizer.");
      if (t.women_only && req.user.gender !== "woman")
        fail(
          403,
          "Only eligible travelers can request to join this women-only trip.",
        );
      const members = await db.query(
        "SELECT user_id FROM trip_members WHERE trip_id=$1",
        [id],
      );
      if (members.rows.some((m) => m.user_id === req.user.id))
        fail(409, "You are already a member.");
      if (t.capacity - t.existing_travelers - (members.rowCount - 1) <= 0)
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
      await db.query(
        "INSERT INTO notifications(user_id,trip_id,body) VALUES($1,$2,$3)",
        [t.owner_id, id, "A traveler requested to join your trip."],
      );
    });
    res.status(201).json({ status: "pending" });
  });
  app.delete("/api/trips/:id/requests", requireUser, async (req, res) => {
    const id = uuid.parse(req.params.id);
    await transaction(pool, async (db) => {
      await db.query("SELECT id FROM trips WHERE id=$1 FOR UPDATE", [id]);
      await db.query(
        "UPDATE join_requests SET status='canceled',updated_at=now() WHERE trip_id=$1 AND user_id=$2",
        [id, req.user.id],
      );
      await db.query(
        "DELETE FROM trip_members WHERE trip_id=$1 AND user_id=$2 AND user_id<>(SELECT owner_id FROM trips WHERE id=$1)",
        [id, req.user.id],
      );
    });
    res.json({ ok: true });
  });
  app.put("/api/trips/:id/requests/:userId", requireUser, async (req, res) => {
    const id = uuid.parse(req.params.id),
      userId = uuid.parse(req.params.userId);
    const { status } = z
      .object({ status: z.enum(["accepted", "rejected"]) })
      .parse(req.body);
    await transaction(pool, async (db) => {
      const r = await db.query("SELECT * FROM trips WHERE id=$1 FOR UPDATE", [
        id,
      ]);
      const t = r.rows[0];
      if (!t) fail(404, "Trip not found.");
      if (t.owner_id !== req.user.id)
        fail(403, "Only the organizer can review requests.");
      if (t.status !== "open") fail(409, "This trip has been canceled.");
      if (t.ends_on < new Date().toISOString().slice(0, 10))
        fail(409, "This trip has already ended.");
      const request = await db.query(
        "SELECT j.*,u.gender,u.adult_confirmed FROM join_requests j JOIN users u ON u.id=j.user_id WHERE trip_id=$1 AND user_id=$2",
        [id, userId],
      );
      if (request.rows[0]?.status !== "pending")
        fail(409, "This request is no longer pending.");
      if (status === "accepted") {
        if (
          !request.rows[0].adult_confirmed ||
          (t.women_only && request.rows[0].gender !== "woman")
        )
          fail(403, "This traveler is no longer eligible for the trip.");
        const m = await db.query(
          "SELECT count(*)::int AS n FROM trip_members WHERE trip_id=$1 AND user_id<>$2",
          [id, t.owner_id],
        );
        if (t.capacity - t.existing_travelers - m.rows[0].n <= 0)
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
      await db.query(
        "INSERT INTO notifications(user_id,trip_id,body) VALUES($1,$2,$3)",
        [
          userId,
          id,
          status === "accepted"
            ? "Your join request was accepted. Your group chat is ready."
            : "Your join request was declined.",
        ],
      );
    });
    res.json({ status });
  });
  async function memberTrip(id, userId) {
    const t = await pool.query(
      "SELECT t.* FROM trips t JOIN trip_members m ON m.trip_id=t.id WHERE t.id=$1 AND m.user_id=$2",
      [id, userId],
    );
    if (!t.rowCount) fail(403, "Group chat is for accepted members only.");
    return t.rows[0];
  }
  app.get("/api/trips/:id/members", requireUser, async (req, res) => {
    const id = uuid.parse(req.params.id);
    await memberTrip(id, req.user.id);
    const r = await pool.query(
      "SELECT u.id,u.display_name AS name,u.bio FROM trip_members m JOIN users u ON u.id=m.user_id WHERE m.trip_id=$1 ORDER BY m.joined_at",
      [id],
    );
    res.json({ members: r.rows });
  });
  app.get("/api/trips/:id/messages", requireUser, async (req, res) => {
    const id = uuid.parse(req.params.id);
    await memberTrip(id, req.user.id);
    const r = await pool.query(
      "SELECT m.id,m.user_id,u.display_name AS name,m.body,m.created_at FROM messages m JOIN users u ON u.id=m.user_id WHERE m.trip_id=$1 ORDER BY m.id DESC LIMIT 100",
      [id],
    );
    res.json({ messages: r.rows.reverse() });
  });
  app.post("/api/trips/:id/messages", requireUser, async (req, res) => {
    await throttle(req, `chat:${req.user.id}`, 150);
    const id = uuid.parse(req.params.id);
    const { body } = z
      .object({ body: z.string().trim().min(1).max(2000) })
      .parse(req.body);
    await transaction(pool, async (db) => {
      const r = await db.query(
        "SELECT status FROM trips WHERE id=$1 FOR UPDATE",
        [id],
      );
      const member = await db.query(
        "SELECT 1 FROM trip_members WHERE trip_id=$1 AND user_id=$2",
        [id, req.user.id],
      );
      if (!r.rowCount || !member.rowCount)
        fail(403, "Group chat is for accepted members only.");
      if (r.rows[0].status !== "open")
        fail(409, "This trip has been canceled.");
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
      const t = await db.query("SELECT owner_id FROM trips WHERE id=$1", [
        d.tripId,
      ]);
      if (!t.rowCount) fail(404, "Trip not found.");
      if (t.rows[0].owner_id === req.user.id)
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
    const id = uuid.parse(req.params.id);
    const d = z
      .object({
        travelerId: uuid,
        rating: z.number().int().min(1).max(5),
        body: z.string().trim().min(10).max(1000),
      })
      .parse(req.body);
    const t = await memberTrip(id, req.user.id);
    if (
      t.status !== "open" ||
      t.ends_on >= new Date().toISOString().slice(0, 10)
    )
      fail(400, "Reviews open after the trip has ended.");
    if (d.travelerId === req.user.id) fail(400, "You cannot review yourself.");
    await memberTrip(id, d.travelerId);
    try {
      await pool.query(
        "INSERT INTO reviews(trip_id,author_id,traveler_id,rating,body) VALUES($1,$2,$3,$4,$5)",
        [id, req.user.id, d.travelerId, d.rating, d.body],
      );
    } catch (e) {
      if (e.code === "23505")
        fail(409, "You have already reviewed this traveler for this trip.");
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
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "API endpoint not found." }),
  );
  app.use(
    express.static(fileURLToPath(new URL("../dist/", import.meta.url)), {
      index: "index.html",
      maxAge: 0,
    }),
  );
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof z.ZodError)
      return res
        .status(400)
        .json({ error: err.issues[0]?.message || "Invalid request." });
    const status = err.status || 500;
    if (status >= 500) console.error("Request failed:", err.code || err.name);
    res.status(status).json({
      error:
        status >= 500 ? "Something went wrong. Please try again." : err.message,
    });
  });
  return app;
}
