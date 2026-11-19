import { z } from "zod";
import { isAdmin } from "./roles.js";
import { travelDate, httpError } from "./travel-rules.js";
const pattern = (text) =>
  new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
const querySchema = z.object({
  view: z
    .enum(["all", "discover", "past-trips", "my-trips", "saved", "reviewable"])
    .default("discover"),
  q: z.string().trim().max(60).default(""),
  origin: z.string().trim().max(60).default(""),
  when: z.iso.date().optional(),
  style: z.string().max(60).optional(),
  category: z.string().max(60).optional(),
  mode: z.string().max(40).optional(),
  budget: z.coerce.number().min(0).max(1000000).optional(),
  women: z.enum(["true", "false"]).optional(),
  lifecycle: z
    .enum(["all", "upcoming", "ongoing", "completed", "canceled"])
    .default("all"),
  sort: z.enum(["date", "budget"]).default("date"),
  limit: z.coerce.number().int().min(1).max(100).default(6),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  ids: z
    .string()
    .max(3700)
    .optional()
    .transform((v) => (v === undefined ? undefined : v.split(",")))
    .pipe(z.array(z.uuid()).max(100).optional()),
});
export function createTripFeed(
  pool,
  { serialize, userMap, organizerVerificationRequired },
) {
  async function present(records, id) {
    if (!records.length) return [];
    const ids = records.map((t) => t.id),
      organizers = records.map((t) => t.organizer_id).filter(Boolean);
    const [members, participants, reviews, users, reputation] =
      await Promise.all([
        pool.all("trip_members", { trip_id: { $in: ids } }),
        id
          ? pool.all("trip_participants", {
              trip_id: { $in: ids },
              user_id: id,
            })
          : [],
        pool.database
          .collection("reviews")
          .aggregate([
            { $match: { trip_id: { $in: ids } } },
            {
              $group: {
                _id: "$trip_id",
                average: { $avg: "$rating" },
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),
        userMap(
          pool,
          records.flatMap((t) => [t.owner_id, t.organizer_id]),
        ),
        pool.database
          .collection("organizer_reviews")
          .aggregate([
            {
              $match: {
                organizer_id: { $in: organizers },
                hidden: { $ne: true },
              },
            },
            {
              $group: {
                _id: "$organizer_id",
                average: { $avg: "$rating" },
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),
      ]);
    const rep = new Map(reputation.map((r) => [r._id, r])),
      ratings = new Map(reviews.map((r) => [r._id, r]));
    return records.map((t) =>
      serialize({
        ...t,
        organizer_rating: rep.get(t.organizer_id)?.average,
        organizer_review_count: rep.get(t.organizer_id)?.count,
        host_verified:
          organizerVerificationRequired &&
          users.get(t.organizer_id)?.organizer_verification === "approved",
        host: users.get(t.organizer_id)?.display_name || "No active organizer",
        creator: users.get(t.owner_id)?.display_name || "Former traveler",
        member_count: members.filter((m) => m.trip_id === t.id).length,
        is_member: members.some((m) => m.trip_id === t.id && m.user_id === id),
        participated: participants.some((p) => p.trip_id === t.id),
        review_count: ratings.get(t.id)?.count || 0,
        average_rating: ratings.has(t.id)
          ? Math.round(ratings.get(t.id).average * 10) / 10
          : null,
      }),
    );
  }
  async function load(input, user) {
    const q = querySchema.parse(input),
      id = user?.id,
      day = travelDate(),
      clauses = [];
    if (["my-trips", "saved", "reviewable"].includes(q.view) && !id)
      throw httpError(401, "Please log in first.");
    const [participants, memberships, requests, saved, hidden] = id
      ? await Promise.all([
          pool.all(
            "trip_participants",
            { user_id: id },
            {
              projection: {
                _id: 0,
                trip_id: 1,
                first_joined_at: 1,
                left_at: 1,
              },
            },
          ),
          pool.all(
            "trip_members",
            { user_id: id },
            { projection: { _id: 0, trip_id: 1 } },
          ),
          pool.all(
            "join_requests",
            { user_id: id, status: { $in: ["pending", "accepted"] } },
            { projection: { _id: 0, trip_id: 1 } },
          ),
          q.view === "saved" ? pool.all("saved_trips", { user_id: id }) : [],
          pool.all("hidden_trips", { user_id: id }),
        ])
      : [[], [], [], [], []];
    const personal = [
      ...new Set([...participants, ...memberships].map((p) => p.trip_id)),
    ];
    const owned = id
      ? {
          $or: [
            { owner_id: id },
            { organizer_id: id },
            { id: { $in: personal } },
          ],
        }
      : { id: { $in: [] } };
    if (["my-trips", "all", "saved", "reviewable"].includes(q.view))
      clauses.push({ $or: [{ moderation_hidden: { $ne: true } }, owned] });
    else clauses.push({ moderation_hidden: { $ne: true } });
    if (q.view === "my-trips")
      clauses.push({
        $or: [owned, { id: { $in: requests.map((r) => r.trip_id) } }],
      });
    if (q.view === "saved")
      clauses.push({ id: { $in: saved.map((r) => r.trip_id) } });
    if (q.view === "reviewable") {
      const date = (value) =>
        new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
          new Date(value),
        );
      const eligible = participants
        .filter(
          (p) =>
            p.first_joined_at &&
            Number.isFinite(+new Date(p.first_joined_at)) &&
            (!p.left_at || Number.isFinite(+new Date(p.left_at))),
        )
        .map((p) => ({
          id: p.trip_id,
          ends_on: { $gte: date(p.first_joined_at) },
          ...(p.left_at ? { starts_on: { $lte: date(p.left_at) } } : {}),
        }));
      clauses.push({
        status: "open",
        ends_on: { $lt: day },
        ...(eligible.length ? { $or: eligible } : { id: { $in: [] } }),
      });
    }
    if (q.view === "discover")
      clauses.push({
        status: "open",
        ends_on: { $gte: day },
        id: { $nin: hidden.map((h) => h.trip_id) },
      });
    if (q.view === "past-trips")
      clauses.push({
        ends_on: { $lt: day },
        id: { $nin: hidden.map((h) => h.trip_id) },
      });
    if (q.view === "all")
      clauses.push({
        $or: [{ id: { $nin: hidden.map((h) => h.trip_id) } }, owned],
      });
    if (q.ids) clauses.push({ id: { $in: q.ids } });
    if (q.q)
      clauses.push({
        $or: [{ destination: pattern(q.q) }, { title: pattern(q.q) }],
      });
    if (q.origin) clauses.push({ from_city: pattern(q.origin) });
    if (q.when)
      clauses.push({ starts_on: { $lte: q.when }, ends_on: { $gte: q.when } });
    if (q.style) clauses.push({ category: q.style });
    if (q.category) clauses.push({ category: q.category });
    if (q.mode) clauses.push({ mode: pattern(q.mode) });
    if (q.budget !== undefined)
      clauses.push({ budget_min: { $lte: q.budget } });
    if (q.women === "true") clauses.push({ women_only: true });
    if (q.lifecycle === "canceled") clauses.push({ status: "canceled" });
    if (q.lifecycle === "completed")
      clauses.push({ status: { $ne: "canceled" }, ends_on: { $lt: day } });
    if (q.lifecycle === "upcoming")
      clauses.push({ status: { $ne: "canceled" }, starts_on: { $gt: day } });
    if (q.lifecycle === "ongoing")
      clauses.push({
        status: { $ne: "canceled" },
        starts_on: { $lte: day },
        ends_on: { $gte: day },
      });
    const filter = { $and: clauses },
      sort =
        q.sort === "budget"
          ? { budget_min: 1, starts_on: 1, id: 1 }
          : { starts_on: 1, id: 1 };
    const [records, total] = await Promise.all([
      pool.all("trips", filter, { sort, limit: q.limit, skip: q.offset }),
      pool.count("trips", filter),
    ]);
    return {
      trips: await present(records, id),
      total,
      offset: q.offset,
      nextOffset:
        q.offset + records.length < total ? q.offset + records.length : null,
    };
  }
  async function detail(id, user) {
    z.uuid().parse(id);
    const trip = await pool.one("trips", { id });
    if (!trip) throw httpError(404, "Trip not found.");
    if (
      trip.moderation_hidden &&
      !isAdmin(user) &&
      (!user ||
        !(
          trip.owner_id === user.id ||
          trip.organizer_id === user.id ||
          (await pool.one("trip_participants", {
            trip_id: id,
            user_id: user.id,
          })) ||
          (await pool.one("trip_members", { trip_id: id, user_id: user.id }))
        ))
    )
      throw httpError(404, "Trip not available.");
    return (await present([trip], user?.id))[0];
  }
  return { load, detail };
}
