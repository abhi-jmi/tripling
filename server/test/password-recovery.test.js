import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./launch-helpers.js";
import { digest, hashPassword, verifyPassword } from "../auth.js";
import { createPasswordResetMailer } from "../password-recovery.js";
import { publishLegalDocuments, currentLegalDocuments } from "../legal.js";
test("password recovery uses latest expiring single-use links and revokes all sessions", async (t) => {
  const messages = [];
  const { db, base } = await fixture(t, "tripling_recovery_test", {
    publicOrigin: "https://tripling.example",
    passwordResetMailer: async (m) => messages.push(m),
  });
  const user = await db.insert("users", {
    email: "reset@example.test",
    password_hash: await hashPassword("Original password!"),
  });
  const call = async (path, body) => {
    const r = await fetch(base + "/api" + path, {
      method: "POST",
      headers: {
        Origin: "https://tripling.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const first = await call("/auth/password-reset/request", {
    email: user.email,
  });
  assert.equal(first.status, 202);
  const unknown = await call("/auth/password-reset/request", {
    email: "unknown@example.test",
  });
  assert.deepEqual(unknown, first);
  const link = new URL(messages[0].url),
    token = link.hash.split("=")[1];
  assert.equal(link.origin, "https://tripling.example");
  const stored = await db.one("password_resets", { user_id: user.id });
  assert.equal(stored.token_hash, digest(token));
  assert(!JSON.stringify(stored).includes(token));
  await call("/auth/password-reset/request", { email: user.email });
  const body = {
    token,
    password: "A brand new password!",
    confirmPassword: "A brand new password!",
  };
  assert.equal((await call("/auth/password-reset/complete", body)).status, 400);
  body.token = new URL(messages[1].url).hash.split("=")[1];
  await db.insert("sessions", {
    user_id: user.id,
    token_hash: digest("old-session"),
    expires_at: new Date(Date.now() + 60000),
  });
  const results = await Promise.all([
    call("/auth/password-reset/complete", body),
    call("/auth/password-reset/complete", body),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  assert.equal(await db.count("sessions", { user_id: user.id }), 0);
  assert.equal(await db.count("password_resets", { user_id: user.id }), 0);
  assert(
    await verifyPassword(
      body.password,
      (await db.one("users", { id: user.id })).password_hash,
    ),
  );
  await call("/auth/password-reset/request", { email: user.email });
  body.token = new URL(messages[2].url).hash.split("=")[1];
  await db.update(
    "password_resets",
    { user_id: user.id },
    { $set: { expires_at: new Date(0) } },
  );
  assert.equal((await call("/auth/password-reset/complete", body)).status, 400);
  const blocked = await call("/auth/password-reset/request", {
    email: user.email,
  });
  assert.equal(blocked.status, 429);
  const badOrigin = await fetch(base + "/api/auth/password-reset/request", {
    method: "POST",
    headers: {
      Origin: "https://evil.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: user.email }),
  });
  assert.equal(badOrigin.status, 403);
});
test("recovery is unavailable without a sender and SES mail has a fixed sender", async (t) => {
  const { client } = await fixture(t, "tripling_recovery_disabled_test", {
    passwordResetMailer: null,
  });
  assert.equal(
    (
      await client().request("/auth/password-reset/request", {
        email: "a@example.test",
      })
    ).status,
    503,
  );
  let sent;
  await createPasswordResetMailer({
    from: "accounts@example.test",
    send: async (command) => {
      sent = command.input;
    },
  })({
    to: "a@example.test",
    url: "https://tripling.example/#reset-password=secret",
  });
  assert.equal(sent.FromEmailAddress, "accounts@example.test");
  assert(sent.Content.Simple.Body.Text.Data.includes("30 minutes"));
  assert.equal(createPasswordResetMailer({ from: "" }), null);
});
test("policy versions follow beta approval mode while preserving historical acceptances", async (t) => {
  const { db } = await fixture(t, "tripling_beta_policy_test");
  const before = await currentLegalDocuments(db);
  assert(
    JSON.stringify(before.terms).includes(
      "without organizer application approval",
    ),
  );
  await db.insert("legal_acceptances", {
    user_id: "historic",
    slug: "terms",
    version: before.terms.version,
  });
  await publishLegalDocuments(db, {
    NODE_ENV: "test",
    ORGANIZER_VERIFICATION_REQUIRED: "true",
  });
  const after = await currentLegalDocuments(db);
  assert.notEqual(after.terms.version, before.terms.version);
  assert(
    JSON.stringify(after.terms).includes(
      "approval is required before publishing",
    ),
  );
  await publishLegalDocuments(db, {
    NODE_ENV: "test",
    ORGANIZER_VERIFICATION_REQUIRED: "true",
  });
  assert.equal(await db.count("legal_documents"), 4);
  await publishLegalDocuments(db, {
    NODE_ENV: "test",
    ORGANIZER_VERIFICATION_REQUIRED: "false",
  });
  assert.equal(
    (await currentLegalDocuments(db)).terms.version,
    before.terms.version,
  );
  assert.equal(
    await db.count("legal_acceptances", { version: before.terms.version }),
    1,
  );
});
