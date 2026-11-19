import { z } from "zod";
import { transaction, lockTrip } from "./db.js";
import { httpError } from "./travel-rules.js";
export const tripCollections = [
  "trip_members",
  "trip_participants",
  "join_requests",
  "saved_trips",
  "messages",
  "hidden_trips",
  "notifications",
  "reviews",
  "organizer_reviews",
  "testimonials",
  "trip_locations",
];
const projection = {
  _id: 0,
  id: 1,
  title: 1,
  from_city: 1,
  destination: 1,
  starts_on: 1,
  ends_on: 1,
  status: 1,
  revision: 1,
  moderation_hidden: 1,
};
export function registerAdminTrips(app, pool) {
  // Registered after /api/admin's authentication, admin-role and mutation throttle.
  app.get("/api/admin/trips", async (req, res) => {
    const q = z
      .object({
        tripQuery: z.string().trim().max(100).default(""),
        tripOffset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .parse(req.query);
    const literal = new RegExp(
      q.tripQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i",
    );
    const filter = q.tripQuery
      ? {
          $or: [
            { id: q.tripQuery },
            { title: literal },
            { destination: literal },
            { from_city: literal },
          ],
        }
      : {};
    const [trips, total] = await Promise.all([
      pool.all("trips", filter, {
        projection,
        sort: { created_at: -1, id: 1 },
        limit: 25,
        skip: q.tripOffset,
      }),
      pool.count("trips", filter),
    ]);
    res.json({
      trips,
      total,
      offset: q.tripOffset,
      nextOffset:
        q.tripOffset + trips.length < total
          ? q.tripOffset + trips.length
          : null,
    });
  });
  app.get("/api/admin/trips/:id", async (req, res) => {
    const id = z.uuid().parse(req.params.id),
      trip = await pool.one("trips", { id }, { projection });
    if (!trip) throw httpError(404, "Trip not found.");
    res.json({ trip: { ...trip, revision: trip.revision || 0 } });
  });
  app.delete("/api/admin/trips/:id", async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const input = z
      .object({
        confirmationTripId: z.uuid(),
        reason: z.string().trim().min(10).max(2000),
        revision: z.number().int().min(0),
      })
      .parse(req.body);
    if (input.confirmationTripId !== id)
      throw httpError(400, "Type the exact trip ID to confirm deletion.");
    await transaction(pool, async (db) => {
      const trip = await lockTrip(db, id);
      if (!trip)
        throw httpError(
          404,
          "Trip not found. It may already have been deleted.",
        );
      if ((trip.revision || 0) !== input.revision)
        throw httpError(
          409,
          "This trip changed. Reopen the deletion confirmation before continuing.",
        );
      const members = await db.all("trip_members", { trip_id: id });
      const pending = await db.all("join_requests", {
        trip_id: id,
        status: "pending",
      });
      const recipients = [
        ...new Set(
          [
            trip.owner_id,
            trip.organizer_id,
            ...members.map((m) => m.user_id),
            ...pending.map((r) => r.user_id),
          ].filter(Boolean),
        ),
      ];
      const deletedCounts = {};
      for (const collection of tripCollections)
        deletedCounts[collection] = (
          await db.removeMany(collection, { trip_id: id })
        ).deletedCount;
      // The trip's shared statement stops being shared; personal blocking survives.
      await db.updateMany(
        "user_blocks",
        { context_trip_id: id },
        { $set: { context_trip_id: null, notice_hidden: true } },
      );
      await db.remove("trips", { id });
      await db.insert("admin_audit", {
        actor_id: req.user.id,
        action: "trip_deleted",
        subject: id,
        reason: input.reason,
        trip_title: trip.title,
        owner_id: trip.owner_id,
        previous_status: trip.status,
        deleted_counts: deletedCounts,
      });
      for (const user of recipients)
        await db.insert("notifications", {
          user_id: user,
          trip_id: null,
          body: `An administrator removed “${trip.title}” (trip ${id}). Contact support if you have questions.`,
          type: "trip_deleted",
        });
    });
    res.json({ ok: true, deletedTripId: id });
  });
}
