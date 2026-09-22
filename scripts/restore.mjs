#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const sourceArg = process.argv[2];
if (!sourceArg) throw new Error("Usage: node scripts/restore.mjs /absolute/path/to/flourish-backup.db");
const source = resolve(sourceArg);
if (!existsSync(source) || !/^flourish-.*\.db$/.test(basename(source))) throw new Error("Restore source must be an existing Flourish .db backup");
const check = new DatabaseSync(source, { readOnly: true });
const integrity = check.prepare("PRAGMA integrity_check").get();
check.close();
if (!integrity || Object.values(integrity)[0] !== "ok") throw new Error("Backup failed SQLite integrity check");
const dataDir = resolve(process.env.FLOURISH_DATA_DIR ?? join(process.cwd(), "data"));
mkdirSync(dataDir, { recursive: true });
const target = join(dataDir, "flourish.db");
if (existsSync(target)) copyFileSync(target, join(dataDir, `flourish-pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}.db`));
copyFileSync(source, target);
console.log(JSON.stringify({ restored: source, target, integrity: "ok" }));
