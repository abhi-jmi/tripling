import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const origin = process.env.TRIPLING_TEST_ORIGIN || "http://127.0.0.1:3104";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw Error("Layout checks are local-only.");
await mkdir("work/layout-check", { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  for (const width of [1440, 820, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    await page.locator("#app-shell:not([hidden])").waitFor();
    await page
      .locator("#body-style[data-ready=true]")
      .waitFor({ state: "attached" });
    assert.deepEqual(errors, []);
    assert.equal(await page.locator("header").count(), 1);
    assert.equal(await page.locator("footer").count(), 1);
    assert(
      await page.evaluate(
        () =>
          !!(
            document
              .querySelector("#community-stories")
              .compareDocumentPosition(document.querySelector("footer")) &
            Node.DOCUMENT_POSITION_FOLLOWING
          ),
      ),
    );
    assert(
      await page.evaluate(
        () =>
          document.querySelector("#community-stories").closest("main") !== null,
      ),
    );
    await page.locator("#account-menu summary").click();
    await page.locator("#account-menu [data-community=dashboard]").waitFor();
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator("#account-menu").getAttribute("open"),
      null,
    );
    if (!(await page.locator("#body-style").isVisible()))
      await page.locator("#toggle-body-filters").click();
    await page.locator("#body-style").selectOption("Trekking");
    await page.locator("#body-budget").selectOption("5000");
    await page.locator("#body-filter-form [type=submit]").click();
    await page.waitForTimeout(100);
    assert.equal(await page.locator("#filter-count").textContent(), "2");
    await page.locator("#clear-body-filters").click();
    assert.equal(await page.locator("#body-style").inputValue(), "");
    assert(await page.locator("#filter-count").isHidden());
    assert(await page.locator(".create-nav svg").isVisible());
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `overflow at ${width}px`,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `work/layout-check/discovery-${width}.png`,
      fullPage: true,
    });
    await page.locator(".site-footer [data-community=feedback]").click();
    await page.locator("[data-community-form=feedback]").waitFor();
    await page.locator(".modal-close").click();
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`Layout and inline filters passed at ${width}px.`);
  }
} finally {
  await browser.close();
}
