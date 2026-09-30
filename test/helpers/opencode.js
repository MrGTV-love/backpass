import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** An opencode golden fixture: the DDL of a real store and rows in table order. */
export function readOpencodeFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

/** Build an opencode store from a golden fixture: the real DDL, then its rows in table order. */
export function writeOpencodeStore(dbFile, fixture, { skipTables = [] } = {}) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  try {
    for (const statement of fixture.schema) {
      const table = statement.match(/^CREATE TABLE `([^`]+)`/)?.[1];
      if (!skipTables.includes(table)) db.exec(statement);
    }
    for (const [table, rows] of Object.entries(fixture.rows)) {
      if (skipTables.includes(table)) continue;
      for (const row of rows) {
        const columns = Object.keys(row);
        db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
          ...columns.map((column) =>
            row[column] && typeof row[column] === "object" ? JSON.stringify(row[column]) : row[column],
          ),
        );
      }
    }
  } finally {
    db.close();
  }
}

/**
 * Run `fn` with HOME on a fresh directory whose default opencode store `build` writes.
 * HOME is restored, and the directory removed, whether `build` or `fn` succeeds or not.
 */
export async function withOpencodeHome(build, fn) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-opencode-home-"));
  const dbFile = path.join(homeDir, ".local", "share", "opencode", "opencode.db");
  const previous = process.env.HOME;
  try {
    build(dbFile, homeDir);
    process.env.HOME = homeDir;
    return await fn(dbFile, homeDir);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}
