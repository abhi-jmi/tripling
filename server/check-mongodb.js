import { createDatabase } from "./db.js";
// Deliberately omit migrate()/policy publishing: this task never writes data.
export async function checkMongoConnection(db) {
  await db.ping();
  await db.one("trips", {}, { projection: { _id: 1 }, maxTimeMS: 10000 });
}
async function run() {
  let db;
  try {
    db = await createDatabase();
    await checkMongoConnection(db);
    console.log(
      "MONGODB_CONNECTION_OK: MongoDB connection, replica-set discovery and database read access verified.",
    );
  } catch (e) {
    console.error("MONGODB_CONNECTION_FAILED:", e.code || "CHECK_FAILED");
    process.exitCode = 1;
  } finally {
    await db?.close();
  }
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1])
  await run();
