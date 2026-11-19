import { randomUUID } from "node:crypto";
import { indexTripLocation, saveTripLocation } from "./geo-index.js";
import { transaction, lockTrip } from "./db.js";
import { travelDate } from "./travel-rules.js";
const DAY = 86400000;
export async function refreshLocationBatch(
  pool,
  { resolver, limit = 25, now = new Date(), refreshAheadMs = 3 * DAY } = {},
) {
  if (!resolver)
    return {
      skipped: "not_configured",
      processed: 0,
      indexed: 0,
      unresolved: 0,
    };
  if (!Number.isInteger(limit) || limit < 1 || limit > 25)
    throw Error("Invalid maintenance batch size.");
  const owner = randomUUID();
  try {
    await pool.change(
      "system_jobs",
      { id: "location-refresh", expires_at: { $lte: now } },
      { $set: { owner, expires_at: new Date(+now + 10 * 60000) } },
      { upsert: true },
    );
  } catch (e) {
    if (e.code === 11000)
      return {
        skipped: "already_running",
        processed: 0,
        indexed: 0,
        unresolved: 0,
      };
    throw e;
  }
  const result = { processed: 0, indexed: 0, unresolved: 0 };
  try {
    const candidates = await pool.database
      .collection("trips")
      .aggregate([
        {
          $match: {
            status: "open",
            ends_on: { $gte: travelDate(now) },
            $or: [
              { location_refresh_after: { $exists: false } },
              { location_refresh_after: { $lte: now } },
            ],
          },
        },
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
              { "geo.unresolved_fields.0": { $exists: true } },
              { "geo.expires_at": { $lte: new Date(+now + refreshAheadMs) } },
            ],
          },
        },
        { $sort: { location_refresh_after: 1, starts_on: 1, id: 1 } },
        { $limit: limit },
      ])
      .toArray();
    for (const trip of candidates) {
      const r = await indexTripLocation(pool, trip, {
        resolver,
        persist: false,
      });
      const saved = await transaction(pool, async (db) => {
        // Touch the trip so simultaneous edits cannot leave an outdated location index.
        const current = await lockTrip(db, trip.id);
        const fields = [
          "from_city",
          "destination",
          "from_place_id",
          "destination_place_id",
        ];
        if (
          !current ||
          current.status !== "open" ||
          fields.some((f) => current[f] !== trip[f])
        )
          return;
        await saveTripLocation(db, r.record);
        await db.update(
          "trips",
          { id: trip.id },
          {
            $set: {
              location_refresh_after: new Date(
                +now + (r.missing.length ? 6 * 3600000 : 26 * DAY),
              ),
            },
          },
        );
        return true;
      });
      if (saved) {
        result.processed++;
        if (r.indexed) result.indexed++;
        if (r.missing.length) result.unresolved++;
      }
    }
    return result;
  } finally {
    await pool.remove("system_jobs", { id: "location-refresh", owner });
  }
}
export function startLocationMaintenance(
  pool,
  {
    resolver,
    enabled = process.env.LOCATION_REFRESH_ENABLED !== "false",
    intervalMs = 3600000,
    logger = console,
  } = {},
) {
  if (!enabled || !resolver) return () => {};
  let stopped = false,
    running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      logger.info(
        "LOCATION_REFRESH",
        JSON.stringify(await refreshLocationBatch(pool, { resolver })),
      );
    } catch {
      logger.error("LOCATION_REFRESH_FAILED");
    } finally {
      running = false;
    }
  };
  // Run after startup without delaying health checks. Lease coordinates ECS replicas.
  const first = setTimeout(tick, 15000);
  first.unref();
  const interval = setInterval(tick, intervalMs);
  interval.unref();
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(interval);
  };
}
