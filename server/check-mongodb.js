import { createDatabase } from "./db.js";
import { mongoFailureDetails } from "./mongo-diagnostics.js";
// Deliberately omit migrate()/policy publishing: this task never writes data.
export async function checkMongoConnection(db) {
  await db.ping();
  await db.one("trips", {}, { projection: { _id: 1 }, maxTimeMS: 10000 });
}
async function run() {
  let db;
  try {
    // HTTPS-only public AWS endpoint; no database credentials are sent here.
    try {
      const response = await fetch("https://checkip.amazonaws.com/", {
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      const ip = (await response.text()).trim();
      console.log(
        "CHECK_EGRESS_IP:",
        response.ok && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)
          ? ip
          : "UNAVAILABLE",
      );
    } catch {
      console.log("CHECK_EGRESS_IP: UNAVAILABLE");
    }
    db = await createDatabase();
    await checkMongoConnection(db);
    console.log(
      "MONGODB_CONNECTION_OK: MongoDB connection, replica-set discovery and database read access verified.",
    );
  } catch (e) {
    console.error("MONGODB_CONNECTION_FAILED:", e.code || "CHECK_FAILED");
    console.error(
      "MONGODB_DIAGNOSTIC:",
      JSON.stringify(e.diagnostic || mongoFailureDetails(e)),
    );
    process.exitCode = 1;
  } finally {
    await db?.close();
  }
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1])
  await run();
