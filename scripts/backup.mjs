#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const dataDir = resolve(process.env.FLOURISH_DATA_DIR ?? join(process.cwd(), "data"));
const backupDir = resolve(process.env.FLOURISH_BACKUP_DIR ?? join(process.cwd(), "backups"));
mkdirSync(backupDir, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = join(backupDir, `flourish-${timestamp}.db`);
const escaped = target.replace(/'/g, "''");
const database = new DatabaseSync(join(dataDir, "flourish.db"));
database.exec(`VACUUM INTO '${escaped}'`);
database.close();
const cutoff = Date.now() - Number(process.env.FLOURISH_BACKUP_RETENTION_DAYS ?? 30) * 86_400_000;
for (const file of readdirSync(backupDir).filter((name) => /^flourish-.*\.db$/.test(name))) {
  const path = join(backupDir, file);
  if (path !== target && statSync(path).mtimeMs < cutoff) unlinkSync(path);
}
console.log(JSON.stringify({ backup: target, bytes: statSync(target).size }));
