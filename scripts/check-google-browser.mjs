// Local-only browser flow with an injected Google provider; never contacts Google.
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { createDatabase } from "../server/db.js";
import { migrate } from "../server/migrate.js";
import { publishLegalDocuments } from "../server/legal.js";
import { hashPassword } from "../server/auth.js";
import { createApp } from "../server/app.js";
if (
  !/^mongodb:\/\/(127\.0\.0\.1|localhost):/.test(
    process.env.TEST_MONGODB_URI || "",
  ) ||
  !process.env.TEST_MONGODB_DATABASE?.endsWith("_test")
)
  throw Error("Use an explicit local test database.");
const db = await createDatabase({
  MONGODB_URI: process.env.TEST_MONGODB_URI,
  MONGODB_DATABASE: process.env.TEST_MONGODB_DATABASE,
  NODE_ENV: "test",
});
await migrate(db);
await publishLegalDocuments(db, { NODE_ENV: "test" });
const stamp = Date.now(),
  email = `google-browser-${stamp}@example.test`;
const user = await db.insert("users", {
  email,
  first_name: "Existing",
  last_name: "Traveler",
  display_name: "Existing Traveler",
  password_hash: await hashPassword("My existing browser password!"),
  city: "Delhi",
  adult_confirmed: true,
  gender: "woman",
});
const trip = await db.insert("trips", {
  owner_id: user.id,
  organizer_id: user.id,
  title: `An existing trip ${stamp}`,
  from_city: "Delhi",
  destination: "Manali",
  starts_on: "2099-01-01",
  ends_on: "2099-01-03",
  budget_min: 1000,
  budget_max: 4000,
  capacity: 6,
  existing_travelers: 1,
  category: "Adventure",
  mode: "Train",
  women_only: false,
});
await db.insert("saved_trips", { user_id: user.id, trip_id: trip.id });
await db.insert("trip_members", { user_id: user.id, trip_id: trip.id });
let claims = { sub: "browser-google-" + stamp, email, email_verified: true };
const server = createApp(db, {
  production: false,
  placesAdapter: null,
  cityResolver: null,
  googleAdapter: {
    authorize: async ({ redirectUri, state }) =>
      redirectUri + "?" + new URLSearchParams({ state, code: "local-fixture" }),
    exchange: async (url, flow) => {
      assert(flow.nonce && flow.verifier);
      return claims;
    },
  },
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
      viewport: { width: 1400, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/?fixture=" + stamp + "#login");
  await page.locator("#google-signin:not([hidden])").waitFor();
  await page.locator("#google-signin").click();
  await page.waitForURL("**/#discover");
  await page.locator(".profile-button:not([hidden])").waitFor();
  assert.equal(
    (await (await page.request.get(origin + "/api/auth/session")).json()).user
      .id,
    user.id,
  );
  assert.equal(new URL(page.url()).searchParams.has("auth_error"), false);
  await page.locator('[data-view="my-trips"]').first().click();
  await page.getByRole("button", { name: trip.title, exact: true }).waitFor();
  await page.reload();
  await page.locator("#app-loading").waitFor({ state: "hidden" });
  assert.equal(new URL(page.url()).hash, "#my-trips");
  assert(await page.locator("#login-page").isHidden());
  await page.locator('[data-view="saved"]').first().click();
  await page.getByRole("button", { name: trip.title, exact: true }).waitFor();
  await page.locator(".profile-button").click();
  await page.getByText("Google connected", { exact: true }).waitFor();
  assert.equal(
    await page.locator('#profile-form [name="firstName"]').inputValue(),
    "Existing",
  );
  await page.locator(".modal-close").click();
  await page.request.post(origin + "/api/auth/logout", {
    headers: { Origin: origin },
    data: {},
  });
  await page.goto(origin + "/?fixture=" + stamp + "#login");
  await page.locator("#google-signin:not([hidden])").waitFor();
  await page.locator("#google-signin").click();
  await page.waitForURL("**/#discover");
  await page.locator(".profile-button:not([hidden])").waitFor();
  assert.equal(
    (await (await page.request.get(origin + "/api/auth/session")).json()).user
      .id,
    user.id,
  );
  assert.equal(await db.count("users", { email }), 1);
  assert.equal(await db.count("oauth_identities", { user_id: user.id }), 1);
  await page.request.post(origin + "/api/auth/logout", {
    headers: { Origin: origin },
    data: {},
  });
  claims = { ...claims, email_verified: false };
  await page.goto(origin + "/?fixture=" + stamp + "#login");
  await page.locator("#google-signin:not([hidden])").waitFor();
  await page.locator("#google-signin").click();
  await page.locator("#login-error:not([hidden])").waitFor();
  assert(
    (await page.locator("#login-error").innerText()).includes(
      "could not be verified",
    ),
  );
  assert.equal(
    (await (await page.request.get(origin + "/api/auth/session")).json()).user,
    null,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Google browser checks passed: matching-email sign-in, preserved account/trips/saves, linked profile, refresh, repeat sign-in and unverified-claim rejection.",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  await db.close();
}
