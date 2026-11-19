import { randomBytes } from "node:crypto";
import { z } from "zod";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { digest, hashPassword, cookieName, cookieOptions } from "./auth.js";
import { transaction, lockTravelers } from "./db.js";
import { httpError } from "./travel-rules.js";

export function createPasswordResetMailer({
  from = process.env.PASSWORD_RESET_FROM_EMAIL,
  region = process.env.AWS_REGION,
  send,
} = {}) {
  if (!from) return null;
  if (!z.email().safeParse(from).success)
    throw Error("PASSWORD_RESET_FROM_EMAIL must be an email address.");
  return async ({ to, url }) => {
    const client = send ? null : new SESv2Client({ region });
    try {
      const command = new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: "Reset your Tripling password", Charset: "UTF-8" },
            Body: {
              Text: {
                Charset: "UTF-8",
                Data: `You requested a password reset for Tripling.\n\nOpen this link within 30 minutes:\n${url}\n\nUse the most recently requested link. It works once. After resetting, sign in with your new password. All previous sessions will be ended.\n\nIf you did not request this, ignore this email. Your password has not changed.`,
              },
            },
          },
        },
      });
      await (send ? send(command) : client.send(command));
    } finally {
      client?.destroy();
    }
  };
}

export function registerPasswordRecovery(
  app,
  pool,
  { production, publicOrigin, throttle, mailer, minimumDelayMs = 350 },
) {
  let origin;
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (
      url.username ||
      url.password ||
      (production && url.protocol !== "https:") ||
      !["http:", "https:"].includes(url.protocol)
    )
      throw Error(
        "Password recovery requires a valid PUBLIC_ORIGIN (HTTPS in production).",
      );
    origin = url.origin;
  }
  const available = !!mailer && !!origin;
  const generic = {
    message:
      "If an eligible account exists, a reset link will be sent. Check your inbox and spam folder. Use Google sign-in for Google-only accounts.",
  };
  app.get("/api/auth/password-reset/config", (req, res) =>
    res.json({ available }),
  );
  app.post("/api/auth/password-reset/request", async (req, res) => {
    const started = Date.now();
    const { email } = z
      .object({
        email: z
          .email()
          .max(254)
          .transform((s) => s.toLowerCase()),
      })
      .parse(req.body);
    await throttle(req, `reset-ip:${req.ip}`, 20);
    await throttle(req, `reset-email:${email}`, 3);
    if (!available)
      throw httpError(
        503,
        "Password recovery email is unavailable. Please contact support.",
      );
    const user = await pool.one("users", { email });
    if (user?.password_hash) {
      const token = randomBytes(32).toString("hex"),
        tokenHash = digest(token);
      // A request never changes credentials or sessions. Only the latest token is valid.
      await pool.update(
        "password_resets",
        { user_id: user.id },
        {
          $set: {
            user_id: user.id,
            token_hash: tokenHash,
            credential_hash: digest(user.password_hash),
            expires_at: new Date(Date.now() + 30 * 60000),
            created_at: new Date(),
          },
        },
        { upsert: true },
      );
      const url = new URL("/", origin);
      url.hash = "reset-password=" + token;
      try {
        await mailer({ to: email, url: url.href });
      } catch {
        await pool.remove("password_resets", {
          user_id: user.id,
          token_hash: tokenHash,
        });
        // Never expose account existence, email addresses, links or provider error bodies.
        console.error("PASSWORD_RESET_DELIVERY_FAILED");
      }
    }
    const remaining = minimumDelayMs - (Date.now() - started);
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
    res.status(202).json(generic);
  });
  app.post("/api/auth/password-reset/complete", async (req, res) => {
    await throttle(req, `reset-complete:${req.ip}`, 30);
    const data = z
      .object({
        token: z.string().regex(/^[a-f0-9]{64}$/),
        password: z.string().min(10).max(128),
        confirmPassword: z.string().max(128),
      })
      .refine((d) => d.password === d.confirmPassword, {
        message: "Passwords do not match.",
        path: ["confirmPassword"],
      })
      .parse(req.body);
    const token_hash = digest(data.token),
      invalid = () =>
        httpError(
          400,
          "This reset link is invalid or expired. Request a new link.",
        );
    const pending = await pool.one("password_resets", {
      token_hash,
      expires_at: { $gt: new Date() },
    });
    if (!pending) throw invalid();
    const nextHash = await hashPassword(data.password);
    await transaction(pool, async (db) => {
      await lockTravelers(db, [pending.user_id]);
      const user = await db.one("users", { id: pending.user_id });
      const record = await db.take("password_resets", {
        user_id: pending.user_id,
        token_hash,
        expires_at: { $gt: new Date() },
      });
      if (
        !record ||
        !user?.password_hash ||
        digest(user.password_hash) !== record.credential_hash
      )
        throw invalid();
      await db.update(
        "users",
        { id: user.id },
        { $set: { password_hash: nextHash } },
      );
      await db.removeMany("sessions", { user_id: user.id });
      await db.removeMany("password_resets", { user_id: user.id });
      await db.removeMany("oauth_flows", { link_user_id: user.id });
    });
    res.clearCookie(cookieName, {
      ...cookieOptions(production),
      maxAge: undefined,
    });
    res.json({
      ok: true,
      message: "Password updated. Sign in again with your new password.",
    });
  });
}
