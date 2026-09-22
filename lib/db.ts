import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CATEGORIZATION_RULES_VERSION, isWorkRelatedExpense } from "@/lib/categorization";

declare global {
  // eslint-disable-next-line no-var
  var __flourishDb: DatabaseSync | undefined;
}

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('bank','cash','credit_card','personal_loan')),
  currency TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'spending' CHECK(purpose IN ('spending','savings')),
  institution TEXT,
  prepayment_allowed INTEGER NOT NULL DEFAULT 0,
  opening_balance_minor INTEGER NOT NULL DEFAULT 0,
  credit_limit_minor INTEGER,
  apr_bps INTEGER,
  statement_day INTEGER,
  due_day INTEGER,
  last_statement_date TEXT,
  last_statement_balance_minor INTEGER,
  minimum_payment_minor INTEGER,
  minimum_payment_bps INTEGER,
  original_principal_minor INTEGER,
  installment_minor INTEGER,
  remaining_term_months INTEGER,
  next_due_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS loan_contracts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'personal_loan' CHECK(kind IN ('personal_loan','balance_transfer','card_installment','other')),
  institution TEXT,
  currency TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  linked_card_id TEXT REFERENCES accounts(id),
  included_in_card_balance INTEGER NOT NULL DEFAULT 0,
  original_principal_minor INTEGER NOT NULL DEFAULT 0 CHECK(original_principal_minor >= 0),
  current_balance_minor INTEGER NOT NULL DEFAULT 0 CHECK(current_balance_minor >= 0),
  emi_minor INTEGER,
  total_installments INTEGER,
  remaining_installments INTEGER,
  apr_bps INTEGER,
  next_due_date TEXT,
  prepayment_allowed INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  CHECK(account_id IS NULL OR linked_card_id IS NULL),
  CHECK(linked_card_id IS NOT NULL OR included_in_card_balance = 0)
);

CREATE TABLE IF NOT EXISTS loan_installments (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES loan_contracts(id),
  paid_date TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  principal_minor INTEGER NOT NULL CHECK(principal_minor >= 0),
  interest_minor INTEGER NOT NULL DEFAULT 0 CHECK(interest_minor >= 0),
  fee_minor INTEGER NOT NULL DEFAULT 0 CHECK(fee_minor >= 0),
  transaction_id TEXT REFERENCES transactions(id),
  note TEXT,
  source TEXT NOT NULL DEFAULT 'api' CHECK(source IN ('api','ui','hermes')),
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  kind TEXT NOT NULL DEFAULT 'expense' CHECK(kind IN ('expense','income')),
  color TEXT NOT NULL DEFAULT '#5f8f76',
  icon TEXT NOT NULL DEFAULT 'circle',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('expense','income','transfer','debt_payment','adjustment')),
  date TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
  currency TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  transfer_account_id TEXT REFERENCES accounts(id),
  category_id TEXT REFERENCES categories(id),
  merchant TEXT,
  note TEXT,
  coverage_start_month TEXT,
  coverage_end_month TEXT,
  source TEXT NOT NULL DEFAULT 'api' CHECK(source IN ('api','ui','hermes','import','recurring')),
  idempotency_key TEXT UNIQUE,
  import_row_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS transaction_splits (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES categories(id),
  component TEXT NOT NULL DEFAULT 'category' CHECK(component IN ('category','principal','interest','fee')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0)
);

