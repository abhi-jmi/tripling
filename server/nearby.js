import { z } from "zod";
import { createPlacesAutocomplete } from "./places.js";
import { travelDate } from "./travel-rules.js";
const coordinates = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export function distanceKm(a, b) {
  const rad = (n) => (n * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude),
    dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) *
      Math.cos(rad(b.latitude)) *
      Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function createCityResolver({
  apiKey = process.env.GOOGLE_PLACES_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) return null;
  const suggest = createPlacesAutocomplete({ apiKey, fetchImpl });
  return async (name, placeId = "") => {
    if (!placeId) {
      const matches = (await suggest(name)).filter(
        (s) =>
          s.value.localeCompare(name, "en", { sensitivity: "base" }) === 0 &&
          s.placeId,
      );
      if (matches.length !== 1) throw new Error("CITY_NOT_FOUND");
      placeId = matches[0].placeId;
    }
    const response = await fetchImpl(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
      {
        headers: {
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "location,formattedAddress,types,id",
        },
        signal: AbortSignal.timeout(4000),
      },
    );
    if (!response.ok) throw new Error("CITY_LOOKUP_UNAVAILABLE");
    const place = await response.json();
    if (
      !place.types?.some((t) =>
        ["locality", "administrative_area_level_3", "postal_town"].includes(t),
      )
    )
      throw new Error("CITY_NOT_FOUND");
    return {
      ...coordinates.parse(place.location),
      label: String(place.formattedAddress || name),
      placeId: place.id || placeId,
    };
  };
}
export function registerNearbyRoutes(app, pool, { throttle, cityResolver }) {
  // Google coordinate caching is limited to 29 days. Expired values are never
  // used while MongoDB's TTL cleanup catches up. Predictions are not cached.
  const pending = new Map();
  async function locate(req, name, placeId = "") {
    const key = placeId ? "id:" + placeId : "city:" + name.trim().toLowerCase();
    const cached = await pool.one("place_coordinates", {
      key,
      expires_at: { $gt: new Date() },
    });
    if (cached) return cached;
    if (pending.has(key)) return pending.get(key);
    const lookup = (async () => {
      await throttle(req, `geo-ip:${req.ip}`, 120);
      await throttle(req, "geo-total", 2000);
      const value = await cityResolver(name, placeId);
      coordinates.parse(value);
      const record = {
        ...value,
        key,
        expires_at: new Date(Date.now() + 29 * 86400000),
      };
      try {
        await pool.update(
          "place_coordinates",
          { key },
          { $set: record },
          { upsert: true },
        );
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
      return record;
    })();
    pending.set(key, lookup);
    try {
      return await lookup;
    } finally {
      pending.delete(key);
    }
  }
  app.get("/api/trips/nearby", async (req, res) => {
    const query = z
      .object({
        q: z.string().trim().max(60).default(""),
        radius: z.coerce
          .number()
          .pipe(z.union([z.literal(25), z.literal(50), z.literal(100)]))
          .default(50),
        field: z.enum(["origin", "destination"]).default("destination"),
        lat: z.coerce.number().min(-90).max(90).optional(),
        lng: z.coerce.number().min(-180).max(180).optional(),
        placeId: z
          .string()
          .regex(/^[a-zA-Z0-9_-]{1,250}$/)
          .optional(),
      })
      .refine(
        (v) =>
          (v.lat !== undefined && v.lng !== undefined) ||
          (v.lat === undefined && v.lng === undefined && v.q.length >= 2),
        "Provide a city or valid latitude and longitude together.",
      )
      .parse(req.query);
    if (!cityResolver)
      return res
        .status(503)
        .json({
          error:
            "Nearby search needs Google Places. Exact city search is still available.",
        });
    await throttle(req, `nearby:${req.ip}`, 60);
    let center;
    try {
      center =
        query.lat !== undefined
          ? {
              latitude: query.lat,
              longitude: query.lng,
              label: query.q || "Selected location",
            }
          : await locate(req, query.q, query.placeId);
    } catch (error) {
      if (error.status === 429) throw error;
      return res
        .status(503)
        .json({
          error:
            "Could not locate this city. Choose a city suggestion or use exact city search.",
        });
    }
    const [trips, hidden] = await Promise.all([
      pool.all(
        "trips",
        { status: "open", ends_on: { $gte: travelDate() } },
        {
          projection: {
            id: 1,
            destination: 1,
            destination_place_id: 1,
            from_city: 1,
            from_place_id: 1,
            starts_on: 1,
          },
          sort: { starts_on: 1, id: 1 },
        },
      ),
      req.user ? pool.all("hidden_trips", { user_id: req.user.id }) : [],
    ]);
    const visible = trips
      .filter((t) => !hidden.some((h) => h.trip_id === t.id))
      .map((t) =>
        query.field === "origin"
          ? {
              ...t,
              destination: t.from_city,
              destination_place_id: t.from_place_id,
            }
          : t,
      );
    const groups = new Map();
    for (const t of visible) {
      if (!t.destination) continue;
      const key = t.destination_place_id
        ? "id:" + t.destination_place_id
        : t.destination.toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const results = [];
    let unresolved = 0;
    const cities = [...groups.values()];
    // Bound provider calls/latency for the current bootstrap-sized catalog.
    // Return an explicit partial-results notice instead of inventing distances.
    for (let i = 0; i < Math.min(cities.length, 30); i += 5) {
      await Promise.all(
        cities.slice(i, Math.min(i + 5, 30)).map(async (group) => {
          const t = group[0];
          let point;
          try {
            point =
              (query.placeId && t.destination_place_id === query.placeId) ||
              (query.lat === undefined &&
                !query.placeId &&
                !t.destination_place_id &&
                t.destination.toLowerCase() === query.q.toLowerCase())
                ? center
                : await locate(req, t.destination, t.destination_place_id);
          } catch {
            unresolved++;
            return;
          }
          const km = distanceKm(center, point);
          if (km <= query.radius)
            for (const item of group)
              results.push({
                id: item.id,
                distanceKm: Math.round(km * 10) / 10,
              });
        }),
      );
    }
    unresolved += Math.max(0, cities.length - 30);
    results.sort(
      (a, b) => a.distanceKm - b.distanceKm || a.id.localeCompare(b.id),
    );
    res.json({
      field: query.field,
      center: center.label,
      radiusKm: query.radius,
      results,
      partial: unresolved > 0,
      unresolvedCities: unresolved,
      attribution: "Google Maps",
      distanceType: "straight-line",
    });
  });
}
