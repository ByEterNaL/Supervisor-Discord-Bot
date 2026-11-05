import { readdirSync, readFileSync } from "fs";
import path from "path";

import { createSqlClient, getRuntimeEnv } from "../packages/shared/src";

async function main() {
  const env = getRuntimeEnv();
  const sql = createSqlClient(env.databaseUrl);
  const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
  const migrationFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  await sql`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const appliedRows = await sql<{ filename: string }[]>`
    SELECT filename
    FROM _schema_migrations
  `;
  const appliedSet = new Set(appliedRows.map((row) => row.filename));

  for (const fileName of migrationFiles) {
    if (appliedSet.has(fileName)) {
      continue;
    }

    const fullPath = path.join(migrationsDir, fileName);
    const migrationSql = readFileSync(fullPath, "utf8");

    // eslint-disable-next-line no-console
    console.log(`Applying migration ${fileName}`);

    await sql.begin(async (transaction) => {
      await transaction.unsafe(migrationSql);
      await transaction`
        INSERT INTO _schema_migrations (filename)
        VALUES (${fileName})
      `;
    });
  }

  await sql.end();
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Migration failed:", error);
  process.exit(1);
});

