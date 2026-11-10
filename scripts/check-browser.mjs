import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
await mkdir("work/browser-check", { recursive: true });
const origin = process.env.TRIPLING_TEST_ORIGIN || "http://127.0.0.1:3000";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw new Error("Browser checks may only write to a local test server.");
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const contexts = [];
const errors = [];
const stamp = Date.now();
async function pageFor() {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
  });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/");
  await page.locator("#auth-submit:not([disabled])").waitFor();
  return page;
}
async function signup(page, email, name) {
  await page.locator('[data-auth-mode="signup"]').click();
  await page.locator("#signup-first-name").fill(name.split(" ")[0]);
  await page
    .locator("#signup-last-name")
    .fill(name.split(" ").slice(1).join(" "));
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill("A browser test passphrase!");
  await page.locator("#confirm-password").fill("A browser test passphrase!");
  await page.locator("#signup-adult").check();
  await page.locator("#signup-legal").check();
  await page.locator("#auth-submit").click();
  await page.locator("#app-shell:not([hidden])").waitFor();
  await page.locator(".profile-button").click();
  await page.locator("#profile-form [name=firstName]").fill(name.split(" ")[0]);
  await page
    .locator("#profile-form [name=lastName]")
    .fill(name.split(" ").slice(1).join(" "));
  await page.locator("#profile-form [name=gender]").selectOption("woman");
  await page.locator("#profile-form [type=submit]").click();
  await page.locator("#modal").waitFor({ state: "hidden" });
}
try {
  const organizer = await pageFor();
  await organizer.screenshot({
    path: resolve("work/browser-check/login-desktop.png"),
    fullPage: true,
  });
  await organizer.locator('[data-auth-mode="signup"]').click();
  await organizer.locator("#signup-first-name").fill("Browser");
  await organizer.locator("#signup-last-name").fill("Organizer");
  await organizer
    .locator("#login-email")
    .fill(`organizer-${stamp}@example.com`);
  await organizer.locator("#login-password").fill("A browser test passphrase!");
  await organizer.locator("#confirm-password").fill("Different passphrase!");
  await organizer.locator("#signup-adult").check();
  await organizer.locator("#signup-legal").check();
  await organizer.locator("#auth-submit").click();
  await organizer
    .getByText("Passwords do not match.", { exact: true })
    .waitFor();
  await signup(
    organizer,
    `organizer-${stamp}@example.com`,
    "Browser Organizer",
  );
  await organizer.locator(".create-nav").click();
  const form = organizer.locator("#create-form");
  await form.locator("[name=title]").fill("A shared mountain weekend");
  await form.locator("[name=from]").fill("Delhi");
  await form.locator("[name=destination]").fill("Manali");
  await form.locator("[name=start]").fill("2099-11-20");
  await form.locator("[name=end]").fill("2099-11-23");
  await form.locator("[name=min]").fill("5000");
  await form.locator("[name=max]").fill("8000");
  await form
    .locator("[name=description]")
    .fill(
      "A relaxed trip with good company, public meeting points, and flexible plans.",
    );
  await form.locator("[name=adult]").check();
  await form.locator("[type=submit]").click();
  await organizer.locator("#modal").waitFor({ state: "hidden" });
  await organizer
    .locator(".card-title")
    .getByText("A shared mountain weekend")
    .waitFor();
  const member = await pageFor();
  await member.locator("[data-action=browse-guest]").click();
  await member.locator(".save-button").click();
  await member.locator("#login-page:not([hidden])").waitFor();
  await signup(member, `member-${stamp}@example.com`, "Browser Member");
  assert(
    (await member.locator(".save-button").getAttribute("aria-pressed")) ===
      "true",
  );
  await member.locator(".card-cta").click();
  await member.locator("[data-join]").click();
  await member
    .locator("#join-form [name=note]")
    .fill("I enjoy slow mountain trips and would love to join your crew.");
  await member.locator("#join-form [type=submit]").click();
  await member.locator("#modal").waitFor({ state: "hidden" });
  await organizer.locator("[data-incoming]").click();
  await organizer.getByText("Browser Member", { exact: true }).waitFor();
  await organizer.locator("[data-decision=accepted]").click();
  await organizer
    .getByText("No pending requests. Share your plan with your community.", {
      exact: true,
    })
    .waitFor();
  await organizer.locator(".modal-close").click();
  await member.reload();
  await member.locator("[data-view=my-trips]").click();
  await member.locator("[data-chat]").click();
  await member
    .locator("#chat-form [name=body]")
    .fill("Hello crew! <img src=x onerror=alert(1)>");
  await member.locator("#chat-form [type=submit]").click();
  await member
    .locator("#chat-messages")
    .getByText("Hello crew! <img src=x onerror=alert(1)>", { exact: false })
    .waitFor();
  assert.equal(await member.locator("#chat-messages img").count(), 0);
  await organizer.locator("[data-chat]").click();
  await organizer
    .locator("#chat-messages")
    .getByText("Hello crew!", { exact: false })
    .waitFor();
  await organizer.screenshot({
    path: resolve("work/browser-check/group-chat.png"),
    fullPage: true,
  });
  await organizer.locator(".modal-close").click();
  await organizer.locator("[data-view=discover]").click();
  await organizer.locator("#destination").fill("Ma");
  await organizer.locator("#destination").press("ArrowDown");
  await organizer
    .locator(".location-options:not([hidden]) [role=option]")
    .first()
    .waitFor();
  await organizer.locator("#destination").press("ArrowDown");
  await organizer.locator("#destination").press("Enter");
  assert(
    (await organizer.locator("#destination").inputValue()).startsWith("Ma"),
  );
  await organizer.locator("#destination").fill("");
  await organizer.locator("#destination").press("Escape");
  await organizer.screenshot({
    path: resolve("work/browser-check/discovery-desktop.png"),
    fullPage: true,
  });
  const mobileCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
  });
  contexts.push(mobileCtx);
  const mobile = await mobileCtx.newPage();
  mobile.on("pageerror", (e) => errors.push(e.message));
  await mobile.goto(origin + "/");
  await mobile.locator("#auth-submit:not([disabled])").waitFor();
  assert(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await mobile.screenshot({
    path: resolve("work/browser-check/login-mobile.png"),
    fullPage: true,
  });
  await mobile.locator("[data-action=browse-guest]").click();
  assert(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await mobile.screenshot({
    path: resolve("work/browser-check/discovery-mobile.png"),
    fullPage: true,
  });
  const legalPage = await mobileCtx.newPage();
  for (const path of ["/terms", "/privacy"]) {
    await legalPage.goto(origin + path);
    await legalPage.locator("h1").waitFor();
    assert.equal(await legalPage.locator(".legal-draft").count(), 0);
    await legalPage
      .getByText("Contact the operator", { exact: true })
      .waitFor();
    assert(
      await legalPage.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
  }
  await legalPage.screenshot({
    path: resolve("work/browser-check/privacy-mobile.png"),
    fullPage: true,
  });
  // The author can share a block reason only inside a shared trip.
  await organizer.locator(".card-title").click();
  await organizer.locator("[data-crew]").click();
  const crewMember = organizer
    .locator(".traveler-row")
    .filter({ hasText: "Browser Member" });
  await crewMember.locator("[data-traveler]").click();
  await organizer
    .locator("#block-form [name=tripId]")
    .selectOption({
      label: "Registered participants: A shared mountain weekend",
    });
  await organizer
    .locator("#block-form [name=reason]")
    .fill("Repeatedly ignored our agreed communication boundaries.");
  await organizer.locator("#block-form [type=submit]").click();
  await organizer.locator("[data-unblock]").waitFor();
  await organizer.locator(".modal-close").click();
  await member.locator(".modal-close").click();
  await member.locator(".card-title").click();
  await member.locator("[data-crew]").click();
  await member
    .getByText("Repeatedly ignored our agreed communication boundaries.", {
      exact: false,
    })
    .waitFor();
  await member.locator("[data-notice-report]").click();
  await member
    .locator("#notice-report-form [name=reason]")
    .fill("The statement needs context from both participants.");
  await member.locator("#notice-report-form [type=submit]").click();
  await member.locator("#modal").waitFor({ state: "hidden" });
  await organizer.locator(".card-title").click();
  assert.equal(await organizer.locator("[data-cancel-trip]").count(), 0);
  await organizer.locator("[data-leave]").click();
  await organizer.locator("[data-confirm-leave]").click();
  await organizer.locator("#modal").waitFor({ state: "hidden" });
  const retained = await organizer.evaluate(
    async () => (await (await fetch("/api/bootstrap")).json()).trips[0],
  );
  assert(retained.organizerId);
  assert.equal(retained.isMember, false);
  assert.equal(retained.participated, true);
  await member.reload();
  await member.locator("[data-view=my-trips]").click();
  await member.locator("[data-incoming]").waitFor();
  await member.locator("[data-view=past-trips]").click();
  await member
    .getByText("Past journeys. Shared stories.", { exact: true })
    .waitFor();
  if (process.env.TEST_DATABASE_URL) {
    if (!new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test"))
      throw new Error(
        "Past-trip browser fixture requires a dedicated _test database.",
      );
    const { default: pg } = await import("pg");
    const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      await db.query(
        "UPDATE trips SET starts_on='2020-01-01',ends_on='2020-01-03' WHERE id=$1",
        [retained.id],
      );
      await db.query(
        "UPDATE trip_participants SET first_joined_at='2019-12-31',last_joined_at='2019-12-31' WHERE trip_id=$1",
        [retained.id],
      );
    } finally {
      await db.end();
    }
    await member.reload();
    await member.locator(".card-title").click();
    await member.locator("[data-review]").click();
    await member
      .locator("#review-form [name=body]")
      .fill("Reliable planning and respectful travel arrangements.");
    await member.locator("#review-form [type=submit]").click();
    await member
      .locator("#trip-reviews")
      .getByText("Reliable planning and respectful travel arrangements.", {
        exact: true,
      })
      .waitFor();
    await member.screenshot({
      path: resolve("work/browser-check/past-trip-review.png"),
      fullPage: true,
    });
    await member.locator(".modal-close").click();
  }
  await member.locator(".profile-button").click();
  await member.locator("[data-action=logout]").click();
  await member.locator("#login-page:not([hidden])").waitFor();
  await member.locator("#login-email").fill(`member-${stamp}@example.com`);
  await member.locator("#login-password").fill("A browser test passphrase!");
  await member.locator("#auth-submit").click();
  await member.locator("#app-shell:not([hidden])").waitFor();
  await member.locator("[data-view=saved]").click();
  await member.locator(".card-title").waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Browser checks passed: signup validation, real login, profile, create, guest redirect/resume, saves, join approval, shared chat, escaped message content, persistent login data, participant-only block notices and reporting, organizer leave/handover, past-trip reviews, keyboard location dropdowns, and mobile layouts.",
  );
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser.close();
}
