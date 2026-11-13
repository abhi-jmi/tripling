import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const origin = process.env.TRIPLING_TEST_ORIGIN || "http://127.0.0.1:3114";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw Error("Dashboard checks are local-only.");
await mkdir("work/dashboard-check", { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    }),
    errors = [],
    stamp = Date.now();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.locator("#app-loading").waitFor({ state: "hidden" });
  const docs = (await (await page.request.get(origin + "/api/legal")).json())
    .documents;
  const signup = await page.request.post(origin + "/api/auth/signup", {
    headers: { Origin: origin },
    data: {
      email: `dashboard-${stamp}@example.test`,
      firstName: "Dashboard",
      lastName: "Traveler",
      password: "A dashboard browser test passphrase!",
      confirmPassword: "A dashboard browser test passphrase!",
      age: true,
      acceptedLegal: true,
      termsVersion: docs.terms.version,
      privacyVersion: docs.privacy.version,
    },
  });
  assert.equal(signup.status(), 201);
  assert.equal(
    (
      await page.request.put(origin + "/api/profile", {
        headers: { Origin: origin },
        data: {
          firstName: "Dashboard",
          lastName: "Traveler",
          city: "Delhi",
          gender: "woman",
          bio: "A careful organizer of friendly adventures.",
          age: true,
        },
      })
    ).status(),
    200,
  );
  const trip = {
    title: `Mountain weekend ${stamp}`,
    from: "Delhi",
    fromPlaceId: "delhi-id",
    destination: "Manali",
    destinationPlaceId: "manali-id",
    start: "2099-11-20",
    end: "2099-11-23",
    departureUtc: "2099-11-20T12:00:00Z",
    timeZone: "UTC",
    min: 5000,
    max: 8000,
    going: 1,
    seats: 3,
    category: "Adventure",
    mode: "Bus",
    description:
      "A relaxed mountain trip with public meeting points and flexible plans.",
    plan: "",
    rules: "",
    groupEligibility: "mixed",
    age: true,
  };
  const create = async (data) => {
    const r = await page.request.post(origin + "/api/trips", {
      headers: { Origin: origin },
      data,
    });
    assert.equal(r.status(), 201);
    return (await r.json()).id;
  };
  const first = await create(trip),
    second = await create({
      ...trip,
      title: `Another adventure ${stamp}`,
      category: "Camping",
    });
  await page.goto(origin + "/organizer/dashboard");
  await page.locator(".organizer-trip-card").first().waitFor();
  assert.equal(
    await page.locator("#community-page-content [data-action=create]").count(),
    0,
  );
  assert(await page.locator(".header .create-nav").isVisible());
  assert.equal(await page.locator(".organizer-trip-card").count(), 2);
  await page.locator(".organizer-profile-link").click();
  await page
    .getByRole("heading", { name: "Dashboard Traveler", exact: true })
    .waitFor();
  assert.equal(
    await page.getByText("✓ Verified Organizer", { exact: true }).count(),
    0,
  );
  await page.locator(".modal-close").click();
  const card = page
    .locator(".organizer-trip-card")
    .filter({ has: page.locator(`[data-community=edit][data-id="${first}"]`) });
  const colors = await card
    .locator(".organizer-trip-actions button")
    .evaluateAll((nodes) =>
      nodes.map((e) => getComputedStyle(e).backgroundColor),
    );
  assert.equal(new Set(colors).size, 5);
  const before = await card.boundingBox(),
    shadow = await card.evaluate((e) => getComputedStyle(e).boxShadow);
  await card.hover();
  await page.waitForTimeout(180);
  assert.notEqual(
    await card.evaluate((e) => getComputedStyle(e).boxShadow),
    shadow,
  );
  assert.deepEqual(await card.boundingBox(), before);
  await card.locator("[data-trip]").click();
  await page
    .locator("#modal-title")
    .getByText(trip.title, { exact: true })
    .waitFor();
  await page.locator(".modal-close").click();
  await card.locator("[data-community=participants]").click();
  await page
    .getByRole("heading", { name: "Registered participants", exact: true })
    .waitFor();
  await page.locator(".modal-close").click();
  await card.locator("[data-community=edit]").click();
  const form = page.locator('[data-community-form="edit"]');
  await form.waitFor();
  for (const name of [
    "title",
    "from",
    "destination",
    "start",
    "departureTime",
    "timeZone",
    "end",
    "min",
    "max",
    "going",
    "seats",
    "category",
    "mode",
    "group",
    "description",
    "plan",
    "rules",
    "adult",
  ])
    assert.equal(await form.locator(`[name="${name}"]`).count(), 1, name);
  const edited = `Edited coastal trip ${stamp}`;
  await form.locator("[name=title]").fill(edited);
  await form.locator("[name=from]").fill("Chandigarh");
  await form.locator("[name=from]").evaluate((e) => {
    e.dataset.placeId = "chandigarh-id";
  });
  await form.locator("[name=destination]").fill("Goa");
  await form.locator("[name=destination]").evaluate((e) => {
    e.dataset.placeId = "goa-id";
  });
  await form.locator("[name=start]").fill("2099-12-15");
  await form.locator("[name=end]").fill("2099-12-20");
  await form.locator("[name=departureTime]").fill("10:30");
  await form.locator("[name=timeZone]").fill("Asia/Kolkata");
  await form.locator("[name=min]").fill("9000");
  await form.locator("[name=max]").fill("5000");
  await form.locator("[name=going]").fill("2");
  await form.locator("[name=seats]").fill("2");
  await form.locator("[name=category]").selectOption("Trekking");
  await form.locator("[name=mode]").selectOption("Train");
  await form.locator("[name=group]").selectOption("women");
  await form
    .locator("[name=description]")
    .fill(
      "An edited responsible coastal itinerary with public meeting points.",
    );
  await form.locator("[name=plan]").fill("Flexible coast and local culture.");
  await form
    .locator("[name=rules]")
    .fill("Respect boundaries and agree on costs.");
  await form.locator("[name=adult]").check();
  await form.locator("[type=submit]").click();
  await page
    .locator("#modal[open] .community-error")
    .filter({ hasText: "Maximum budget" })
    .waitFor();
  assert(await form.isVisible());
  await form.locator("[name=max]").fill("12000");
  await form.locator("[type=submit]").click();
  await page.locator("#modal").waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: edited, exact: true }).waitFor();
  const saved = (
    await (await page.request.get(origin + "/api/organizer/dashboard")).json()
  ).trips.find((t) => t.id === first);
  assert.equal(saved.from_city, "Chandigarh");
  assert.equal(saved.destination, "Goa");
  assert.equal(saved.starts_on, "2099-12-15");
  assert.equal(saved.ends_on, "2099-12-20");
  assert.equal(saved.departure_utc, "2099-12-15T05:00:00.000Z");
  assert.equal(saved.mode, "Train");
  assert.equal(saved.category, "Trekking");
  assert.equal(saved.capacity, 4);
  assert.equal(saved.existing_travelers, 2);
  assert.equal(saved.group_eligibility, "women");
  await card.locator("[data-community=edit]").click();
  await form.waitFor();
  assert.equal(
    await form.locator("[name=departureTime]").inputValue(),
    "10:30",
  );
  assert.equal(
    await form.locator("[name=from]").getAttribute("data-place-id"),
    "chandigarh-id",
  );
  await page.locator(".modal-close").click();
  await page.screenshot({
    path: "work/dashboard-check/desktop.png",
    fullPage: true,
  });
  for (const width of [820, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `overflow at ${width}`,
    );
    await page.screenshot({
      path: `work/dashboard-check/mobile-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator(`[data-community=cancel][data-id="${second}"]`).click();
  const cancel = page.locator('[data-community-form="cancel"]');
  await cancel
    .locator("[name=reason]")
    .fill("The organizer cannot run this second beta trip.");
  await cancel.locator("[type=submit]").click();
  await page.locator("#modal").waitFor({ state: "hidden" });
  const cancelled = page.locator(".organizer-trip-card").filter({
    has: page.locator(`[data-community=cancel][data-id="${second}"]`),
  });
  assert(
    await cancelled
      .locator(".organizer-trip-status")
      .getByText("Cancelled", { exact: true })
      .isVisible(),
  );
  assert(await cancelled.locator("[data-community=edit]").isDisabled());
  await page.locator(".header .brand").click();
  assert.equal(await page.locator(".verified-organizer").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "Organizer dashboard browser checks passed: distinct cards/hover/actions, profile link, no duplicate create or beta badges, full-field edits/persistence, visible validation errors, cancel/refresh, and responsive layouts.",
  );
} finally {
  await browser.close();
}