CREATE TABLE IF NOT EXISTS transaction_postings (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount_minor INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS budgets (
  month TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(id),
  limit_minor INTEGER NOT NULL CHECK(limit_minor >= 0),
  rollover INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(month, category_id)
);

CREATE TABLE IF NOT EXISTS savings_goals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_minor INTEGER NOT NULL CHECK(target_minor > 0),
  opening_saved_minor INTEGER NOT NULL DEFAULT 0 CHECK(opening_saved_minor >= 0),
  target_date TEXT,
  note TEXT,
  color TEXT NOT NULL DEFAULT '#5f8f76',
  sort_order INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS savings_entries (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES savings_goals(id),
  kind TEXT NOT NULL CHECK(kind IN ('contribution','withdrawal')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  date TEXT NOT NULL,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'api' CHECK(source IN ('api','ui','hermes','import','recurring')),
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS monthly_savings_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  monthly_target_minor INTEGER NOT NULL CHECK(monthly_target_minor > 0),
  start_month TEXT NOT NULL,
  end_month TEXT,
  note TEXT,
  color TEXT NOT NULL DEFAULT '#5f8f76',
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS monthly_savings_checkins (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES monthly_savings_plans(id),
  month TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('contribution','withdrawal')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  note TEXT,
  source TEXT NOT NULL DEFAULT 'api' CHECK(source IN ('api','ui','hermes','import','recurring')),
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS wealth_assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('mutual_fund','savings_account','fixed_deposit','stock','bond','crypto','real_estate','other')),
  institution TEXT,
  currency TEXT NOT NULL,
  opening_invested_minor INTEGER NOT NULL DEFAULT 0 CHECK(opening_invested_minor >= 0),
  note TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS wealth_snapshots (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES wealth_assets(id),
  current_value_minor INTEGER NOT NULL CHECK(current_value_minor >= 0),
  invested_value_minor INTEGER CHECK(invested_value_minor >= 0),
  as_of_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'api' CHECK(source IN ('api','ui','hermes','import','recurring')),
  source_draft_id TEXT,
  note TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS wealth_cash_flows (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES wealth_assets(id),
  kind TEXT NOT NULL CHECK(kind IN ('contribution','withdrawal','income','fee')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  date TEXT NOT NULL,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'api' CHECK(source IN ('api','ui','hermes','import','recurring')),
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS wealth_import_drafts (
  id TEXT PRIMARY KEY,
  source_filename TEXT NOT NULL,
  source_sha256 TEXT,
  captured_at TEXT,
  institution TEXT,
  proposals_json TEXT NOT NULL,
  extraction_notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','applied','cancelled')),
  source TEXT NOT NULL DEFAULT 'hermes' CHECK(source IN ('api','ui','hermes','import','recurring')),
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  cancelled_at TEXT
);

CREATE TABLE IF NOT EXISTS recurring_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transaction_json TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK(cadence IN ('weekly','monthly','yearly')),
  interval_count INTEGER NOT NULL DEFAULT 1,
  next_date TEXT NOT NULL,
  auto_create INTEGER NOT NULL DEFAULT 0,
  last_recorded_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS import_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  file_type TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  profile_id TEXT REFERENCES import_profiles(id),
  filename TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('preview','applied','cancelled')),
  row_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  invalid_count INTEGER NOT NULL DEFAULT 0,
  total_in_minor INTEGER NOT NULL DEFAULT 0,
  total_out_minor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE TABLE IF NOT EXISTS import_rows (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready','duplicate','invalid','ignored','applied')),
  error TEXT,
  UNIQUE(batch_id, row_number)
);

CREATE TABLE IF NOT EXISTS repayment_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK(strategy IN ('avalanche','snowball','fixed')),
  monthly_amount_minor INTEGER NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  source TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_postings_account ON transaction_postings(account_id);
CREATE INDEX IF NOT EXISTS idx_savings_entries_goal ON savings_entries(goal_id, date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_monthly_savings_checkins_plan ON monthly_savings_checkins(plan_id, month DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wealth_snapshots_asset ON wealth_snapshots(asset_id, as_of_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wealth_cash_flows_asset ON wealth_cash_flows(asset_id, date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wealth_import_drafts_status ON wealth_import_drafts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_rows_fingerprint ON import_rows(fingerprint);
CREATE UNIQUE INDEX IF NOT EXISTS idx_applied_file_account ON import_batches(account_id, file_hash) WHERE status = 'applied';
`;

function now() {
  return new Date().toISOString();
}

function seed(database: DatabaseSync) {
  const timestamp = now();
  const insertSetting = database.prepare("INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES (?, ?, ?)");
  insertSetting.run("baseCurrency", process.env.FLOURISH_BASE_CURRENCY ?? "AED", timestamp);
  insertSetting.run("timeZone", process.env.FLOURISH_TIMEZONE ?? "Asia/Dubai", timestamp);
  insertSetting.run("monthStart", "1", timestamp);
  insertSetting.run("weekStart", "monday", timestamp);

  const categoryCount = Number((database.prepare("SELECT COUNT(*) AS count FROM categories").get() as { count: number }).count);
  if (categoryCount === 0) {
    const defaults = [
      ["Groceries", "expense", "#5f8f76", "shopping-basket"],
      ["Dining", "expense", "#d18b5b", "utensils"],
      ["Transport", "expense", "#6f88a9", "car"],
      ["Home", "expense", "#9a7bb0", "house"],
      ["Health", "expense", "#c96f72", "heart-pulse"],
      ["Shopping", "expense", "#bd8a56", "shopping-bag"],
      ["Entertainment", "expense", "#7b86bd", "clapperboard"],
      ["Work", "expense", "#4d7f95", "briefcase-business"],
      ["Bills", "expense", "#708b8b", "receipt"],
      ["Interest & fees", "expense", "#a56b6b", "landmark"],
      ["Other", "expense", "#858b87", "circle-ellipsis"],
      ["Salary", "income", "#4f9470", "wallet-cards"],
      ["Other income", "income", "#5c8e91", "badge-dollar-sign"]
    ];
    const insert = database.prepare("INSERT INTO categories(id, name, kind, color, icon, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    defaults.forEach((item, index) => insert.run(randomUUID(), ...item, index, timestamp, timestamp));
  }

  let workCategory = database.prepare("SELECT id FROM categories WHERE name = 'Work' COLLATE NOCASE").get() as { id: string } | undefined;
  if (!workCategory) {
    const id = randomUUID();
    database.prepare("INSERT INTO categories(id, name, kind, color, icon, sort_order, created_at, updated_at) VALUES (?, 'Work', 'expense', '#4d7f95', 'briefcase-business', 8, ?, ?)")
      .run(id, timestamp, timestamp);
    workCategory = { id };
  }

  const categorizationVersion = database.prepare("SELECT value FROM settings WHERE key = 'categorizationRulesVersion'").get() as { value: string } | undefined;
  if (categorizationVersion?.value !== CATEGORIZATION_RULES_VERSION) {
    const candidates = database.prepare("SELECT id, merchant, note FROM transactions WHERE deleted_at IS NULL AND type = 'expense'").all() as Array<{ id: string; merchant: string | null; note: string | null }>;
    const updateTransaction = database.prepare("UPDATE transactions SET category_id = ?, updated_at = ? WHERE id = ?");
    const updateSplits = database.prepare("UPDATE transaction_splits SET category_id = ? WHERE transaction_id = ? AND component = 'category'");
    let updated = 0;
    for (const transaction of candidates) {
      if (!isWorkRelatedExpense(`${transaction.merchant ?? ""} ${transaction.note ?? ""}`)) continue;
      updateTransaction.run(workCategory.id, timestamp, transaction.id);
      updateSplits.run(workCategory.id, transaction.id);
      updated += 1;
    }
    database.prepare("INSERT INTO settings(key, value, updated_at) VALUES ('categorizationRulesVersion', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(CATEGORIZATION_RULES_VERSION, timestamp);
    if (updated > 0) {
      database.prepare("INSERT INTO audit_events(id, action, entity_type, entity_id, source, summary_json, created_at) VALUES (?, 'reclassify', 'transactions', NULL, 'api', ?, ?)")
        .run(randomUUID(), JSON.stringify({ category: "Work", updated }), timestamp);
    }
  }
}

export function getDb() {
  if (global.__flourishDb) return global.__flourishDb;
  const dataDir = resolve(process.env.FLOURISH_DATA_DIR ?? join(process.cwd(), "data"));
  mkdirSync(dataDir, { recursive: true });
  const database = new DatabaseSync(join(dataDir, "flourish.db"));
  database.exec(schema);
  const accountColumns = new Set((database.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!accountColumns.has("purpose")) database.exec("ALTER TABLE accounts ADD COLUMN purpose TEXT NOT NULL DEFAULT 'spending' CHECK(purpose IN ('spending','savings'))");
  if (!accountColumns.has("institution")) database.exec("ALTER TABLE accounts ADD COLUMN institution TEXT");
  if (!accountColumns.has("prepayment_allowed")) database.exec("ALTER TABLE accounts ADD COLUMN prepayment_allowed INTEGER NOT NULL DEFAULT 0");
  if (!accountColumns.has("idempotency_key")) database.exec("ALTER TABLE accounts ADD COLUMN idempotency_key TEXT");
  if (!accountColumns.has("last_statement_date")) database.exec("ALTER TABLE accounts ADD COLUMN last_statement_date TEXT");
  if (!accountColumns.has("last_statement_balance_minor")) database.exec("ALTER TABLE accounts ADD COLUMN last_statement_balance_minor INTEGER");
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_idempotency ON accounts(idempotency_key) WHERE idempotency_key IS NOT NULL");
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_loan_contracts_account ON loan_contracts(account_id) WHERE account_id IS NOT NULL");
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_loan_contracts_idempotency ON loan_contracts(idempotency_key) WHERE idempotency_key IS NOT NULL");
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_loan_installments_idempotency ON loan_installments(idempotency_key) WHERE idempotency_key IS NOT NULL");
  const migrationTimestamp = now();
  database.prepare(`INSERT INTO loan_contracts(
      id, name, kind, institution, currency, account_id, linked_card_id, included_in_card_balance,
      original_principal_minor, current_balance_minor, emi_minor, total_installments, remaining_installments,
      apr_bps, next_due_date, prepayment_allowed, idempotency_key, created_at, updated_at, archived_at
    )
    SELECT a.id, a.name, 'personal_loan', a.institution, a.currency, a.id, NULL, 0,
      COALESCE(a.original_principal_minor, a.opening_balance_minor),
      MAX(0, a.opening_balance_minor + COALESCE((
        SELECT SUM(p.amount_minor) FROM transaction_postings p
        JOIN transactions t ON t.id = p.transaction_id
        WHERE p.account_id = a.id AND t.deleted_at IS NULL
      ), 0)),
      a.installment_minor, NULL, a.remaining_term_months, a.apr_bps, a.next_due_date,
      a.prepayment_allowed, 'account:' || a.id, ?, ?, a.archived_at
    FROM accounts a
    WHERE a.type = 'personal_loan'
      AND NOT EXISTS (SELECT 1 FROM loan_contracts lc WHERE lc.account_id = a.id)`)
    .run(migrationTimestamp, migrationTimestamp);
  database.prepare(`UPDATE loan_contracts
    SET emi_minor = CAST(ROUND(current_balance_minor * 1.0 / remaining_installments) AS INTEGER),
        updated_at = ?
    WHERE current_balance_minor > 0
      AND remaining_installments > 0
      AND (emi_minor IS NULL OR emi_minor <= 0)`)
    .run(migrationTimestamp);
  database.prepare(`UPDATE accounts
    SET installment_minor = (
          SELECT lc.emi_minor FROM loan_contracts lc WHERE lc.account_id = accounts.id
        ),
        updated_at = ?
    WHERE type = 'personal_loan'
      AND (installment_minor IS NULL OR installment_minor <= 0)
      AND EXISTS (
        SELECT 1 FROM loan_contracts lc
        WHERE lc.account_id = accounts.id AND lc.emi_minor > 0
      )`)
    .run(migrationTimestamp);
  const recurringColumns = new Set((database.prepare("PRAGMA table_info(recurring_items)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!recurringColumns.has("idempotency_key")) database.exec("ALTER TABLE recurring_items ADD COLUMN idempotency_key TEXT");
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_recurring_idempotency ON recurring_items(idempotency_key) WHERE idempotency_key IS NOT NULL");
  const transactionColumns = new Set((database.prepare("PRAGMA table_info(transactions)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!transactionColumns.has("coverage_start_month")) database.exec("ALTER TABLE transactions ADD COLUMN coverage_start_month TEXT");
  if (!transactionColumns.has("coverage_end_month")) database.exec("ALTER TABLE transactions ADD COLUMN coverage_end_month TEXT");
  seed(database);
  global.__flourishDb = database;
  return database;
}

export function inTransaction<T>(run: (database: DatabaseSync) => T): T {
  const database = getDb();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = run(database);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function audit(action: string, entityType: string, entityId: string | null, source: string, summary: unknown) {
  getDb()
    .prepare("INSERT INTO audit_events(id, action, entity_type, entity_id, source, summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), action, entityType, entityId, source, JSON.stringify(summary), now());
}

export function closeDbForTests() {
  global.__flourishDb?.close();
  global.__flourishDb = undefined;
}
