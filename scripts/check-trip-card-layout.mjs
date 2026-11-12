import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { createDatabase } from "../server/db.js";
import { mkdir } from "node:fs/promises";
const origin = process.env.TRIPLING_TEST_ORIGIN || "http://127.0.0.1:3105";
if (
  !["127.0.0.1", "localhost"].includes(new URL(origin).hostname) ||
  !process.env.TEST_MONGODB_DATABASE?.endsWith("_test") ||
  !/^mongodb:\/\/(127\.0\.0\.1|localhost):/.test(
    process.env.TEST_MONGODB_URI || "",
  )
)
  throw Error("Use explicit local test database and origin.");
const db = await createDatabase({
  MONGODB_URI: process.env.TEST_MONGODB_URI,
  MONGODB_DATABASE: process.env.TEST_MONGODB_DATABASE,
  NODE_ENV: "test",
});
const admin = await db.one("users", { email: "admin-browser@example.test" });
assert(admin);
const ids = [];
for (const status of ["open", "canceled"]) {
  const trip = await db.insert("trips", {
    owner_id: admin.id,
    organizer_id: admin.id,
    title: `${status} legacy card layout`,
    from_city: "Chandigarh",
    destination: "Manali",
    starts_on: "2099-11-20",
    ends_on: "2099-11-22",
    budget_min: 5000,
    budget_max: 8000,
    capacity: 5,
    existing_travelers: 1,
    category: "Adventure",
    mode: "Bus",
    women_only: false,
    description: "Local fixture for a legacy departure-time notice.",
    status,
  });
  ids.push(trip.id);
  await db.insert("trip_members", { trip_id: trip.id, user_id: admin.id });
  await db.insert("trip_participants", {
    trip_id: trip.id,
    user_id: admin.id,
    first_joined_at: new Date(),
    left_at: null,
  });
}
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
await mkdir("work/layout-check", { recursive: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/#login");
  await page.locator("#auth-submit:not([disabled])").waitFor();
  await page.locator("#login-email").fill("admin-browser@example.test");
  await page.locator("#login-password").fill("Browser admin test password!");
  await page.locator("#auth-submit").click();
  await page.locator("#app-shell:not([hidden])").waitFor();
  await page.locator(".header [data-view=my-trips]").click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator("#my-trip-status").selectOption("upcoming");
    assert.equal(await page.locator(".trip-card").count(), 1);
    const card = page.locator(".trip-card"),
      notice = card.locator(".participation-notice");
    assert(await card.locator(".leave-trip").isDisabled());
    const n = await notice.boundingBox(),
      s = await card.locator(".my-card-status").boundingBox(),
      c = await card.boundingBox();
    assert(n.y >= s.y + s.height);
    assert(n.x + n.width <= c.x + c.width + 1);
    assert(await page.locator("#community-stories").isHidden());
    assert(await page.locator(".create-banner").isHidden());
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `work/layout-check/my-trips-${width}.png`,
      fullPage: true,
    });
    await page.locator("#my-trip-status").selectOption("canceled");
    assert.equal(await page.locator(".trip-card").count(), 1);
    assert(
      (await page.locator(".trip-card").textContent()).includes(
        "canceled legacy card layout",
      ),
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    "Personal trip status filters and restricted-leave card layouts passed at desktop and mobile sizes.",
  );
} finally {
  await browser.close();
  for (const trip_id of ids) {
    await db.removeMany("trip_members", { trip_id });
    await db.removeMany("trip_participants", { trip_id });
    await db.removeMany("trips", { id: trip_id });
  }
  await db.close();
}
