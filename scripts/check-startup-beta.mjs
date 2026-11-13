import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const origin = process.env.TRIPLING_TEST_ORIGIN || "http://127.0.0.1:3111";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw Error("Startup checks may only use a local test server.");
await mkdir("work/startup-check", { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.loginWasShown = false;
    const observe = () => {
      const login = document.getElementById("login-page");
      if (login && !login.hidden && getComputedStyle(login).display !== "none")
        window.loginWasShown = true;
    };
    new MutationObserver(observe).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["hidden", "class"],
    });
  });
  async function delayedLoad(path, reload = false) {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const handler = async (route) => {
      await gate;
      await route.continue();
    };
    await page.route("**/api/bootstrap", handler);
    try {
      if (reload) await page.reload({ waitUntil: "domcontentloaded" });
      else {
        await page.goto("about:blank");
        await page.goto(origin + path, { waitUntil: "domcontentloaded" });
      }
      await page.locator("#app-loading:not([hidden])").waitFor();
      await page.waitForTimeout(100);
      assert(await page.locator("#login-page").isHidden());
      assert.equal(await page.evaluate(() => window.loginWasShown), false);
      release();
      await page.locator("#app-loading").waitFor({ state: "hidden" });
      assert.equal(
        new URL(page.url()).pathname +
          new URL(page.url()).search +
          new URL(page.url()).hash,
        path,
      );
      assert.equal(await page.evaluate(() => window.loginWasShown), false);
    } finally {
      release();
      await page.unroute("**/api/bootstrap", handler);
    }
  }
  await delayedLoad("/#past-trips");
  const legal = (await (await page.request.get(origin + "/api/legal")).json())
    .documents;
  const signup = await page.request.post(origin + "/api/auth/signup", {
    headers: { Origin: origin },
    data: {
      email: `beta-browser-${Date.now()}@example.test`,
      firstName: "Beta",
      lastName: "Traveler",
      password: "A real beta browser passphrase!",
      confirmPassword: "A real beta browser passphrase!",
      age: true,
      acceptedLegal: true,
      termsVersion: legal.terms.version,
      privacyVersion: legal.privacy.version,
    },
  });
  assert.equal(signup.status(), 201);
  const user = (await signup.json()).user;
  for (const path of [
    "/#discover",
    "/#past-trips",
    "/#my-trips",
    "/#saved",
    "/organizer/dashboard",
    "/organizer/verification",
    "/feedback",
    "/admin?category=Suggestion",
  ]) {
    await delayedLoad(path);
    await delayedLoad(path, true);
  }
  await page.goto(origin + "/organizer/verification");
  await page.locator(".verification-coming-soon").waitFor();
  assert.equal(
    await page.locator(".verification-coming-soon").textContent(),
    "Coming soon",
  );
  assert.equal(
    await page
      .locator(".verification-preview-background")
      .getAttribute("aria-hidden"),
    "true",
  );
  assert(
    await page
      .locator(".verification-preview-background")
      .evaluate((e) => e.inert),
  );
  assert.equal(
    await page.locator("[data-community-form=verification]").count(),
    0,
  );
  assert.equal(
    (
      await page.request.post(origin + "/api/organizer/verification", {
        headers: { Origin: origin },
        data: { name: "No beta submissions" },
      })
    ).status(),
    409,
  );
  await page.screenshot({
    path: "work/startup-check/verification-desktop.png",
    fullPage: false,
  });
  await page.evaluate(() => {
    window.sameDocumentMarker = true;
  });
  let navigations = 0;
  const track = (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame())
      navigations++;
  };
  page.on("request", track);
  await page.locator(".header .brand").click();
  assert.equal(
    new URL(page.url()).pathname + new URL(page.url()).hash,
    "/#discover",
  );
  assert.equal(await page.evaluate(() => window.sameDocumentMarker), true);
  assert.equal(navigations, 0);
  assert.equal(await page.evaluate(() => window.loginWasShown), false);
  page.off("request", track);
  await page.goBack();
  await page.locator(".verification-coming-soon").waitFor();
  await page.goForward();
  await page.locator("#discovery-intro").waitFor();
  // Beta users publish directly without receiving a false approval/badge.
  await page.locator(".create-nav").click();
  const tripTitle = "An unverified beta adventure " + Date.now();
  const form = page.locator("#create-form");
  await form.waitFor();
  await form.locator("[name=title]").fill(tripTitle);
  await form.locator("[name=from]").fill("Delhi");
  await form.locator("[name=from]").evaluate((e) => {
    e.dataset.placeId = "test-city-id";
  });
  await form.locator("[name=destination]").fill("Manali");
  await form.locator("[name=start]").fill("2099-11-20");
  await form.locator("[name=end]").fill("2099-11-23");
  await form.locator("[name=min]").fill("5000");
  await form.locator("[name=max]").fill("8000");
  await form
    .locator("[name=description]")
    .fill(
      "A relaxed beta trip with public meeting points and responsible travelers.",
    );
  await form.locator("[name=adult]").check();
  await form.locator("[type=submit]").click();
  await page.locator("#modal").waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: tripTitle, exact: true })
    .waitFor();
  const bootstrap = await (
    await page.request.get(origin + "/api/bootstrap")
  ).json();
  assert.equal(bootstrap.features.organizerVerificationRequired, false);
  assert.equal(bootstrap.user.id, user.id);
  assert.equal(bootstrap.user.organizerVerification, "not_submitted");
  assert.equal(
    bootstrap.trips.find((t) => t.title === tripTitle)
      .verifiedOrganizer,
    false,
  );
  await page.goto(origin + "/organizer/verification");
  await page.locator(".verification-coming-soon").waitFor();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
  }
  await page.screenshot({
    path: "work/startup-check/verification-mobile.png",
    fullPage: false,
  });
  // Network failure must not masquerade as an expired session or change the URL.
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Temporary test outage" }),
    }),
  );
  await page.goto(origin + "/#saved");
  await page.locator("#startup-retry:not([hidden])").waitFor();
  assert.equal(new URL(page.url()).hash, "#saved");
  assert(await page.locator("#login-page").isHidden());
  assert.equal(await page.evaluate(() => window.loginWasShown), false);
  await page.unroute("**/api/bootstrap");
  await page.locator("#startup-retry").click();
  await page.locator("#app-loading").waitFor({ state: "hidden" });
  assert.equal(new URL(page.url()).hash, "#saved");
  // Actual unauthenticated private access and explicit login still prompt correctly.
  await page.context().clearCookies();
  await page.reload();
  await page.locator("#login-page:not([hidden])").waitFor();
  assert.equal(new URL(page.url()).hash, "#login");
  await page.goto(origin + "/#login");
  await page.locator("#login-page:not([hidden])").waitFor();
  await page.locator(".login-brand").click();
  await page.locator("#discovery-intro").waitFor();
  assert.equal(new URL(page.url()).hash, "#discover");
  assert.deepEqual(errors, []);
  console.log(
    "Startup/beta checks passed: delayed session restoration and reloads preserve routes without login flashes; same-document home/history; coming-soon overlay; unverified publishing; outage/retry; legitimate login prompts; mobile layout.",
  );
} finally {
  await browser.close();
}
