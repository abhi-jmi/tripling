// Exercises real local API/database flows with a captured test outbox; sends no email.
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { createDatabase } from "../server/db.js";
const origin = process.env.TRIPLING_TEST_ORIGIN || "http://127.0.0.1:3119";
if (
  new URL(origin).hostname !== "127.0.0.1" ||
  !process.env.TEST_MONGODB_DATABASE?.endsWith("_test") ||
  !/^mongodb:\/\/127\.0\.0\.1:/.test(process.env.TEST_MONGODB_URI || "")
)
  throw Error("Use a local test database and browser-test-server only.");
const pool = await createDatabase({
  MONGODB_URI: process.env.TEST_MONGODB_URI,
  MONGODB_DATABASE: process.env.TEST_MONGODB_DATABASE,
  NODE_ENV: "test",
});
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const errors = [],
  stamp = Date.now(),
  email = `launch-${stamp}@example.test`,
  original = "A launch test password!";
try {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/#login");
  await page.locator("#auth-submit:not([disabled])").waitFor();
  const docs = (await (await page.request.get(origin + "/api/legal")).json())
    .documents;
  const signed = await page.request.post(origin + "/api/auth/signup", {
    headers: { Origin: origin },
    data: {
      email,
      firstName: "Launch",
      lastName: "Traveler",
      password: original,
      confirmPassword: original,
      age: true,
      acceptedLegal: true,
      termsVersion: docs.terms.version,
      privacyVersion: docs.privacy.version,
    },
  });
  assert.equal(signed.status(), 201);
  const user = (await signed.json()).user;
  for (let i = 0; i < 33; i++) {
    const trip = await pool.insert("trips", {
      title: `Launch journey ${stamp} ${i}`,
      owner_id: user.id,
      organizer_id: user.id,
      from_city: "Delhi",
      destination: "Manali",
      starts_on: "2099-01-01",
      ends_on: "2099-01-03",
      budget_min: 1000 + i,
      budget_max: 4000,
      capacity: 6,
      existing_travelers: 1,
      category: "Adventure",
      mode: "Train",
      women_only: false,
      image: "manali",
      description: "A browser test journey.",
      departure_utc: "2099-01-01T08:00:00Z",
    });
    await pool.insert("trip_locations", {
      trip_id: trip.id,
      destination: { type: "Point", coordinates: [77.1892, 32.2432] },
      origin: { type: "Point", coordinates: [77.1892, 32.2432] },
      expires_at: new Date(Date.now() + 86400000),
    });
  }
  await page.goto(origin + "/?fixture=" + stamp + "#discover");
  await page.locator("#app-loading").waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.querySelectorAll(".trip-card").length === 6,
  );
  await page.locator("#load-more").click();
  await page.waitForFunction(
    () => document.querySelectorAll(".trip-card").length === 12,
  );
  await page.locator('[data-view="my-trips"]').first().click();
  await page.waitForFunction(
    () =>
      location.hash === "#my-trips" &&
      document.querySelectorAll(".trip-card").length === 6,
  );
  await page.locator("#load-more").click();
  await page.waitForFunction(
    () => document.querySelectorAll(".trip-card").length === 12,
  );
  await page.reload();
  await page.locator("#app-loading").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#login-page").isHidden(), true);
  assert.equal(new URL(page.url()).hash, "#my-trips");
  await page.locator('[data-view="discover"]').first().click();
  await page.locator("#destination").fill("Manali");
  await page.locator("#search-form").evaluate((f) => f.requestSubmit());
  await page.waitForFunction(() =>
    document.querySelector("#nearby-status").textContent.includes("within 50"),
  );
  await page.waitForFunction(
    () => document.querySelectorAll(".trip-card").length === 6,
  );
  await page.locator("#load-more").click();
  await page.waitForFunction(
    () => document.querySelectorAll(".trip-card").length === 12,
  );
  await page.locator(".card-cta").last().click();
  await page.locator("#trip-reviews").waitFor();
  assert(
    (await page.locator("#modal-content").innerText()).includes(
      "more than 24 hours",
    ),
  );
  await page.locator(".modal-close").click();
  await page.goto(origin + "/#forgot-password");
  await page.locator("#password-recovery-form").waitFor();
  await page.locator('#password-recovery-form [name="email"]').fill(email);
  await page.locator('#password-recovery-form [type="submit"]').click();
  await page
    .getByText("If an eligible account exists", { exact: false })
    .waitFor();
  const mail = await pool.one(
    "test_mail_outbox",
    { to: email },
    { sort: { created_at: -1 } },
  );
  assert(mail);
  const reset = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  reset.on("pageerror", (e) => errors.push(e.message));
  await reset.goto(mail.url);
  await reset.locator("#password-reset-form:not([hidden])").waitFor();
  assert.equal(new URL(reset.url()).hash, "#reset-password");
  await reset
    .locator('#password-reset-form [name="password"]')
    .fill("An updated launch password!");
  await reset
    .locator('#password-reset-form [name="confirmPassword"]')
    .fill("An updated launch password!");
  await reset.locator('#password-reset-form [type="submit"]').click();
  await reset
    .getByText("Password updated. Sign in again with your new password.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    (await (await page.request.get(origin + "/api/auth/session")).json()).user,
    null,
  );
  await reset.locator('[data-recovery="login"]').click();
  await reset.locator("#login-email").fill(email);
  await reset.locator("#login-password").fill("An updated launch password!");
  await reset.locator("#auth-submit").click();
  await reset.locator("#app-shell:not([hidden])").waitFor();
  assert.equal(
    await reset.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const admin = await browser.newPage();
  admin.on("pageerror", (e) => errors.push(e.message));
  await admin.goto(origin + "/#login");
  const ar = await admin.request.post(origin + "/api/auth/login", {
    headers: { Origin: origin },
    data: {
      email: "admin-browser@example.test",
      password: "Browser admin test password!",
    },
  });
  assert.equal(ar.status(), 200);
  const trip = await pool.one("trips", { owner_id: user.id });
  await pool.insert("reports", {
    reporter_id: user.id,
    trip_id: trip.id,
    reason: "Browser report reason",
    note: "A private moderation request.",
  });
  await admin.goto(origin + "/admin");
  await admin
    .locator('[data-community-form="report-decision"]')
    .first()
    .waitFor();
  const report = admin
    .locator('[data-community-form="report-decision"]')
    .first();
  await report.locator('[name="status"]').selectOption("resolved");
  await report.locator('[name="action"]').selectOption("hide");
  await report
    .locator('[name="reason"]')
    .fill("Confirmed issue after private review.");
  await report.locator('[type="submit"]').click();
  await admin
    .getByText("Last decision: Confirmed issue after private review.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    (await pool.one("trips", { id: trip.id })).moderation_hidden,
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Launch browser checks passed: feed pages, nearby pages, session refresh, reset recovery and admin moderation.",
  );
} finally {
  await browser.close();
  await pool.close();
}
