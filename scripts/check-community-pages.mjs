import { chromium } from "playwright-core";
import assert from "node:assert/strict";
const origin = process.env.TRIPLING_TEST_ORIGIN || "http://127.0.0.1:3106";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw Error("Page browser checks must run locally.");
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
  await page.goto(origin + "/feedback");
  await page
    .getByRole("heading", { name: "Write to Us", exact: true })
    .waitFor();
  assert.equal(await page.locator("dialog[open]").count(), 0);
  assert(await page.locator(".header").isVisible());
  assert(await page.locator(".site-footer").isVisible());
  const css = await page.evaluate(
    () => getComputedStyle(document.querySelector(".header")).position,
  );
  assert.equal(css, "sticky");
  await page.reload();
  await page.locator("[data-community-form=feedback]").waitFor();
  await page.goto(origin + "/organizer/dashboard");
  await page.locator("#login-page:not([hidden])").waitFor();
  assert.equal(new URL(page.url()).hash, "#login");
  await page.locator("#auth-submit:not([disabled])").waitFor();
  await page.locator("#login-email").fill("admin-browser@example.test");
  await page.locator("#login-password").fill("Browser admin test password!");
  await page.locator("#auth-submit").click();
  await page
    .getByRole("heading", { name: "Organizer dashboard", exact: true })
    .waitFor();
  assert.equal(new URL(page.url()).pathname, "/organizer/dashboard");
  assert.equal(await page.locator("dialog[open]").count(), 0);
  await page
    .locator("#community-page-nav [data-community=verification]")
    .click();
  await page
    .getByRole("heading", { name: "Organizer verification", exact: true })
    .waitFor();
  assert.equal(new URL(page.url()).pathname, "/organizer/verification");
  await page.goBack();
  await page
    .getByRole("heading", { name: "Organizer dashboard", exact: true })
    .waitFor();
  await page.goForward();
  await page
    .getByRole("heading", { name: "Organizer verification", exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByRole("heading", { name: "Organizer verification", exact: true })
    .waitFor();
  await page.locator("#community-page-nav [data-community=admin]").click();
  await page
    .getByRole("heading", { name: "Administration", exact: true })
    .waitFor();
  assert.equal(new URL(page.url()).pathname, "/admin");
  assert.equal(await page.locator("dialog[open]").count(), 0);
  const filter = page.locator("[data-community-form=feedback-filter]");
  await filter.locator("[name=category]").selectOption("Suggestion");
  await filter.locator("[name=status]").selectOption("Resolved");
  await filter.locator("[type=submit]").click();
  await page.waitForURL("**/admin?category=Suggestion&status=Resolved");
  await page
    .getByRole("heading", { name: "Administration", exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByRole("heading", { name: "Administration", exact: true })
    .waitFor();
  assert.equal(
    await page
      .locator("[data-community-form=feedback-filter] [name=category]")
      .inputValue(),
    "Suggestion",
  );
  await page.locator(".header [data-view=discover]").click();
  await page.locator(".explore").waitFor();
  assert.equal(new URL(page.url()).pathname, "/");
  assert(await page.locator("#community-page").isHidden());
  await page.goto(origin + "/feedback");
  await page.locator("[data-community-form=feedback]").waitFor();
  const form = page.locator("[data-community-form=feedback]");
  await form.locator("[name=name]").fill("Routed Guest");
  await form.locator("[name=email]").fill("routed@example.test");
  await form
    .locator("[name=message]")
    .fill("A genuine feedback message submitted from a dedicated page.");
  await form.locator("[type=submit]").click();
  await page.getByRole("heading", { name: "Thank you", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/feedback");
  assert.equal(await page.locator("dialog[open]").count(), 0);
  // Slow old responses must not overwrite the page selected afterward.
  let release, captured;
  const blocked = new Promise((r) => (release = r)),
    seen = new Promise((r) => (captured = r));
  await page.route("**/api/organizer/dashboard", async (route) => {
    captured();
    await blocked;
    await route.continue();
  });
  await page.locator("#community-page-nav [data-community=dashboard]").click();
  await seen;
  await page.locator("#community-page-nav [data-community=feedback]").click();
  await page
    .getByRole("heading", { name: "Write to Us", exact: true })
    .waitFor();
  release();
  await page.waitForTimeout(300);
  assert.equal(
    await page.locator("#community-page-title").textContent(),
    "Write to Us",
  );
  await page.unroute("**/api/organizer/dashboard");
  for (const width of [820, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `Overflow at ${width}`,
    );
    assert(await page.locator("[data-community-form=feedback]").isVisible());
  }
  const guest = await browser.newPage();
  await guest.goto(origin + "/admin");
  await guest.locator("#login-page:not([hidden])").waitFor();
  assert.equal(
    await guest.locator("[data-community-form=decision]").count(),
    0,
  );
  await guest.close();
  const normal = await browser.newPage();
  await normal.goto(origin + "/feedback");
  await normal.locator("[data-community-form=feedback]").waitFor();
  const signup = await normal.evaluate(async () => {
    const documents = (await (await fetch("/api/legal")).json()).documents;
    const r = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `page-user-${Date.now()}@example.test`,
        firstName: "Page",
        lastName: "Traveler",
        password: "A normal browser test password!",
        confirmPassword: "A normal browser test password!",
        age: true,
        acceptedLegal: true,
        termsVersion: documents.terms.version,
        privacyVersion: documents.privacy.version,
      }),
    });
    return r.status;
  });
  assert.equal(signup, 201);
  await normal.goto(origin + "/admin");
  await normal
    .getByRole("heading", { name: "Access restricted", exact: true })
    .waitFor();
  assert.equal(
    await normal.locator("[data-community-form=decision]").count(),
    0,
  );
  await normal.close();
  assert.deepEqual(errors, []);
  console.log(
    "Dedicated pages passed: direct URLs/reload, assets, shared shell, login return, admin page protection, history, feedback persistence, stale-response handling and responsive layouts.",
  );
} finally {
  await browser.close();
}
