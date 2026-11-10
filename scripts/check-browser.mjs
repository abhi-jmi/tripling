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
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill("A browser test passphrase!");
  await page.locator("#confirm-password").fill("A browser test passphrase!");
  await page.locator("#signup-adult").check();
  await page.locator("#auth-submit").click();
  await page.locator("#app-shell:not([hidden])").waitFor();
  await page.locator(".profile-button").click();
  await page.locator("#profile-form [name=name]").fill(name);
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
  await organizer
    .locator("#login-email")
    .fill(`organizer-${stamp}@example.com`);
  await organizer.locator("#login-password").fill("A browser test passphrase!");
  await organizer.locator("#confirm-password").fill("Different passphrase!");
  await organizer.locator("#signup-adult").check();
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
  await member.locator(".modal-close").click();
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
    "Browser checks passed: signup validation, real login, profile, create, guest redirect/resume, saves, join approval, shared chat, escaped message content, persistent login data, and mobile layouts.",
  );
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser.close();
}
