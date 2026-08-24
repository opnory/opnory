"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("./packages/access-store-pg/src/index.js");
const databaseUrl = process.env.DATABASE_URL || "postgresql://raelldottin@localhost:5432/opnory";
process.env.DATABASE_URL = databaseUrl;
async function runMigration() {
    try {
        await (0, index_js_1.migrate)();
        console.log("Migration completed successfully");
        await (0, index_js_1.closePool)();
        process.exit(0);
    }
    catch (err) {
        console.error("Migration failed:", err);
        await (0, index_js_1.closePool)();
        process.exit(1);
    }
}
runMigration();
//# sourceMappingURL=run-migrate.js.map