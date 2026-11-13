import express from "express";
import { organizerVerificationEnabled } from "./roles.js";
import { registerCommunity } from "./community.js";
import { GENDERS } from "./trip-options.js";
import { createCityResolver, registerNearbyRoutes } from "./nearby.js";
import { createPlacesAutocomplete } from "./places.js";
import helmet from "helmet";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import {
  currentLegalDocuments,
  legalMetadata,
  renderLegalPage,
} from "./legal.js";
import { registerTripRoutes } from "./trips.js";
import { registerBlockRoutes } from "./blocks.js";
import { registerGoogleAuth } from "./google-auth.js";
import { transaction } from "./db.js";
import {
  cookieName,
  cookieOptions,
  digest,
  dummyHash,
  hashPassword,
  issueSession,
  publicUser,
  sessionToken,
  verifyPassword,
} from "./auth.js";
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
const email = z
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
const password = z
  .string()
  .min(10, "Use at least 10 characters for your password.")
  .max(128);
const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
const personName = z
  .string()
  .trim()
  .min(1, "First and last name are required.")
  .max(50)
  .refine(
    (v) => /\p{L}/u.test(v) && !/[\x00-\x1f\x7f]/.test(v),
    "Use a valid name.",
  );
const signupSchema = z
  .object({
    email,
    firstName: personName,
    lastName: personName,
    password,
    confirmPassword: z.string().max(128),
    acceptedLegal: z.literal(true, {
      error:
        "Agree to the Terms and acknowledge the Privacy Policy to create an account.",
    }),
    termsVersion: z.string().min(1).max(80),
    privacyVersion: z.string().min(1).max(80),
    age: z.literal(true, { error: "You must be 18 or older to sign up." }),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });
