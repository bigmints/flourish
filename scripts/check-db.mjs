#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const dataDir = resolve(process.env.FLOURISH_DATA_DIR ?? join(process.cwd(), "data"));
const databasePath = join(dataDir, "flourish.db");

if (!existsSync(databasePath)) {
  throw new Error(`Flourish database not found at ${databasePath}`);
}

const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  const quickCheck = database.prepare("PRAGMA quick_check").all().map((row) => String(row.quick_check));
  const foreignKeyProblems = database.prepare("PRAGMA foreign_key_check").all();
  const requiredTables = [
    "accounts",
    "loan_contracts",
    "loan_installments",
    "categories",
    "transactions",
    "transaction_postings",
    "monthly_savings_plans",
    "savings_goals",
    "wealth_assets",
    "recurring_items",
    "repayment_plans"
  ];
  const availableTables = new Set(
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name))
  );
  const missingTables = requiredTables.filter((table) => !availableTables.has(table));

  if (quickCheck.length !== 1 || quickCheck[0] !== "ok") {
    throw new Error(`SQLite quick check failed: ${quickCheck.join(", ")}`);
  }
  if (foreignKeyProblems.length > 0) {
    throw new Error(`SQLite foreign key check found ${foreignKeyProblems.length} problem(s)`);
  }
  if (missingTables.length > 0) {
    throw new Error(`Missing required tables: ${missingTables.join(", ")}`);
  }

  const counts = Object.fromEntries(
    ["accounts", "loan_contracts", "loan_installments", "transactions", "monthly_savings_plans", "savings_goals", "wealth_assets", "recurring_items"]
      .map((table) => [table, Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)])
  );

  console.log(JSON.stringify({ database: databasePath, bytes: statSync(databasePath).size, quickCheck: "ok", foreignKeyProblems: 0, counts }, null, 2));
} finally {
  database.close();
}
