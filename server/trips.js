import { z } from "zod";
import { transaction, lockTrip, lockTravelers } from "./db.js";
import {
  travelDate,
  profileComplete,
  httpError,
  requireParticipant,
  blockedWithCrew,
  addMember,
  removeMember,
  prefix,
  reviewEligible,
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
  await db.insert("notifications", { user_id: user, trip_id: trip, body });
}
const userMap = async (db, ids) =>
  new Map(
    (
      await db.all(
        "users",
        { id: { $in: [...new Set(ids.filter(Boolean))] } },
        { projection: { _id: 0, id: 1, display_name: 1, bio: 1 } },
      )
    ).map((u) => [u.id, u]),
  );
async function crewLocks(db, id, user) {
  const crew = await db.all("trip_members", { trip_id: id });
  await lockTravelers(db, [user, ...crew.map((m) => m.user_id)]);
  return crew;
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
        .parse(req.query.q || ""),
      pattern = prefix(q);
    const [catalog, trips] = await Promise.all([
      pool.all("location_catalog", { name: pattern }),
      pool.all(
        "trips",
        { $or: [{ destination: pattern }, { from_city: pattern }] },
        { projection: { _id: 0, destination: 1, from_city: 1 } },
      ),
    ]);
    const names = new Map();
    for (const name of [
      ...catalog.map((l) => l.name),
      ...trips.flatMap((t) => [t.destination, t.from_city]),
    ].sort((a, b) => a.localeCompare(b)))
      if (pattern.test(name) && !names.has(name.toLowerCase()))
        names.set(name.toLowerCase(), name);
    res.json({
      locations: [...names.values()]
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
        .slice(0, 15),
    });
  });
  app.get("/api/bootstrap", async (req, res) => {
    const id = req.user?.id || null;
    const [records, members, participants, reviews, hidden] = await Promise.all(
      [
        pool.all("trips", {}, { sort: { created_at: -1, id: 1 } }),
        pool.all("trip_members"),
        id ? pool.all("trip_participants", { user_id: id }) : [],
        pool.all("reviews"),
        id ? pool.all("hidden_trips", { user_id: id }) : [],
      ],
    );
    const users = await userMap(
      pool,
      records.flatMap((t) => [t.owner_id, t.organizer_id]),
    );
    const tripList = records
      .filter(
        (t) =>
          !hidden.some((h) => h.trip_id === t.id) ||
          participants.some((p) => p.trip_id === t.id),
      )
      .map((t) => {
        const ratings = reviews.filter((r) => r.trip_id === t.id);
        return serialize({
          ...t,
          host:
            users.get(t.organizer_id)?.display_name || "No active organizer",
          creator: users.get(t.owner_id)?.display_name || "Former traveler",
          member_count: members.filter((m) => m.trip_id === t.id).length,
          is_member: members.some(
            (m) => m.trip_id === t.id && m.user_id === id,
          ),
          participated: participants.some((p) => p.trip_id === t.id),
          review_count: ratings.length,
          average_rating: ratings.length
            ? Math.round(
                (ratings.reduce((sum, r) => sum + r.rating, 0) /
                  ratings.length) *
                  10,
              ) / 10
            : null,
        });
      });
    const result = {
      user: req.user ? publicUser(req.user) : null,
      today: travelDate(),
      trips: tripList,
      saved: [],
      requests: [],
      incoming: [],
      notifications: [],
      hidden: hidden.map((h) => h.trip_id),
      blocks: [],
    };
    if (id) {
      const organized = records.filter(
        (t) => t.organizer_id === id && t.ends_on >= travelDate(),
      );
      const [saved, requests, incoming, notifications, blocks] =
        await Promise.all([
          pool.all("saved_trips", { user_id: id }),
          pool.all("join_requests", {
            user_id: id,
            status: { $in: ["pending", "accepted"] },
          }),
          pool.all(
            "join_requests",
            { trip_id: { $in: organized.map((t) => t.id) }, status: "pending" },
            { sort: { updated_at: 1 } },
          ),
          pool.all(
            "notifications",
            { user_id: id },
            { sort: { created_at: -1, id: -1 }, limit: 30 },
          ),
          pool.all(
            "user_blocks",
            { blocker_id: id, ended_at: null },
            { sort: { created_at: -1 } },
          ),
        ]);
      const people = await userMap(pool, [
        ...incoming.map((r) => r.user_id),
        ...blocks.map((b) => b.blocked_id),
      ]);
      result.saved = saved.map((r) => r.trip_id);
      result.requests = requests.map(({ trip_id, status, note }) => ({
        trip_id,
        status,
        note,
      }));
      result.incoming = incoming.map((r) => ({
        trip_id: r.trip_id,
        user_id: r.user_id,
        note: r.note,
        status: r.status,
        display_name: people.get(r.user_id)?.display_name || "Former traveler",
        bio: people.get(r.user_id)?.bio || "",
        title: organized.find((t) => t.id === r.trip_id)?.title,
      }));
      result.notifications = notifications.map(
        ({ id, trip_id, body, read_at, created_at }) => ({
          id,
          trip_id,
          body,
          read_at,
          created_at,
        }),
      );
      result.blocks = blocks.map((b) => ({
        id: b.id,
        blocked_id: b.blocked_id,
        reason: b.reason,
        category: b.category,
        context_trip_id: b.context_trip_id,
        created_at: b.created_at,
        name: people.get(b.blocked_id)?.display_name || "Former traveler",
      }));
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
      const t = await db.insert("trips", {
        owner_id: req.user.id,
        organizer_id: req.user.id,
        title: d.title,
        destination: d.destination,
        from_city: d.from,
        starts_on: d.start,
        ends_on: d.end,
        budget_min: d.min,
        budget_max: d.max,
        existing_travelers: d.going,
        capacity: d.going + d.seats,
        category: d.category,
        mode: d.mode,
        women_only: d.women,
        description: d.description,
        plan: d.plan,
        rules: d.rules,
        image,
      });
      await addMember(db, t.id, req.user.id);
      return t.id;
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
    if (!(await pool.one("trips", { id }))) fail(404, "Trip not found.");
    const key = { user_id: req.user.id, trip_id: id };
    if (saved)
      await pool.update(
        "saved_trips",
        key,
        { $setOnInsert: key },
        { upsert: true },
      );
    else await pool.remove("saved_trips", key);
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
      const t = await lockTrip(db, id);
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
      const crew = await crewLocks(db, id, req.user.id);
      if (crew.some((m) => m.user_id === req.user.id))
        fail(409, "You are already a member.");
      if (await blockedWithCrew(db, id, req.user.id))
        fail(
          403,
          "Joining is unavailable because of traveler-group restrictions.",
        );
      if (t.capacity - (t.existing_travelers - 1) - crew.length <= 0)
        fail(409, "This trip has no open spots.");
      const key = { trip_id: id, user_id: req.user.id },
        existing = await db.one("join_requests", key);
      if (existing?.status === "pending")
        fail(409, "Your request is already pending.");
      await db.update(
        "join_requests",
        key,
        { $set: { note, status: "pending", updated_at: new Date() } },
        { upsert: true },
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
      const t = await lockTrip(db, id);
      if (!t) fail(404, "Trip not found.");
      await db.update(
        "join_requests",
        { trip_id: id, user_id: req.user.id },
        { $set: { status: "canceled", updated_at: new Date() } },
      );
      await removeMember(db, id, req.user.id);
      let organizer = t.organizer_id;
      if (organizer === req.user.id) {
        organizer =
          (
            await db.all(
              "trip_members",
              { trip_id: id },
              { sort: { joined_at: 1, user_id: 1 }, limit: 1 },
            )
          )[0]?.user_id || null;
        await db.update("trips", { id }, { $set: { organizer_id: organizer } });
        if (organizer)
          await notify(
            db,
            organizer,
            id,
            "The previous organizer left. You are now the organizer of this retained trip.",
          );
        else
          await db.updateMany(
            "join_requests",
            { trip_id: id, status: "pending" },
            { $set: { status: "rejected", updated_at: new Date() } },
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
      const t = await lockTrip(db, id);
      if (!t) fail(404, "Trip not found.");
      if (t.organizer_id !== req.user.id)
        fail(403, "Only the current organizer can review requests.");
      if (t.status !== "open" || t.ends_on < travelDate())
        fail(409, "This trip is no longer accepting travelers.");
      const request = await db.one("join_requests", {
        trip_id: id,
        user_id: userId,
      });
      if (request?.status !== "pending")
        fail(409, "The request is no longer pending.");
      const crew = await crewLocks(db, id, userId),
        user = await db.one("users", { id: userId });
      if (status === "accepted") {
        if (
          !user?.adult_confirmed ||
          !profileComplete(user) ||
          (t.women_only && user.gender !== "woman")
        )
          fail(403, "This traveler is no longer eligible.");
        if (await blockedWithCrew(db, id, userId))
          fail(
            403,
            "Approval is unavailable because of traveler-group restrictions.",
          );
        if (t.capacity - (t.existing_travelers - 1) - crew.length <= 0)
          fail(409, "No spots remain.");
        await addMember(db, id, userId);
      }
      await db.update(
        "join_requests",
        { trip_id: id, user_id: userId },
        { $set: { status, updated_at: new Date() } },
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
    const [participants, active, t, blocks] = await Promise.all([
      pool.all(
        "trip_participants",
        { trip_id: id },
        { sort: { first_joined_at: 1 } },
      ),
      pool.all("trip_members", { trip_id: id }),
      pool.one("trips", { id }),
      pool.all(
        "user_blocks",
        { context_trip_id: id, ended_at: null },
        { sort: { created_at: -1 } },
      ),
    ]);
    const people = await userMap(pool, [
      ...participants.map((p) => p.user_id),
      ...blocks.flatMap((b) => [b.blocker_id, b.blocked_id]),
    ]);
    const members = [];
    for (const p of participants) {
      const user = people.get(p.user_id);
      if (user)
        members.push({
          id: user.id,
          name: user.display_name,
          bio: user.bio,
          active: active.some((m) => m.user_id === user.id),
          canReview: await reviewEligible(pool, t, user.id),
        });
    }
    res.json({
      members,
      blocks: blocks.map((b) => ({
        id: b.id,
        blocker_id: b.blocker_id,
        blocked_id: b.blocked_id,
        category: b.category,
        reason: b.reason,
        created_at: b.created_at,
        blocker: people.get(b.blocker_id)?.display_name,
        blocked: people.get(b.blocked_id)?.display_name,
      })),
      canReview: await reviewEligible(pool, t, req.user.id),
    });
  });
  app.get("/api/trips/:id/messages", requireUser, async (req, res) => {
    const id = uuid.parse(req.params.id);
    await requireParticipant(pool, id, req.user.id, { current: true });
    const blocks = await pool.all("user_blocks", {
      ended_at: null,
      $or: [{ blocker_id: req.user.id }, { blocked_id: req.user.id }],
    });
    const excluded = blocks.map((b) =>
      b.blocker_id === req.user.id ? b.blocked_id : b.blocker_id,
    );
    const records = await pool.all(
      "messages",
      { trip_id: id, user_id: { $nin: excluded } },
      { sort: { created_at: -1, id: -1 }, limit: 100 },
    );
    const people = await userMap(
      pool,
      records.map((m) => m.user_id),
    );
    res.json({
      messages: records
        .reverse()
        .map((m) => ({
          id: m.id,
          user_id: m.user_id,
          name: people.get(m.user_id)?.display_name || "Former traveler",
          body: m.body,
          created_at: m.created_at,
        })),
    });
  });
  app.post("/api/trips/:id/messages", requireUser, async (req, res) => {
    requireNames(req);
    await throttle(req, `chat:${req.user.id}`, 150);
    const id = uuid.parse(req.params.id),
      { body } = z
        .object({ body: z.string().trim().min(1).max(2000) })
        .parse(req.body);
    await transaction(pool, async (db) => {
      const t = await lockTrip(db, id);
      await requireParticipant(db, id, req.user.id, { current: true });
      if (!t || t.status !== "open" || t.ends_on < travelDate())
        fail(409, "Past or inactive trip chats are read-only.");
      await db.insert("messages", { trip_id: id, user_id: req.user.id, body });
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
      const t = await db.one("trips", { id: d.tripId });
      if (!t) fail(404, "Trip not found.");
      if (t.owner_id === req.user.id)
        fail(400, "You cannot report your own trip.");
      await db.insert("reports", {
        reporter_id: req.user.id,
        trip_id: d.tripId,
        reason: d.reason,
        note: d.note,
      });
      const key = { user_id: req.user.id, trip_id: d.tripId };
      await db.update(
        "hidden_trips",
        key,
        { $setOnInsert: key },
        { upsert: true },
      );
    });
    res.status(201).json({ ok: true });
  });
  app.post("/api/notifications/read", requireUser, async (req, res) => {
    await pool.updateMany(
      "notifications",
      { user_id: req.user.id, read_at: null },
      { $set: { read_at: new Date() } },
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
        .parse(req.body),
      t = await pool.one("trips", { id });
    if (!t || t.status !== "open" || t.ends_on >= travelDate())
      fail(400, "Reviews open after a trip has ended.");
    if (d.travelerId === req.user.id) fail(400, "You cannot review yourself.");
    if (
      !(await reviewEligible(pool, t, req.user.id)) ||
      !(await reviewEligible(pool, t, d.travelerId))
    )
      fail(
        403,
        "Reviews require registered participation overlapping the trip dates.",
      );
    try {
      await pool.insert("reviews", {
        trip_id: id,
        author_id: req.user.id,
        traveler_id: d.travelerId,
        rating: d.rating,
        body: d.body,
      });
    } catch (e) {
      if (e.code === 11000)
        fail(409, "You already reviewed this traveler for this trip.");
      throw e;
    }
    res.status(201).json({ ok: true });
  });
  app.get("/api/trips/:id/reviews", async (req, res) => {
    const id = uuid.parse(req.params.id),
      records = await pool.all(
        "reviews",
        { trip_id: id },
        { sort: { created_at: -1, id: -1 }, limit: 50 },
      ),
      people = await userMap(
        pool,
        records.flatMap((r) => [r.author_id, r.traveler_id]),
      );
    res.json({
      reviews: records.map((r) => ({
        id: r.id,
        rating: r.rating,
        body: r.body,
        created_at: r.created_at,
        author: people.get(r.author_id)?.display_name || "Former traveler",
        traveler: people.get(r.traveler_id)?.display_name || "Former traveler",
      })),
    });
  });
}
