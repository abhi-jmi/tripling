import { chromium } from "playwright-core";
import assert from "node:assert/strict";
const origin = process.env.TRIPLING_TEST_ORIGIN || "http://127.0.0.1:3102";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw Error("Community browser checks are local-only.");
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const errors = [];
try {
  const guest = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  guest.on("pageerror", (e) => errors.push(e.message));
  await guest.goto(origin);
  await guest.locator("#app-shell:not([hidden])").waitFor();
  assert(await guest.locator("#community-admin").isHidden());
  await guest.locator(".site-footer [data-community=feedback]").click();
  const feedback = guest.locator("[data-community-form=feedback]");
  await feedback.locator("[name=name]").fill("Browser Feedback");
  await feedback.locator("[name=email]").fill("browser-feedback@example.test");
  await feedback
    .locator("[name=message]")
    .fill("A genuine browser feedback submission for the accessibility test.");
  await feedback.locator("[type=submit]").click();
  await guest
    .getByRole("heading", { name: "Thank you", exact: true })
    .waitFor();
  const owner = await browser.newPage();
  owner.on("pageerror", (e) => errors.push(e.message));
  await owner.goto(origin + "/#login");
  await owner.locator("#auth-submit:not([disabled])").waitFor();
  await owner.locator("[data-auth-mode=signup]").click();
  await owner.locator("#signup-first-name").fill("New");
  await owner.locator("#signup-last-name").fill("Organizer");
  await owner
    .locator("#login-email")
    .fill(`new-organizer-${Date.now()}@example.test`);
  await owner
    .locator("#login-password")
    .fill("A browser verification passphrase!");
  await owner
    .locator("#confirm-password")
    .fill("A browser verification passphrase!");
  await owner.locator("#signup-adult").check();
  await owner.locator("#signup-legal").check();
  await owner.locator("#auth-submit").click();
  await owner.locator("#app-shell:not([hidden])").waitFor();
  await owner.locator(".site-footer [data-community=verification]").click();
  const verification = owner.locator("[data-community-form=verification]");
  await verification.locator("[name=name]").fill("Browser Travel Organizer");
  await verification
    .locator("[name=contact]")
    .fill("private-contact@example.test");
  await verification
    .locator("[name=experience]")
    .fill(
      "We organize thoughtful small-group travel and provide public business references.",
    );
  await verification.locator("[type=submit]").click();
  await owner
    .locator("#modal-content strong")
    .getByText("pending", { exact: true })
    .waitFor();
  const admin = await browser.newPage();
  admin.on("pageerror", (e) => errors.push(e.message));
  await admin.goto(origin + "/#login");
  await admin.locator("#auth-submit:not([disabled])").waitFor();
  await admin.locator("#login-email").fill("admin-browser@example.test");
  await admin.locator("#login-password").fill("Browser admin test password!");
  await admin.locator("#auth-submit").click();
  await admin.locator("#app-shell:not([hidden])").waitFor();
  await admin.locator("#account-menu summary").click();
  await admin.locator("#community-admin").click();
  const decision = admin.locator("[data-community-form=decision]").first();
  await decision
    .locator("[name=reason]")
    .fill("Public references reviewed in browser authorization test.");
  await decision.locator("[type=submit]").click();
  await admin
    .locator(".request-item h4")
    .getByText(/Browser Travel Organizer · approved/)
    .waitFor();
  const item = admin
    .locator("article")
    .filter({
      hasText:
        "A genuine browser feedback submission for the accessibility test.",
    })
    .first();
  await item.locator("[name=status]").selectOption("Resolved");
  await item.locator("[name=notes]").fill("Reviewed by administrator.");
  await item.locator("[type=submit]").click();
  await admin
    .locator("article")
    .filter({
      hasText:
        "A genuine browser feedback submission for the accessibility test.",
    })
    .first()
    .locator("select")
    .waitFor();
  await owner.reload();
  await owner.locator("#app-shell:not([hidden])").waitFor();
  await owner.locator("#account-menu summary").click();
  await owner.locator("[data-community=dashboard]").click();
  await owner
    .locator("#modal-content")
    .getByText("approved", { exact: false })
    .waitFor();
  await owner.locator(".modal-close").click();
  await owner.locator(".create-nav").click();
  await owner.locator("#create-form").waitFor();
  assert(await owner.locator("[name=departureTime]").isVisible());
  assert(
    await guest.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "Community browser checks passed: guest-first browsing, real feedback persistence, organizer request, admin approval, feedback management, verified publishing UI and mobile layout.",
  );
} finally {
  await browser.close();
}
