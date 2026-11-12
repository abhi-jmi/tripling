import { z } from "zod";
import { indexTripLocation } from "./geo-index.js";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { transaction, lockTrip, lockTravelers } from "./db.js";
import { isAdmin, requireVerified, canCancelParticipation } from "./roles.js";
import {
  httpError,
  travelDate,
  reviewEligible,
  removeMember,
} from "./travel-rules.js";
import {
  TRAVEL_STYLES,
  LEGACY_STYLES,
  eligibleForGroup,
  groupOf,
} from "./trip-options.js";
const fail = (s, m) => {
    throw httpError(s, m);
  },
  id = z.uuid();
const text = (min, max) => z.string().trim().min(min).max(max);
const categories = [
  "General Feedback",
  "Suggestion",
  "Complaint",
  "Technical Issue",
  "Trip Related",
  "Other",
];
export function encryptDocument(
  doc,
  keyString = process.env.VERIFICATION_DOCUMENT_KEY,
) {
  const key = Buffer.from(keyString || "", "base64");
  if (key.length !== 32)
    fail(503, "Private document storage is not configured. Contact support.");
  const bytes = Buffer.from(doc.base64, "base64");
  if (
    !bytes.length ||
    bytes.length > 2 * 1024 * 1024 ||
    bytes.toString("base64") !== doc.base64
  )
    fail(400, "Upload a PDF, PNG or JPEG no larger than 2 MB.");
  const valid =
    doc.type === "application/pdf"
      ? bytes.subarray(0, 5).toString() === "%PDF-"
      : doc.type === "image/png"
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : doc.type === "image/jpeg" &&
          bytes[0] === 255 &&
          bytes[1] === 216 &&
          bytes[2] === 255;
  if (!valid) fail(400, "The document contents do not match its file type.");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  return {
    data: Buffer.concat([cipher.update(bytes), cipher.final()]).toString(
      "base64",
    ),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    type: doc.type,
  };
}
export function decryptDocument(
  doc,
  keyString = process.env.VERIFICATION_DOCUMENT_KEY,
) {
  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyString || "", "base64"),
    Buffer.from(doc.iv, "base64"),
  );
  cipher.setAuthTag(Buffer.from(doc.tag, "base64"));
  return Buffer.concat([
    cipher.update(Buffer.from(doc.data, "base64")),
    cipher.final(),
  ]);
}
export function registerCommunity(
  app,
  pool,
  { requireUser, throttle, cityResolver },
) {
  const admin = (req, res, next) =>
    isAdmin(req.user)
      ? next()
      : res.status(403).json({ error: "Administrator access is required." });
  const audit = (db, actor, action, subject, reason = "") =>
    db.insert("admin_audit", {
      actor_id: actor,
      action,
      subject,
      reason,
      created_at: new Date(),
    });
  app.use("/api/admin", requireUser, admin, async (req, res, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method))
      await throttle(req, `admin:${req.user.id}`, 100);
    next();
  });
  const notify = (db, user, body) =>
    db.insert("notifications", { user_id: user, trip_id: null, body });
  app.get("/api/organizer/verification", requireUser, async (req, res) => {
    const request = await pool.one(
      "organizer_verifications",
      { user_id: req.user.id },
      { projection: { document: 0 } },
    );
    res.json({
      status: req.user.organizer_verification || "not_submitted",
      request,
      documentUploadsEnabled:
        Buffer.from(process.env.VERIFICATION_DOCUMENT_KEY || "", "base64")
          .length === 32,
    });
  });
  app.post("/api/organizer/verification", requireUser, async (req, res) => {
    await throttle(req, `verification:${req.user.id}`, 5);
    const data = z
      .object({
        name: text(2, 120),
        experience: text(30, 2000),
        contact: text(5, 200),
        document: z
          .object({
            type: z.enum(["application/pdf", "image/png", "image/jpeg"]),
            base64: z.string().max(2800000),
          })
          .optional(),
      })
      .parse(req.body);
    const document = data.document ? encryptDocument(data.document) : null;
    await transaction(pool, async (db) => {
      await lockTravelers(db, [req.user.id]);
      const user = await db.one("users", { id: req.user.id });
      if (["pending", "approved"].includes(user.organizer_verification))
        fail(409, "Your request is already pending or approved.");
      await db.update(
        "organizer_verifications",
        { user_id: req.user.id },
        {
          $set: {
            name: data.name,
            experience: data.experience,
            contact: data.contact,
            document,
            hasDocument: !!document,
            document_expires_at: document
              ? new Date(Date.now() + 30 * 86400000)
              : null,
            status: "pending",
            reason: "",
            submitted_at: new Date(),
          },
        },
        { upsert: true },
      );
      await db.update(
        "users",
        { id: req.user.id },
        { $set: { organizer_verification: "pending" } },
      );
      await audit(db, req.user.id, "verification_submitted", req.user.id);
    });
    res.status(201).json({ status: "pending" });
  });
  app.post(
    "/api/admin/locations/reindex",
    requireUser,
    admin,
    async (req, res) => {
      const { limit } = z
        .object({ limit: z.number().int().min(1).max(25).default(25) })
        .parse(req.body);
      if (!cityResolver) fail(503, "Google Places is not configured.");
      const candidates = await pool.database
        .collection("trips")
        .aggregate([
          { $match: { status: "open", ends_on: { $gte: travelDate() } } },
          {
            $lookup: {
              from: "trip_locations",
              localField: "id",
              foreignField: "trip_id",
              as: "geo",
            },
          },
          {
            $match: {
              $or: [
                { geo: { $size: 0 } },
                { "geo.expires_at": { $lte: new Date() } },
              ],
            },
          },
          { $sort: { starts_on: 1, id: 1 } },
          { $limit: limit },
        ])
        .toArray();
      let indexed = 0,
        unresolved = 0;
      for (let i = 0; i < candidates.length; i += 5)
        await Promise.all(
          candidates.slice(i, i + 5).map(async (trip) => {
            const r = await indexTripLocation(pool, trip, {
              resolver: cityResolver,
            });
            if (r.indexed) indexed++;
            if (r.missing?.length) unresolved++;
          }),
        );
      await audit(
        pool,
        req.user.id,
        "locations_reindexed",
        String(candidates.length),
      );
      res.json({ processed: candidates.length, indexed, unresolved });
    },
  );
  app.get("/api/admin/verifications", requireUser, admin, async (req, res) => {
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .max(100000)
      .parse(req.query.offset || 0);
    const requests = await pool.all(
      "organizer_verifications",
      {},
      {
        projection: { document: 0 },
        sort: { submitted_at: -1, user_id: 1 },
        skip: offset,
        limit: 100,
      },
    );
    res.json({
      requests,
      offset,
      nextOffset: requests.length === 100 ? offset + 100 : null,
    });
  });
  app.get(
    "/api/admin/verifications/:user/document",
    requireUser,
    admin,
    async (req, res) => {
      const user = id.parse(req.params.user),
        row = await pool.one("organizer_verifications", { user_id: user });
      if (!row?.document || new Date(row.document_expires_at) <= new Date())
        fail(404, "No current supporting document.");
      const bytes = decryptDocument(row.document);
      await audit(pool, req.user.id, "verification_document_read", user);
      res
        .set({
          "Cache-Control": "no-store",
          "Content-Disposition": 'attachment; filename="supporting-document"',
          "Content-Security-Policy": "sandbox; default-src 'none'",
          "X-Content-Type-Options": "nosniff",
        })
        .type(row.document.type)
        .send(bytes);
    },
  );
  app.put(
    "/api/admin/verifications/:user",
    requireUser,
    admin,
    async (req, res) => {
      const user = id.parse(req.params.user),
        data = z
          .object({
            status: z.enum(["approved", "rejected"]),
            reason: text(0, 1000).default(""),
          })
          .parse(req.body);
      if (user === req.user.id)
        fail(403, "Administrators cannot approve their own verification.");
      await transaction(pool, async (db) => {
        await lockTravelers(db, [user]);
        const row = await db.one("organizer_verifications", { user_id: user });
        if (row?.status !== "pending")
          fail(409, "Only pending applications can be reviewed.");
        await db.update(
          "organizer_verifications",
          { user_id: user },
          {
            $set: {
              ...data,
              reviewed_at: new Date(),
              reviewer_id: req.user.id,
            },
          },
        );
        await db.update(
          "users",
          { id: user },
          { $set: { organizer_verification: data.status } },
        );
        await audit(
          db,
          req.user.id,
          "verification_" + data.status,
          user,
          data.reason,
        );
        await notify(
          db,
          user,
          `Organizer verification ${data.status}.${data.reason ? " " + data.reason : ""}`,
        );
      });
      res.json({ ok: true });
    },
  );
  app.get("/api/organizer/dashboard", requireUser, async (req, res) => {
    const trips = await pool.all(
        "trips",
        { organizer_id: req.user.id },
        { sort: { starts_on: -1 } },
      ),
      ids = trips.map((t) => t.id);
    const [requests, members] = await Promise.all([
      pool.all("join_requests", { trip_id: { $in: ids } }),
      pool.all("trip_members", { trip_id: { $in: ids } }),
    ]);
    res.json({
      verification: req.user.organizer_verification || "not_submitted",
      trips,
      requests,
      members,
      stats: {
        total: trips.length,
        upcoming: trips.filter(
          (t) => t.starts_on >= travelDate() && t.status === "open",
        ).length,
        completed: trips.filter(
          (t) => t.ends_on < travelDate() && t.status !== "canceled",
        ).length,
        cancelled: trips.filter((t) => t.status === "canceled").length,
        pending: requests.filter((r) => r.status === "pending").length,
        participants: members.length,
      },
    });
  });
  app.patch("/api/organizer/trips/:id", requireUser, async (req, res) => {
    const tripId = id.parse(req.params.id),
      data = z
        .object({
          title: text(3, 65),
          description: text(25, 1200),
          plan: text(0, 2000),
          rules: text(0, 1200),
          category: z.enum([...TRAVEL_STYLES, ...LEGACY_STYLES]),
          departureUtc: z.iso.datetime({ offset: true }),
          timeZone: text(1, 80),
        })
        .parse(req.body);
    try {
      new Intl.DateTimeFormat("en", { timeZone: data.timeZone }).format();
    } catch {
      fail(400, "Choose a valid time zone.");
    }
    await transaction(pool, async (db) => {
      const t = await lockTrip(db, tripId);
      if (!t) fail(404, "Trip not found.");
      if (t.organizer_id !== req.user.id)
        fail(403, "Only this organizer can edit the trip.");
      await lockTravelers(db, [req.user.id]);
      await requireVerified(db, req.user.id);
      if (
        t.status !== "open" ||
        t.starts_on < travelDate() ||
        new Date(data.departureUtc) <= new Date()
      )
        fail(409, "Only upcoming open trips can be edited.");
      if (
        new Intl.DateTimeFormat("en-CA", { timeZone: data.timeZone }).format(
          new Date(data.departureUtc),
        ) !== t.starts_on
      )
        fail(400, "Departure time must match the existing trip date.");
      await db.update(
        "trips",
        { id: tripId },
        {
          $set: {
            title: data.title,
            description: data.description,
            plan: data.plan,
            rules: data.rules,
            category: data.category,
            departure_utc: new Date(data.departureUtc),
            departure_timezone: data.timeZone,
          },
        },
      );
      await audit(db, req.user.id, "trip_edited", tripId);
      for (const m of await db.all("trip_members", { trip_id: tripId }))
        await notify(
          db,
          m.user_id,
          "Your organizer updated the trip. Check the departure time and plan.",
        );
    });
    res.json({ ok: true });
  });
  app.post("/api/organizer/trips/:id/cancel", requireUser, async (req, res) => {
    const tripId = id.parse(req.params.id),
      { reason } = z.object({ reason: text(10, 1000) }).parse(req.body);
    await transaction(pool, async (db) => {
      const t = await lockTrip(db, tripId);
      if (!t) fail(404, "Trip not found.");
      if (t.organizer_id !== req.user.id && !isAdmin(req.user))
        fail(
          403,
          "Only the organizer or an administrator can cancel this trip.",
        );
      if (!isAdmin(req.user)) {
        await lockTravelers(db, [req.user.id]);
        await requireVerified(db, req.user.id);
      }
      if (t.status !== "open" || t.ends_on < travelDate())
        fail(409, "This trip cannot be canceled.");
      await db.update(
        "trips",
        { id: tripId },
        {
          $set: {
            status: "canceled",
            cancellation_reason: reason,
            canceled_at: new Date(),
          },
        },
      );
      await db.updateMany(
        "join_requests",
        { trip_id: tripId, status: "pending" },
        { $set: { status: "rejected" } },
      );
      await audit(db, req.user.id, "trip_canceled", tripId, reason);
      for (const m of await db.all("trip_members", { trip_id: tripId }))
        await notify(db, m.user_id, `Trip canceled: ${reason}`);
    });
    res.json({ ok: true });
  });
  app.delete(
    "/api/organizer/trips/:id/members/:user",
    requireUser,
    async (req, res) => {
      const tripId = id.parse(req.params.id),
        user = id.parse(req.params.user),
        { reason } = z.object({ reason: text(10, 1000) }).parse(req.body);
      await transaction(pool, async (db) => {
        const t = await lockTrip(db, tripId);
        if (!t) fail(404, "Trip not found.");
        if (!isAdmin(req.user) && t.organizer_id !== req.user.id)
          fail(
            403,
            "Only this organizer or an administrator can remove a member.",
          );
        if (user === t.organizer_id && !isAdmin(req.user))
          fail(409, "The organizer must use the leave/handover workflow.");
        if (!isAdmin(req.user)) {
          await lockTravelers(db, [req.user.id]);
          await requireVerified(db, req.user.id);
          if (canCancelParticipation(t) !== true)
            fail(
              409,
              "Contact support for participant removal within 24 hours or when departure time is missing.",
            );
        }
        if (!(await db.one("trip_members", { trip_id: tripId, user_id: user })))
          fail(404, "Active participant not found.");
        await removeMember(db, tripId, user);
        if (user === t.organizer_id) {
          const remaining = await db.all(
            "trip_members",
            { trip_id: tripId },
            { sort: { joined_at: 1, user_id: 1 }, limit: 1 },
          );
          await db.update(
            "trips",
            { id: tripId },
            {
              $set: {
                organizer_id: remaining[0]?.user_id || null,
                ...(remaining[0]?.user_id &&
                t.departure_utc &&
                new Date(t.departure_utc) > new Date()
                  ? { review_organizer_id: remaining[0].user_id }
                  : {}),
              },
            },
          );
          if (remaining[0])
            await notify(
              db,
              remaining[0].user_id,
              "An administrator transferred organizer duties to you. Organizer approval is required before managing requests.",
            );
          else
            await db.updateMany(
              "join_requests",
              { trip_id: tripId, status: "pending" },
              { $set: { status: "rejected" } },
            );
        }
        await db.update(
          "join_requests",
          { trip_id: tripId, user_id: user },
          { $set: { status: "canceled" } },
        );
        await audit(
          db,
          req.user.id,
          isAdmin(req.user)
            ? "admin_participation_override"
            : "participant_removed",
          `${tripId}:${user}`,
          reason,
        );
        await db.insert("cancellation_audit", {
          trip_id: tripId,
          user_id: user,
          actor_id: req.user.id,
          reason,
          override: isAdmin(req.user),
          created_at: new Date(),
        });
        await notify(db, user, `Your participation was ended: ${reason}`);
      });
      res.json({ ok: true });
    },
  );
  app.get("/api/organizers/:id", async (req, res) => {
    const user = id.parse(req.params.id),
      profile = await pool.one("users", { id: user });
    if (!profile) fail(404, "Organizer not found.");
    const reviews = await pool.all(
      "organizer_reviews",
      { organizer_id: user, hidden: { $ne: true } },
      { sort: { created_at: -1 } },
    );
    res.json({
      id: user,
      name: profile.display_name,
      bio: profile.bio || "",
      verified: profile.organizer_verification === "approved",
      average: reviews.length
        ? reviews.reduce((n, r) => n + r.rating, 0) / reviews.length
        : null,
      total: reviews.length,
      distribution: [1, 2, 3, 4, 5].map(
        (star) => reviews.filter((r) => r.rating === star).length,
      ),
      reviews: reviews
        .slice(0, 20)
        .map(
          ({ rating, body, author_name, trip_title, trip_id, created_at }) => ({
            rating,
            body,
            author_name,
            trip_title,
            trip_id,
            created_at,
          }),
        ),
    });
  });
  app.post("/api/trips/:id/organizer-review", requireUser, async (req, res) => {
    const tripId = id.parse(req.params.id),
      data = z
        .object({
          rating: z.number().int().min(1).max(5),
          body: text(10, 1000),
        })
        .parse(req.body);
    await transaction(pool, async (db) => {
      const t = await lockTrip(db, tripId);
      if (
        !t ||
        t.status === "canceled" ||
        t.ends_on >= travelDate() ||
        !(await reviewEligible(db, t, req.user.id))
      )
        fail(403, "Only confirmed travelers can review a completed trip.");
      const organizer = t.review_organizer_id || t.organizer_id || t.owner_id;
      if (organizer === req.user.id) fail(403, "You cannot review yourself.");
      if (
        await db.one("organizer_reviews", {
          trip_id: tripId,
          author_id: req.user.id,
        })
      )
        fail(409, "You already reviewed this trip organizer.");
      await db.insert("organizer_reviews", {
        trip_id: tripId,
        organizer_id: organizer,
        author_id: req.user.id,
        author_name: req.user.display_name,
        trip_title: t.title,
        ...data,
        hidden: false,
      });
    });
    res.status(201).json({ ok: true });
  });
  app.post("/api/feedback", async (req, res) => {
    await throttle(req, `feedback:${req.ip}`, 5);
    const data = z
      .object({
        name: text(2, 100),
        email: z.email().max(254),
        category: z.enum(categories),
        message: text(20, 4000),
        website: z.string().max(100).default(""),
      })
      .parse(req.body);
    if (data.website) fail(400, "Submission could not be accepted.");
    const { website, ...safe } = data;
    await pool.insert("feedback", {
      ...safe,
      user_id: req.user?.id || null,
      status: "New",
      notes: "",
      created_at: new Date(),
    });
    res
      .status(201)
      .json({ ok: true, message: "Your message has been received." });
  });
  app.post("/api/testimonials", requireUser, async (req, res) => {
    await throttle(req, `testimonial:${req.user.id}`, 5);
    const data = z
        .object({
          tripId: id,
          message: text(20, 1000),
          consent: z.literal(true),
        })
        .parse(req.body),
      t = await pool.one("trips", { id: data.tripId });
    if (
      !t ||
      t.status === "canceled" ||
      t.ends_on >= travelDate() ||
      !(await reviewEligible(pool, t, req.user.id))
    )
      fail(403, "A confirmed completed trip is required.");
    await pool.update(
      "testimonials",
      { user_id: req.user.id, trip_id: data.tripId },
      {
        $set: {
          message: data.message,
          consent: true,
          consented_at: new Date(),
          status: "pending",
          featured: false,
          name: req.user.display_name,
          trip_title: t.title,
        },
        $setOnInsert: {
          id: randomUUID(),
          created_at: new Date(),
          user_id: req.user.id,
          trip_id: data.tripId,
        },
      },
      { upsert: true },
    );
    res.status(201).json({ ok: true });
  });
  app.get("/api/testimonials", async (req, res) =>
    res.json({
      testimonials: await pool.all(
        "testimonials",
        { status: "approved", featured: true, consent: true },
        {
          projection: { _id: 0, name: 1, trip_title: 1, message: 1 },
          limit: 12,
        },
      ),
    }),
  );
  app.get("/api/admin/community", requireUser, admin, async (req, res) => {
    const filter = z
      .object({
        category: z.enum(categories).optional(),
        status: z.enum(["New", "In Progress", "Resolved"]).optional(),
      })
      .parse(req.query);
    const offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(100000)
        .parse(req.query.offset || 0),
      page = { sort: { created_at: -1, id: 1 }, skip: offset, limit: 100 };
    const [feedback, testimonials, reviews, auditRows] = await Promise.all([
      pool.all("feedback", filter, page),
      pool.all("testimonials", {}, page),
      pool.all("organizer_reviews", {}, page),
      pool.all("admin_audit", {}, page),
    ]);
    res.json({
      feedback,
      testimonials,
      reviews,
      audit: auditRows,
      offset,
      nextOffset: [feedback, testimonials, reviews, auditRows].some(
        (rows) => rows.length === 100,
      )
        ? offset + 100
        : null,
    });
  });
  app.put("/api/admin/feedback/:id", requireUser, admin, async (req, res) => {
    const subject = id.parse(req.params.id),
      data = z
        .object({
          status: z.enum(["New", "In Progress", "Resolved"]),
          notes: text(0, 4000).default(""),
        })
        .parse(req.body);
    if (!(await pool.one("feedback", { id: subject })))
      fail(404, "Feedback not found.");
    await transaction(pool, async (db) => {
      await db.update("feedback", { id: subject }, { $set: data });
      await audit(db, req.user.id, "feedback_updated", subject);
    });
    res.json({ ok: true });
  });
  app.put(
    "/api/admin/testimonials/:id",
    requireUser,
    admin,
    async (req, res) => {
      const subject = id.parse(req.params.id),
        data = z
          .object({
            status: z.enum(["approved", "rejected", "hidden"]),
            featured: z.boolean(),
          })
          .parse(req.body);
      if (!(await pool.one("testimonials", { id: subject, consent: true })))
        fail(404, "Consented testimonial not found.");
      await transaction(pool, async (db) => {
        await db.update(
          "testimonials",
          { id: subject },
          {
            $set: {
              ...data,
              featured: data.status === "approved" && data.featured,
            },
          },
        );
        await audit(db, req.user.id, "testimonial_" + data.status, subject);
      });
      res.json({ ok: true });
    },
  );
  app.put("/api/admin/reviews/:id", requireUser, admin, async (req, res) => {
    const subject = id.parse(req.params.id),
      data = z
        .object({ hidden: z.boolean(), reason: text(10, 1000) })
        .parse(req.body);
    if (!(await pool.one("organizer_reviews", { id: subject })))
      fail(404, "Review not found.");
    await transaction(pool, async (db) => {
      await db.update("organizer_reviews", { id: subject }, { $set: data });
      await audit(db, req.user.id, "review_moderated", subject, data.reason);
    });
    res.json({ ok: true });
  });
}
