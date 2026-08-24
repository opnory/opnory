import { migrate, closePool } from "./packages/access-store-pg/src/index.js";

const databaseUrl =
  process.env.DATABASE_URL || "postgresql://raelldottin@localhost:5432/opnory";

process.env.DATABASE_URL = databaseUrl;

async function runMigration() {
  try {
    await migrate();
    console.log("Migration completed successfully");
    await closePool();
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    await closePool();
    process.exit(1);
  }
}

runMigration();
