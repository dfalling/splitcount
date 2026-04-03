import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type postgres from "postgres";

const migrationsDir = join(import.meta.dir, "../migrations");

export async function runMigrations(sql: postgres.Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const [applied] = await sql`
      SELECT filename FROM schema_migrations WHERE filename = ${file}
    `;
    if (applied) continue;

    const content = await readFile(join(migrationsDir, file), "utf-8");
    console.log(`[migrate] applying ${file}`);
    await sql.unsafe(content);
    await sql`INSERT INTO schema_migrations (filename) VALUES (${file})`;
    console.log(`[migrate] applied ${file}`);
  }
}
