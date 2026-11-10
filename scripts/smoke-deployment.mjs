import assert from "node:assert/strict";
const origin = new URL(process.env.APP_ORIGIN || "");
assert.equal(
  origin.protocol,
  "https:",
  "Smoke checks require the production HTTPS origin.",
);
assert(
  /^[a-f0-9]{40}$/.test(process.env.EXPECTED_VERSION || ""),
  "Provide the expected commit SHA.",
);
async function get(path) {
  const response = await fetch(new URL(path, origin), {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, `${path} must return 200`);
  return response;
}
const health = await (await get("/healthz")).json();
assert.equal(health.status, "ok");
assert.equal(health.version, process.env.EXPECTED_VERSION);
const session = await (await get("/api/auth/session")).json();
assert.equal(session.user, null);
const bootstrap = await (await get("/api/bootstrap")).json();
assert(Array.isArray(bootstrap.trips));
assert.equal(bootstrap.user, null);
const legal = await (await get("/api/legal")).json();
for (const slug of ["terms", "privacy"]) {
  assert(legal.documents[slug]?.published, `${slug} must be published`);
  const html = await (await get(`/${slug}`)).text();
  assert(html.includes(legal.documents[slug].version));
  assert(!html.includes("Draft policy"));
}
console.log(
  "Production smoke checks passed; no accounts, trips, or messages were created.",
);
