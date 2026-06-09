/**
 * Simple migration runner: reads `src/db/migrations/*.sql`, applies any not
 * yet recorded in `_migrations`. Idempotent.
 *
 * Usage: npm run db:migrate
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const sql = postgres(url, { max: 1 });

  try {
    // Bootstrap the migrations table (in case 0000 hasn't run yet)
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationsDir = join(__dirname, "migrations");
    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied = new Set(
      (
        await sql<{ filename: string }[]>`SELECT filename FROM _migrations`
      ).map((r) => r.filename)
    );

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`= ${file} (already applied)`);
        continue;
      }
      const sqlText = await readFile(join(migrationsDir, file), "utf-8");
      console.log(`▶ ${file}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(sqlText);
        await tx`INSERT INTO _migrations (filename) VALUES (${file})`;
      });
      console.log(`✓ ${file}`);
    }

    console.log("Migrations complete.");
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
