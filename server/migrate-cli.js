import { createDatabase } from "./db.js";
import { migrate } from "./migrate.js";
const pool = await createDatabase();
try {
  await migrate(pool);
  console.log("MongoDB collections and indexes are ready.");
} finally {
  await pool.close();
}
