import { createCityResolver } from "./nearby.js";
export async function indexTripLocation(
  db,
  trip,
  { resolver = createCityResolver(), requiredOrigin = false } = {},
) {
  if (!resolver) {
    if (requiredOrigin)
      throw Object.assign(
        new Error(
          "Google Places must be configured to confirm the starting location.",
        ),
        { status: 503 },
      );
    return { indexed: false };
  }
  const record = {
      trip_id: trip.id,
      expires_at: new Date(Date.now() + 29 * 86400000),
    },
    missing = [];
  for (const [field, name, placeId] of [
    ["origin", trip.from_city, trip.from_place_id],
    ["destination", trip.destination, trip.destination_place_id],
  ]) {
    try {
      const p = await resolver(name, placeId || "");
      if (
        !Number.isFinite(p.latitude) ||
        !Number.isFinite(p.longitude) ||
        Math.abs(p.latitude) > 90 ||
        Math.abs(p.longitude) > 180
      )
        throw Error("INVALID_POINT");
      record[field] = { type: "Point", coordinates: [p.longitude, p.latitude] };
      record[field + "_label"] = p.label;
      record[field + "_state"] = p.state || "";
      record[field + "_city"] = p.city || name;
    } catch (error) {
      missing.push(field);
      if (field === "origin" && requiredOrigin)
        throw Object.assign(
          new Error("Select a valid starting city from Google suggestions."),
          { status: 400 },
        );
    }
  }
  record.unresolved_fields = missing;
  if (!record.origin && !record.destination)
    record.expires_at = new Date(Date.now() + 15 * 60000);
  // Persist failed attempts briefly so an ambiguous first page cannot starve
  // later trips in the next maintenance batch. No fabricated point is stored.
  await db.update(
    "trip_locations",
    { trip_id: trip.id },
    {
      $set: record,
      $unset: Object.fromEntries(
        missing
          .flatMap((f) => [f, f + "_label", f + "_state", f + "_city"])
          .map((f) => [f, ""]),
      ),
    },
    { upsert: true },
  );
  return { indexed: !!record.origin || !!record.destination, missing, record };
}
