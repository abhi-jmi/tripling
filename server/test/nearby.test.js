import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { distanceKm, createCityResolver } from "../nearby.js";
const places = {
  Manali: {
    latitude: 32.2432,
    longitude: 77.1892,
    label: "Manali, Himachal Pradesh, India",
  },
  Kullu: { latitude: 31.9579, longitude: 77.1095, label: "Kullu" },
  Delhi: { latitude: 28.6139, longitude: 77.209, label: "Delhi" },
};
test("50 km boundary uses spherical distance, not text similarity", () => {
  assert.equal(distanceKm(places.Manali, places.Manali), 0);
  assert(distanceKm(places.Manali, places.Kullu) < 50);
  assert(distanceKm(places.Manali, places.Delhi) > 400);
  assert(
    Math.abs(
      distanceKm(places.Manali, places.Kullu) -
        distanceKm(places.Kullu, places.Manali),
    ) < 1e-9,
  );
});
test("city resolver uses city predictions and place details, and rejects ambiguous names", async () => {
  const calls = [];
  const resolve = createCityResolver({
    apiKey: "private",
    fetchImpl: async (url, opts) => {
      calls.push(url);
      if (url.endsWith(":autocomplete"))
        return {
          ok: true,
          json: async () => ({
            suggestions: [
              {
                placePrediction: {
                  placeId: "manali-id",
                  text: { text: "Manali, HP, India" },
                  structuredFormat: { mainText: { text: "Manali" } },
                },
              },
            ],
          }),
        };
      assert.equal(opts.headers["X-Goog-Api-Key"], "private");
      return {
        ok: true,
        json: async () => ({
          location: places.Manali,
          formattedAddress: "Manali, HP, India",
          types: ["locality"],
          id: "manali-id",
        }),
      };
    },
  });
  assert.equal((await resolve("Manali")).latitude, places.Manali.latitude);
  assert.equal(calls.length, 2);
  await assert.rejects(() => resolve("Unknown"), /CITY_NOT_FOUND/);
});
for (const mode of [
  "nearby",
  "25km",
  "cached",
  "expired",
  "partial",
  "disabled",
  "ambiguous",
  "invalid",
  "origin",
  "coordinates",
  "bad-coordinates",
])
  test(`nearby API: ${mode}`, async () => {
    let lookups = 0;
    const cache = new Map();
    if (mode === "cached" || mode === "expired")
      cache.set("city:manali", {
        ...places.Manali,
        key: "city:manali",
        expires_at: new Date(
          Date.now() + (mode === "cached" ? 100000 : -100000),
        ),
      });
    const pool = {
      one: async (name, filter) => {
        const v = cache.get(filter.key);
        return v && v.expires_at > filter.expires_at.$gt ? v : null;
      },
      change: async () => ({ attempts: 1 }),
      update: async (name, filter, update) =>
        cache.set(filter.key, update.$set),
      all: async (name) =>
        name === "trips"
          ? [
              { id: "manali", destination: "Manali", from_city: "Manali" },
              { id: "kullu", destination: "Kullu", from_city: "Kullu" },
              { id: "delhi", destination: "Delhi", from_city: "Delhi" },
            ]
          : [],
    };
    const app = createApp(pool, {
      production: false,
      placesAdapter: null,
      cityResolver:
        mode === "disabled"
          ? null
          : async (name) => {
              lookups++;
              if (
                mode === "ambiguous" ||
                (mode === "partial" && name === "Kullu")
              )
                throw Error("provider private-key");
              return places[name];
            },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/trips/nearby?q=Manali&radius=${mode === "25km" ? 25 : mode === "invalid" ? -1 : 50}${mode === "origin" ? "&field=origin" : mode === "coordinates" ? `&lat=${places.Manali.latitude}&lng=${places.Manali.longitude}` : mode === "bad-coordinates" ? "&lat=91&lng=0" : ""}`,
      );
      const body = await response.json();
      assert.equal(
        response.status,
        ["disabled", "ambiguous"].includes(mode)
          ? 503
          : ["invalid", "bad-coordinates"].includes(mode)
            ? 400
            : 200,
      );
      if (response.ok) {
        assert.deepEqual(
          body.results.map((r) => r.id),
          ["25km", "partial"].includes(mode) ? ["manali"] : ["manali", "kullu"],
        );
        assert.equal(body.partial, mode === "partial");
        assert.equal(body.distanceType, "straight-line");
        assert.equal(lookups, mode === "cached" ? 2 : 3);
      }
      assert(!JSON.stringify(body).includes("private-key"));
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