const profileSchema = z.object({
  firstName: personName,
  lastName: personName,
  city: z.string().trim().max(60),
  gender: z.enum(["", ...GENDERS.map((g) => g.value)]),
  genderDescription: z.string().trim().max(100).default(""),
  bio: z.string().trim().max(500),
  age: z.literal(true, { error: "You must be 18 or older to use Tripling." }),
});
export function createApp(
  pool,
  {
    production = process.env.NODE_ENV === "production",
    publicOrigin = process.env.PUBLIC_ORIGIN,
    organizerVerificationRequired = organizerVerificationEnabled(),
    googleAdapter = null,
    placesAdapter = createPlacesAutocomplete(),
    cityResolver = createCityResolver(),
  } = {},
) {
  if (typeof organizerVerificationRequired !== "boolean")
    throw new Error("organizerVerificationRequired must be a boolean.");
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: production ? [] : null,
        },
      },
      strictTransportSecurity: production ? undefined : false,
    }),
  );
  app.use("/api/organizer/verification", express.json({ limit: "3mb" }));
  app.use(express.json({ limit: "32kb" }));
  app.get("/healthz", async (req, res) => {
    try {
      await pool.ping();
      res.set("Cache-Control", "no-store").json({
        status: "ok",
        version: process.env.APP_VERSION || "development",
      });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.get(["/terms", "/privacy"], async (req, res) => {
    const docs = await currentLegalDocuments(pool, { production });
    const doc = docs[req.path.slice(1)];
    if (!doc)
      return res
        .status(503)
        .type("text")
        .send(
          "This policy is not published yet. Please check back before creating an account.",
        );
    res
      .set("Cache-Control", "no-store")
      .type("html")
      .send(renderLegalPage(doc));
  });
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      const origin = req.get("origin");
      let valid = false;
      try {
        const url = new URL(origin);
        valid = publicOrigin
          ? url.origin === new URL(publicOrigin).origin
          : url.host === req.get("host") &&
            url.protocol === (production ? "https:" : "http:");
      } catch {}
      if (!valid)
        return res
          .status(403)
          .json({ error: "Request origin is not allowed." });
      if (!req.is("application/json"))
        return res.status(415).json({ error: "Use JSON for API requests." });
    }
    next();
  });
  app.use("/api", async (req, res, next) => {
    try {
      const token = sessionToken(req);
      if (token) {
        const session = await pool.one("sessions", {
          token_hash: digest(token),
          expires_at: { $gt: new Date() },
        });
        req.user = session
          ? await pool.one("users", { id: session.user_id })
          : null;
        if (req.user)
          req.user.google_linked = !!(await pool.one("oauth_identities", {
            provider: "google",
            user_id: req.user.id,
          }));
      }
      next();
    } catch (e) {
      next(e);
    }
  });
  const requireUser = (req, res, next) =>
    req.user
      ? next()
      : res.status(401).json({ error: "Please log in to continue." });
  async function throttle(req, key, limit) {
    const window = Math.floor(Date.now() / 900000);
    const result = await pool.change(
      "auth_rate_limits",
      { bucket_key: digest(key), window_start: window },
      {
        $inc: { attempts: 1 },
        $setOnInsert: { expires_at: new Date((window + 3) * 900000) },
      },
      { upsert: true },
    );
    if (result.attempts > limit)
      fail(429, "Too many attempts. Please try again in 15 minutes.");
  }
  app.get("/api/legal", async (req, res) =>
    res.json({
      documents: legalMetadata(
        await currentLegalDocuments(pool, { production }),
      ),
    }),
  );
  app.post("/api/auth/signup", async (req, res) => {
    await throttle(req, `signup:${req.ip}`, 10);
    const data = signupSchema.parse(req.body);
    const hash = await hashPassword(data.password);
    try {
      const user = await transaction(pool, async (db) => {
        const result = await db.insert("users", {
          email: data.email,
          password_hash: hash,
          adult_confirmed: true,
          first_name: data.firstName,
          last_name: data.lastName,
          display_name: data.firstName + " " + data.lastName,
        });
        const docs = await currentLegalDocuments(db, { production });
        if (!docs.terms || !docs.privacy)
          fail(
            503,
            "The legal policies are not available yet. Please try again later.",
          );
        if (
          data.termsVersion !== docs.terms.version ||
          data.privacyVersion !== docs.privacy.version
        )
          fail(
            409,
            "Our policies changed. Refresh this page and review the latest versions before signing up.",
          );
        for (const slug of ["terms", "privacy"])
          await db.insert("legal_acceptances", {
            user_id: result.id,
            slug,
            version: docs[slug].version,
          });
        await issueSession(db, req, res, result.id, production);
        return result;
      });
      res.status(201).json({ user: publicUser(user) });
    } catch (e) {
      if (e.code === 11000)
        fail(
          409,
          "An account cannot be created with these details. Try logging in.",
        );
      throw e;
    }
  });
  app.post("/api/auth/login", async (req, res) => {
    await throttle(req, `login-ip:${req.ip}`, 40);
    const data = loginSchema.parse(req.body);
    await throttle(req, `login-email:${data.email}`, 10);
    const user = await pool.one("users", { email: data.email });
    const valid = await verifyPassword(
      data.password,
      user?.password_hash || dummyHash,
    );
    if (!user || !valid) fail(401, "Email or password is incorrect.");
    await transaction(pool, (db) =>
      issueSession(db, req, res, user.id, production),
    );
    res.json({ user: publicUser(user) });
  });
  app.get("/api/auth/session", (req, res) =>
    res.json({ user: req.user ? publicUser(req.user) : null }),
  );
  app.post("/api/auth/logout", async (req, res) => {
    const token = sessionToken(req);
    if (token) await pool.remove("sessions", { token_hash: digest(token) });
    res.clearCookie(cookieName, {
      ...cookieOptions(production),
      maxAge: undefined,
    });
    res.json({ ok: true });
  });
  app.put("/api/profile", requireUser, async (req, res) => {
    const d = profileSchema.parse(req.body);
    const user = await pool.change(
      "users",
      { id: req.user.id },
      {
        $set: {
          display_name: d.firstName + " " + d.lastName,
          city: d.city,
          gender: d.gender,
          gender_description:
            d.gender === "self-describe" ? d.genderDescription : "",
          bio: d.bio,
          adult_confirmed: true,
          first_name: d.firstName,
          last_name: d.lastName,
        },
      },
    );
    user.google_linked = req.user.google_linked;
    res.json({ user: publicUser(user) });
  });
  registerGoogleAuth(app, pool, {
    production,
    publicOrigin,
    requireUser,
    throttle,
    personName,
    googleAdapter,
  });
  registerCommunity(app, pool, {
    requireUser,
    throttle,
    cityResolver,
    organizerVerificationRequired,
  });
  registerNearbyRoutes(app, pool, { throttle, cityResolver });
  registerTripRoutes(app, pool, {
    requireUser,
    throttle,
    publicUser,
    placesAdapter,
    cityResolver,
    organizerVerificationRequired,
  });
  registerBlockRoutes(app, pool, { requireUser, throttle });
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "API endpoint not found." }),
  );
  app.use(
    express.static(fileURLToPath(new URL("../dist/", import.meta.url)), {
      index: "index.html",
      maxAge: 0,
    }),
  );
  app.get(
    ["/organizer/dashboard", "/organizer/verification", "/admin", "/feedback"],
    (req, res) => {
      if (req.path.endsWith("/"))
        return res.redirect(
          308,
          req.path.slice(0, -1) +
            (req.originalUrl.includes("?")
              ? "?" + req.originalUrl.split("?").slice(1).join("?")
              : ""),
        );
      return res
        .set("Cache-Control", "no-store")
        .sendFile(
          fileURLToPath(new URL("../dist/index.html", import.meta.url)),
        );
    },
  );
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof z.ZodError)
      return res
        .status(400)
        .json({ error: err.issues[0]?.message || "Invalid request." });
    const status = err.status || 500;
    if (status >= 500) console.error("Request failed:", err.code || err.name);
    res.status(status).json({
      error:
        status >= 500 ? "Something went wrong. Please try again." : err.message,
    });
  });
  return app;
}
