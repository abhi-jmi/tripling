// Local-only test server; never imported by the production startup path.
import { createDatabase } from "../server/db.js";
import { migrate } from "../server/migrate.js";
import { publishLegalDocuments } from "../server/legal.js";
import { hashPassword } from "../server/auth.js";
import { createApp } from "../server/app.js";
if (
  process.env.NODE_ENV === "production" ||
  !process.env.TEST_MONGODB_DATABASE?.endsWith("_test") ||
  !/^mongodb:\/\/(127\.0\.0\.1|localhost):/.test(
    process.env.TEST_MONGODB_URI || "",
  )
)
  throw Error("Use explicit local test-only database settings.");
const pool = await createDatabase({
  MONGODB_URI: process.env.TEST_MONGODB_URI,
  MONGODB_DATABASE: process.env.TEST_MONGODB_DATABASE,
  NODE_ENV: "test",
});
await migrate(pool);
await publishLegalDocuments(pool, {
  NODE_ENV: "test",
  LEGAL_OPERATOR_NAME: "Tripling Test",
  LEGAL_CONTACT_EMAIL: "test@example.test",
  LEGAL_JURISDICTION: "India",
});
let admin = await pool.one("users", { email: "admin-browser@example.test" });
if (!admin)
  admin = await pool.insert("users", {
    email: "admin-browser@example.test",
    first_name: "Test",
    last_name: "Admin",
    display_name: "Test Admin",
    password_hash: await hashPassword("Browser admin test password!"),
    adult_confirmed: true,
  });
process.env.TRIPLING_ADMIN_USER_IDS = admin.id;
createApp(pool, {
  production: false,
  placesAdapter: null,
  cityResolver: async (name, placeId) => ({
    latitude: name === "Kullu" ? 31.9579 : 32.2432,
    longitude: 77.1892,
    label: name + ", India",
    city: name,
    state: "Himachal Pradesh",
    placeId,
  }),
}).listen(Number(process.env.PORT) || 3102, "127.0.0.1", () =>
  console.log("Local browser test server ready."),
);
