import test from "node:test";
import assert from "node:assert/strict";
import { createPlacesAutocomplete } from "../places.js";
import { createApp } from "../app.js";

test("Places New sends only city text and keeps credentials in server headers", async () => {
  let sent;
  const suggest = createPlacesAutocomplete({
    apiKey: "private-key",
    fetchImpl: async (url, options) => {
      sent = { url, options };
      return {
        ok: true,
        json: async () => ({
          suggestions: [
            {
              placePrediction: {
                text: { text: "Jawalamukhi, Himachal Pradesh, India" },
                structuredFormat: { mainText: { text: "Jawalamukhi" } },
              },
            },
            { queryPrediction: { text: { text: "ignore" } } },
          ],
        }),
      };
    },
  });
  assert.deepEqual(await suggest("jawa"), [
    { value: "Jawalamukhi", label: "Jawalamukhi, Himachal Pradesh, India" },
  ]);
  assert.equal(
    sent.url,
    "https://places.googleapis.com/v1/places:autocomplete",
  );
  assert.equal(sent.options.headers["X-Goog-Api-Key"], "private-key");
  assert.deepEqual(JSON.parse(sent.options.body), {
    input: "jawa",
    includedPrimaryTypes: ["(cities)"],
    languageCode: "en",
    regionCode: "in",
    locationBias: {
      rectangle: {
        low: { latitude: 6, longitude: 68 },
        high: { latitude: 37.6, longitude: 97.5 },
      },
    },
  });
  assert(!JSON.stringify(await suggest("jawa")).includes("private-key"));
});
test("Places disabled without a key and provider error details stay private", async () => {
  assert.equal(createPlacesAutocomplete({ apiKey: "" }), null);
  const suggest = createPlacesAutocomplete({
    apiKey: "secret",
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "secret" }),
    }),
  });
  await assert.rejects(() => suggest("jawa"), {
    message: "PLACES_UNAVAILABLE",
  });
});
for (const mode of ["google", "empty", "fallback", "rate-limit"])
  test(`location API: ${mode}`, async () => {
    let calls = 0,
      limits = 0;
    const pool = {
      change: async () => ({
        attempts: mode === "rate-limit" ? 9999 : ++limits,
      }),
      all: async (name) =>
        name === "location_catalog" ? [{ name: "Jaipur" }] : [],
    };
    const app = createApp(pool, {
      production: false,
      placesAdapter: async () => {
        calls++;
        if (mode === "fallback") throw new Error("secret failure");
        return [{ value: "Jawalamukhi", label: "Jawalamukhi, India" }];
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/locations?q=${mode === "empty" ? "j" : "ja"}`,
      );
      const body = await response.json();
      assert.equal(response.status, mode === "rate-limit" ? 429 : 200);
      if (mode === "google") {
        assert.equal(body.provider, "google");
        assert.deepEqual(body.locations, ["Jawalamukhi"]);
        assert.equal(body.suggestions[0].label, "Jawalamukhi, India");
      }
      if (mode === "empty") {
        assert.equal(calls, 0);
        assert.deepEqual(body.locations, []);
        assert.equal(limits, 0);
      }
      if (mode === "rate-limit") assert.equal(calls, 0);
      if (mode === "fallback") {
        assert.equal(body.provider, "local");
        assert.deepEqual(body.locations, ["Jaipur"]);
        assert.match(body.message, /temporarily unavailable/);
        assert(!JSON.stringify(body).includes("secret failure"));
      }
      assert.match(response.headers.get("cache-control"), /no-store/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
