import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { audit, getDb, inTransaction } from "@/lib/db";
import { monthBounds } from "@/lib/money";
import { zonedDateParts, zonedDateValue, zonedMonthValue } from "@/lib/time";
import { inferExpenseCategoryName } from "@/lib/categorization";
import { getCardsOverview } from "@/lib/cards";

type Row = Record<string, any>;

export type AccountType = "bank" | "cash" | "credit_card" | "personal_loan";
export type TransactionType = "expense" | "income" | "transfer" | "debt_payment" | "adjustment";

export type TransactionInput = {
  type: TransactionType;
  date: string;
  amountMinor: number;
  currency?: string;
  accountId: string;
  transferAccountId?: string | null;
  categoryId?: string | null;
  merchant?: string | null;
  note?: string | null;
  coverageStartMonth?: string | null;
  coverageEndMonth?: string | null;
  source?: "api" | "ui" | "hermes" | "import" | "recurring";
  idempotencyKey?: string | null;
  importRowId?: string | null;
  balanceDeltaMinor?: number;
  principalMinor?: number;
  interestMinor?: number;
  feeMinor?: number;
  splits?: Array<{ categoryId?: string | null; component?: "category" | "principal" | "interest" | "fee"; amountMinor: number }>;
};

const now = () => new Date().toISOString();

function camelKey(key: string) {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

export function camelize(row: Row | undefined): Row | null {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [camelKey(key), value]));
}

export function getSettings() {
  const rows = getDb().prepare("SELECT key, value FROM settings ORDER BY key").all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function updateSettings(values: Record<string, string>) {
  const allowed = new Set(["baseCurrency", "timeZone", "monthStart", "weekStart"]);
  const timestamp = now();
  inTransaction((db) => {
    const statement = db.prepare("INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
    for (const [key, value] of Object.entries(values)) {
      if (allowed.has(key)) statement.run(key, value, timestamp);
    }
  });
  audit("update", "settings", null, "api", { keys: Object.keys(values).filter((key) => allowed.has(key)) });
  return getSettings();
}

function accountBalanceSql() {
  return `a.opening_balance_minor + COALESCE((
    SELECT SUM(p.amount_minor)
    FROM transaction_postings p
    JOIN transactions t ON t.id = p.transaction_id
    WHERE p.account_id = a.id AND t.deleted_at IS NULL
  ), 0)`;
}

export function listAccounts(includeArchived = false) {
  const rows = getDb().prepare(`SELECT a.*, ${accountBalanceSql()} AS balance_minor FROM accounts a ${includeArchived ? "" : "WHERE a.archived_at IS NULL"} ORDER BY a.archived_at IS NOT NULL, a.name`).all() as Row[];
  return rows.map((row) => camelize(row));
}

export function getAccount(id: string) {
  return camelize(getDb().prepare(`SELECT a.*, ${accountBalanceSql()} AS balance_minor FROM accounts a WHERE a.id = ?`).get(id) as Row | undefined);
}

export function createAccount(input: Row) {
  if (input.idempotencyKey) {
    const existing = getDb().prepare("SELECT id FROM accounts WHERE idempotency_key = ?").get(input.idempotencyKey) as { id: string } | undefined;
    if (existing) return getAccount(existing.id);
  }
  const id = randomUUID();
  const timestamp = now();
  const settings = getSettings();
  getDb().prepare(`INSERT INTO accounts(
    id, name, type, currency, purpose, institution, prepayment_allowed, opening_balance_minor, credit_limit_minor, apr_bps, statement_day, due_day,
    last_statement_date, last_statement_balance_minor,
    minimum_payment_minor, minimum_payment_bps, original_principal_minor, installment_minor,
    remaining_term_months, next_due_date, idempotency_key, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      String(input.name),
      String(input.type),
      String(input.currency ?? settings.baseCurrency ?? "AED"),
      String(input.purpose ?? "spending"),
      input.institution ?? null,
      input.prepaymentAllowed ? 1 : 0,
      Number(input.openingBalanceMinor ?? 0),
      input.creditLimitMinor ?? null,
      input.aprBps ?? null,
      input.statementDay ?? null,
      input.dueDay ?? null,
      input.lastStatementDate ?? null,
      input.lastStatementBalanceMinor ?? null,
      input.minimumPaymentMinor ?? null,
      input.minimumPaymentBps ?? null,
      input.originalPrincipalMinor ?? null,
      input.installmentMinor ?? null,
      input.remainingTermMonths ?? null,
      input.nextDueDate ?? null,
      input.idempotencyKey ?? null,
      timestamp,
      timestamp
    );
  if (String(input.type) === "personal_loan") {
    getDb().prepare(`INSERT INTO loan_contracts(
      id, name, kind, institution, currency, account_id, included_in_card_balance,
      original_principal_minor, current_balance_minor, emi_minor, remaining_installments,
      apr_bps, next_due_date, prepayment_allowed, idempotency_key, created_at, updated_at
    ) VALUES (?, ?, 'personal_loan', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        String(input.name),
        input.institution ?? null,
        String(input.currency ?? settings.baseCurrency ?? "AED"),
        id,
        Number(input.originalPrincipalMinor ?? input.openingBalanceMinor ?? 0),
        Math.max(0, Number(input.openingBalanceMinor ?? 0)),
        input.installmentMinor ?? null,
        input.remainingTermMonths ?? null,
        input.aprBps ?? null,
        input.nextDueDate ?? null,
        input.prepaymentAllowed ? 1 : 0,
        `account:${id}`,
        timestamp,
        timestamp
      );
  }
  audit("create", "account", id, String(input.source ?? "api"), { name: input.name, type: input.type });
  return getAccount(id);
}

export function updateAccount(id: string, input: Row) {
  const current = getAccount(id);
  if (!current) return null;
  const fields: Record<string, any> = {
    name: input.name,
    currency: input.currency,
    purpose: input.purpose,
    institution: input.institution,
    prepayment_allowed: input.prepaymentAllowed === undefined ? undefined : input.prepaymentAllowed ? 1 : 0,
    opening_balance_minor: input.openingBalanceMinor,
    credit_limit_minor: input.creditLimitMinor,
    apr_bps: input.aprBps,
    statement_day: input.statementDay,
    due_day: input.dueDay,
    last_statement_date: input.lastStatementDate,
    last_statement_balance_minor: input.lastStatementBalanceMinor,
    minimum_payment_minor: input.minimumPaymentMinor,
    minimum_payment_bps: input.minimumPaymentBps,
    original_principal_minor: input.originalPrincipalMinor,
    installment_minor: input.installmentMinor,
    remaining_term_months: input.remainingTermMonths,
    next_due_date: input.nextDueDate,
    archived_at: input.archived === true ? now() : input.archived === false ? null : undefined
  };
  const present = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (present.length) {
    const assignments = [...present.map(([key]) => `${key} = ?`), "updated_at = ?"].join(", ");
    getDb().prepare(`UPDATE accounts SET ${assignments} WHERE id = ?`).run(...present.map(([, value]) => value), now(), id);
  }
  if (current.type === "personal_loan") {
    const contractFields: Record<string, any> = {
      name: input.name,
      currency: input.currency,
      institution: input.institution,
      original_principal_minor: input.originalPrincipalMinor,
      emi_minor: input.installmentMinor,
      remaining_installments: input.remainingTermMonths,
      apr_bps: input.aprBps,
      next_due_date: input.nextDueDate,
      prepayment_allowed: input.prepaymentAllowed === undefined ? undefined : input.prepaymentAllowed ? 1 : 0,
      archived_at: input.archived === true ? now() : input.archived === false ? null : undefined
    };
    const contractPresent = Object.entries(contractFields).filter(([, value]) => value !== undefined);
    if (contractPresent.length) {
      const assignments = [...contractPresent.map(([key]) => `${key} = ?`), "updated_at = ?"].join(", ");
      getDb().prepare(`UPDATE loan_contracts SET ${assignments} WHERE account_id = ?`).run(...contractPresent.map(([, value]) => value), now(), id);
    }
  }
  audit("update", "account", id, String(input.source ?? "api"), { fields: present.map(([key]) => key) });
  return getAccount(id);
}

export function listCategories(includeArchived = false) {
  const rows = getDb().prepare(`SELECT * FROM categories ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY kind, sort_order, name`).all() as Row[];
  return rows.map((row) => camelize(row));
}

export function createCategory(input: Row) {
  const id = randomUUID();
  const timestamp = now();
  getDb().prepare("INSERT INTO categories(id, name, kind, color, icon, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, String(input.name), String(input.kind ?? "expense"), String(input.color ?? "#5f8f76"), String(input.icon ?? "circle"), Number(input.sortOrder ?? 100), timestamp, timestamp);
  audit("create", "category", id, String(input.source ?? "api"), { name: input.name });
  return camelize(getDb().prepare("SELECT * FROM categories WHERE id = ?").get(id) as Row);
}

export function updateCategory(id: string, input: Row) {
  const fields: Record<string, any> = {
    name: input.name,
    color: input.color,
    icon: input.icon,
    sort_order: input.sortOrder,
    archived_at: input.archived === true ? now() : input.archived === false ? null : undefined
  };
  const present = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (!present.length) return camelize(getDb().prepare("SELECT * FROM categories WHERE id = ?").get(id) as Row | undefined);
  getDb().prepare(`UPDATE categories SET ${present.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...present.map(([, value]) => value), now(), id);
  audit("update", "category", id, String(input.source ?? "api"), { fields: present.map(([key]) => key) });
  return camelize(getDb().prepare("SELECT * FROM categories WHERE id = ?").get(id) as Row | undefined);
}

function rawAccount(db: DatabaseSync, id: string) {
  return db.prepare("SELECT id, type FROM accounts WHERE id = ? AND archived_at IS NULL").get(id) as { id: string; type: AccountType } | undefined;
}

function accountEffect(accountType: AccountType, direction: "source" | "destination", amount: number) {
  const liability = accountType === "credit_card" || accountType === "personal_loan";
  if (direction === "source") return liability ? amount : -amount;
  return liability ? -amount : amount;
}

function writeTransactionChildren(db: DatabaseSync, transactionId: string, input: TransactionInput) {
  const account = rawAccount(db, input.accountId);
  if (!account) throw new Error("Account not found");
  const postings: Array<{ accountId: string; amount: number }> = [];
  const splits = input.splits ? [...input.splits] : [];

  if (input.type === "expense") postings.push({ accountId: account.id, amount: accountEffect(account.type, "source", input.amountMinor) });
  if (input.type === "income") postings.push({ accountId: account.id, amount: accountEffect(account.type, "destination", input.amountMinor) });
  if (input.type === "adjustment") postings.push({ accountId: account.id, amount: Number(input.balanceDeltaMinor ?? input.amountMinor) });

  if (input.type === "transfer" || input.type === "debt_payment") {
    if (!input.transferAccountId) throw new Error("A destination account is required");
    const destination = rawAccount(db, input.transferAccountId);
    if (!destination) throw new Error("Destination account not found");
    if (input.type === "debt_payment" && destination.type !== "credit_card" && destination.type !== "personal_loan") throw new Error("A debt payment must go to a credit card or personal loan");
    postings.push({ accountId: account.id, amount: accountEffect(account.type, "source", input.amountMinor) });
    const interestMinor = Number(input.interestMinor ?? splits.filter((split) => split.component === "interest").reduce((sum, split) => sum + split.amountMinor, 0));
    const feeMinor = Number(input.feeMinor ?? splits.filter((split) => split.component === "fee").reduce((sum, split) => sum + split.amountMinor, 0));
    const principalMinor = input.type === "debt_payment" ? Number(input.principalMinor ?? Math.max(0, input.amountMinor - interestMinor - feeMinor)) : input.amountMinor;
    postings.push({ accountId: destination.id, amount: accountEffect(destination.type, "destination", principalMinor) });
    if (input.type === "debt_payment" && !input.splits) {
      splits.push({ component: "principal", amountMinor: principalMinor });
      if (interestMinor) splits.push({ categoryId: input.categoryId, component: "interest", amountMinor: interestMinor });
      if (feeMinor) splits.push({ categoryId: input.categoryId, component: "fee", amountMinor: feeMinor });
    }
  }

  const postingStatement = db.prepare("INSERT INTO transaction_postings(id, transaction_id, account_id, amount_minor) VALUES (?, ?, ?, ?)");
  postings.forEach((posting) => postingStatement.run(randomUUID(), transactionId, posting.accountId, posting.amount));
  const splitStatement = db.prepare("INSERT INTO transaction_splits(id, transaction_id, category_id, component, amount_minor) VALUES (?, ?, ?, ?, ?)");
  splits.forEach((split) => splitStatement.run(randomUUID(), transactionId, split.categoryId ?? null, split.component ?? "category", split.amountMinor));
}

function applyExpenseCategory(input: TransactionInput): TransactionInput {
  if (input.type !== "expense") return input;
  const description = `${input.merchant ?? ""} ${input.note ?? ""}`.trim();
  if (!description) return input;
  const inferredName = inferExpenseCategoryName(description);
  if (input.categoryId && inferredName !== "Work") return input;
  const category = getDb().prepare("SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND kind = 'expense' AND archived_at IS NULL").get(inferredName) as { id: string } | undefined;
  return category ? { ...input, categoryId: category.id } : input;
}

function validateCoverage(input: TransactionInput) {
  const hasStart = Boolean(input.coverageStartMonth);
  const hasEnd = Boolean(input.coverageEndMonth);
  if (hasStart !== hasEnd) throw new Error("Choose both coverage months");
  if (hasStart && input.coverageEndMonth! < input.coverageStartMonth!) throw new Error("Coverage end must be on or after coverage start");
  if (hasStart && input.type !== "expense") throw new Error("Coverage months are only available for expenses");
}

export function createTransaction(input: TransactionInput) {
  if (input.idempotencyKey) {
    const existing = getDb().prepare("SELECT id FROM transactions WHERE idempotency_key = ?").get(input.idempotencyKey) as { id: string } | undefined;
    if (existing) return getTransaction(existing.id);
  }
  const categorizedInput = applyExpenseCategory(input);
  validateCoverage(categorizedInput);
  const id = randomUUID();
  const timestamp = now();
  const currency = categorizedInput.currency ?? String(getSettings().baseCurrency ?? "AED");
  inTransaction((db) => {
    db.prepare(`INSERT INTO transactions(
      id, type, date, amount_minor, currency, account_id, transfer_account_id, category_id,
      merchant, note, coverage_start_month, coverage_end_month, source, idempotency_key, import_row_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, categorizedInput.type, categorizedInput.date, categorizedInput.amountMinor, currency, categorizedInput.accountId, categorizedInput.transferAccountId ?? null, categorizedInput.categoryId ?? null, categorizedInput.merchant ?? null, categorizedInput.note ?? null, categorizedInput.coverageStartMonth ?? null, categorizedInput.coverageEndMonth ?? null, categorizedInput.source ?? "api", categorizedInput.idempotencyKey ?? null, categorizedInput.importRowId ?? null, timestamp, timestamp);
    writeTransactionChildren(db, id, categorizedInput);
  });
  audit("create", "transaction", id, categorizedInput.source ?? "api", { type: categorizedInput.type, amountMinor: categorizedInput.amountMinor, date: categorizedInput.date, categoryId: categorizedInput.categoryId ?? null });
  return getTransaction(id);
}

export function getTransaction(id: string): Record<string, any> | null {
  const row = getDb().prepare(`SELECT t.*, a.name AS account_name, ta.name AS transfer_account_name, c.name AS category_name
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    LEFT JOIN accounts ta ON ta.id = t.transfer_account_id LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.id = ?`).get(id) as Row | undefined;
  if (!row) return null;
  const splits = getDb().prepare(`SELECT s.*, c.name AS category_name FROM transaction_splits s LEFT JOIN categories c ON c.id = s.category_id WHERE s.transaction_id = ?`).all(id) as Row[];
  return { ...camelize(row)!, splits: splits.map((split) => camelize(split)!) };
}

export function listTransactions(filters: { start?: string; end?: string; accountId?: string; categoryId?: string; type?: string; search?: string; limit?: number } = {}) {
  const clauses = ["t.deleted_at IS NULL"];
  const values: any[] = [];
  if (filters.start) { clauses.push("t.date >= ?"); values.push(filters.start); }
  if (filters.end) { clauses.push("t.date <= ?"); values.push(filters.end); }
  if (filters.accountId) { clauses.push("(t.account_id = ? OR t.transfer_account_id = ?)"); values.push(filters.accountId, filters.accountId); }
  if (filters.categoryId) { clauses.push("(t.category_id = ? OR EXISTS(SELECT 1 FROM transaction_splits sx WHERE sx.transaction_id = t.id AND sx.category_id = ?))"); values.push(filters.categoryId, filters.categoryId); }
  if (filters.type) { clauses.push("t.type = ?"); values.push(filters.type); }
  if (filters.search) { clauses.push("(t.merchant LIKE ? OR t.note LIKE ?)"); values.push(`%${filters.search}%`, `%${filters.search}%`); }
  values.push(Math.min(500, Math.max(1, filters.limit ?? 100)));
  const rows = getDb().prepare(`SELECT t.*, a.name AS account_name, ta.name AS transfer_account_name, c.name AS category_name
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    LEFT JOIN accounts ta ON ta.id = t.transfer_account_id LEFT JOIN categories c ON c.id = t.category_id
    WHERE ${clauses.join(" AND ")} ORDER BY t.date DESC, t.created_at DESC LIMIT ?`).all(...values) as Row[];
  return rows.map((row) => camelize(row));
}

export function updateTransaction(id: string, patch: Partial<TransactionInput>) {
  const existing = getDb().prepare("SELECT * FROM transactions WHERE id = ? AND deleted_at IS NULL").get(id) as Row | undefined;
  if (!existing) return null;
  const input = applyExpenseCategory({
    type: (patch.type ?? existing.type) as TransactionType,
    date: String(patch.date ?? existing.date),
    amountMinor: Number(patch.amountMinor ?? existing.amount_minor),
    currency: String(patch.currency ?? existing.currency),
    accountId: String(patch.accountId ?? existing.account_id),
    transferAccountId: patch.transferAccountId !== undefined ? patch.transferAccountId : existing.transfer_account_id as string | null,
    categoryId: patch.categoryId !== undefined ? patch.categoryId : existing.category_id as string | null,
    merchant: patch.merchant !== undefined ? patch.merchant : existing.merchant as string | null,
    note: patch.note !== undefined ? patch.note : existing.note as string | null,
    coverageStartMonth: patch.coverageStartMonth !== undefined ? patch.coverageStartMonth : existing.coverage_start_month as string | null,
    coverageEndMonth: patch.coverageEndMonth !== undefined ? patch.coverageEndMonth : existing.coverage_end_month as string | null,
    source: patch.source ?? existing.source as TransactionInput["source"],
    balanceDeltaMinor: patch.balanceDeltaMinor,
    principalMinor: patch.principalMinor,
    interestMinor: patch.interestMinor,
    feeMinor: patch.feeMinor,
    splits: patch.splits
  });
  validateCoverage(input);
  inTransaction((db) => {
    db.prepare(`UPDATE transactions SET type=?, date=?, amount_minor=?, currency=?, account_id=?, transfer_account_id=?, category_id=?, merchant=?, note=?, coverage_start_month=?, coverage_end_month=?, source=?, updated_at=? WHERE id=?`)
      .run(input.type, input.date, input.amountMinor, input.currency!, input.accountId, input.transferAccountId ?? null, input.categoryId ?? null, input.merchant ?? null, input.note ?? null, input.coverageStartMonth ?? null, input.coverageEndMonth ?? null, input.source ?? "api", now(), id);
    db.prepare("DELETE FROM transaction_splits WHERE transaction_id = ?").run(id);
    db.prepare("DELETE FROM transaction_postings WHERE transaction_id = ?").run(id);
    writeTransactionChildren(db, id, input);
  });
  audit("update", "transaction", id, input.source ?? "api", { fields: Object.keys(patch) });
  return getTransaction(id);
}

export function deleteTransaction(id: string, source = "api") {
  const result = getDb().prepare("UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(now(), now(), id);
  if (Number(result.changes) > 0) audit("delete", "transaction", id, source, {});
  return Number(result.changes) > 0;
}

function spendingByCategory(start: string, end: string, excludeCoveredExpenses = false) {
  const rows = getDb().prepare(`
    WITH split_totals AS (
      SELECT transaction_id, SUM(amount_minor) AS total FROM transaction_splits WHERE component = 'category' GROUP BY transaction_id
    ), spending AS (
      SELECT COALESCE(s.category_id, t.category_id) AS category_id,
        SUM(CASE WHEN s.id IS NOT NULL THEN s.amount_minor ELSE t.amount_minor END) AS spent_minor
      FROM transactions t
      LEFT JOIN split_totals st ON st.transaction_id = t.id
      LEFT JOIN transaction_splits s ON s.transaction_id = t.id AND s.component = 'category'
      WHERE t.deleted_at IS NULL AND t.type = 'expense' AND t.date BETWEEN ? AND ?
        ${excludeCoveredExpenses ? "AND t.coverage_start_month IS NULL" : ""}
        AND (st.total IS NULL OR s.id IS NOT NULL)
      GROUP BY COALESCE(s.category_id, t.category_id)
    ), debt_costs AS (
      SELECT s.category_id, SUM(s.amount_minor) AS spent_minor
      FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
      WHERE t.deleted_at IS NULL AND t.type = 'debt_payment' AND s.component IN ('interest','fee') AND t.date BETWEEN ? AND ?
      GROUP BY s.category_id
    )
    , category_rows AS (
      SELECT c.id AS category_id, c.name AS category_name, c.color,
        COALESCE(sp.spent_minor,0) + COALESCE(dc.spent_minor,0) AS spent_minor,
        c.sort_order
      FROM categories c LEFT JOIN spending sp ON sp.category_id = c.id LEFT JOIN debt_costs dc ON dc.category_id = c.id
      WHERE c.kind = 'expense' AND c.archived_at IS NULL
    ), uncategorized AS (
      SELECT NULL AS category_id, 'Uncategorized' AS category_name, '#858b87' AS color,
        COALESCE((SELECT spent_minor FROM spending WHERE category_id IS NULL), 0) +
        COALESCE((SELECT spent_minor FROM debt_costs WHERE category_id IS NULL), 0) AS spent_minor,
        2147483647 AS sort_order
    )
    SELECT category_id, category_name, color, spent_minor
    FROM (
      SELECT * FROM category_rows
      UNION ALL
      SELECT * FROM uncategorized WHERE spent_minor > 0
    )
    ORDER BY spent_minor DESC, sort_order
  `).all(start, end, start, end) as Row[];
  return rows.map((row) => camelize(row));
}

function shiftMonth(month: string, offset: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1 + offset, 1)).toISOString().slice(0, 7);
}

export function getSpendingPatterns(month: string, monthCount = 6) {
  monthBounds(month);
  const count = Math.min(12, Math.max(2, Math.trunc(monthCount) || 6));
  const trendMonths = Array.from({ length: count }, (_, index) => shiftMonth(month, index - count + 1));
  const categoryByMonth = new Map<string, Array<Record<string, any>>>();

  for (const value of trendMonths) {
    const { start, end } = monthBounds(value);
    categoryByMonth.set(value, spendingByCategory(start, end) as Array<Record<string, any>>);
  }

  const previousMonth = shiftMonth(month, -1);
  if (!categoryByMonth.has(previousMonth)) {
    const { start, end } = monthBounds(previousMonth);
    categoryByMonth.set(previousMonth, spendingByCategory(start, end) as Array<Record<string, any>>);
  }

  const totalFor = (value: string) => (categoryByMonth.get(value) ?? []).reduce((sum, line) => sum + Number(line.spentMinor), 0);
  const totalSpentMinor = totalFor(month);
  const previousSpentMinor = totalFor(previousMonth);
  const previousByCategory = new Map((categoryByMonth.get(previousMonth) ?? []).map((line) => [String(line.categoryId), Number(line.spentMinor)]));
  const categories = (categoryByMonth.get(month) ?? [])
    .filter((line) => Number(line.spentMinor) > 0)
    .map((line) => {
      const spentMinor = Number(line.spentMinor);
      const previousCategorySpentMinor = previousByCategory.get(String(line.categoryId)) ?? 0;
      return {
        ...line,
        spentMinor,
        sharePercentage: totalSpentMinor > 0 ? Math.round(spentMinor / totalSpentMinor * 100) : 0,
        previousSpentMinor: previousCategorySpentMinor,
        changeMinor: spentMinor - previousCategorySpentMinor,
        changePercentage: previousCategorySpentMinor > 0 ? Math.round((spentMinor - previousCategorySpentMinor) / previousCategorySpentMinor * 1000) / 10 : null
      };
    });

  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const settings = getSettings();
  const local = zonedDateParts(String(settings.timeZone ?? "Asia/Dubai"));
  const localMonth = `${local.year}-${local.month}`;
  const observedDays = month < localMonth ? daysInMonth : month === localMonth ? Number(local.day) : 0;

  return {
    month,
    totalSpentMinor,
    previousMonth,
    previousSpentMinor,
    changeMinor: totalSpentMinor - previousSpentMinor,
    changePercentage: previousSpentMinor > 0 ? Math.round((totalSpentMinor - previousSpentMinor) / previousSpentMinor * 1000) / 10 : null,
    observedDays,
    dailyAverageMinor: observedDays > 0 ? Math.round(totalSpentMinor / observedDays) : 0,
    topCategory: categories[0] ?? null,
    categories,
    monthlyTrend: trendMonths.map((value) => ({ month: value, spentMinor: totalFor(value) }))
  };
}

function weightedAverage(values: number[]) {
  if (!values.length) return 0;
  const weightTotal = values.reduce((sum, _, index) => sum + index + 1, 0);
  return Math.round(values.reduce((sum, value, index) => sum + value * (index + 1), 0) / weightTotal);
}

function forecastRange(values: number[], expected: number) {
  if (expected <= 0) return { lowerMinor: 0, upperMinor: 0, volatilityPercentage: 0 };
  if (values.length < 2) return { lowerMinor: Math.round(expected * 0.85), upperMinor: Math.round(expected * 1.15), volatilityPercentage: 15 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  const spread = Math.max(expected * 0.1, deviation);
  return {
    lowerMinor: Math.max(0, Math.round(expected - spread)),
    upperMinor: Math.round(expected + spread),
    volatilityPercentage: Math.round(deviation / Math.max(1, mean) * 100)
  };
}

function recurringTotalsForMonth(month: string) {
  const { start, end } = monthBounds(month);
  let expenseMinor = 0;
  let incomeMinor = 0;
  const items: Array<{ name: string; merchant: string; categoryName: string | null; type: string; amountMinor: number; occurrences: number }> = [];
  for (const item of listRecurring()) {
    let date = String(item.nextDate);
    let guard = 0;
    while (date < start && guard < 1200) {
      date = advanceDate(date, String(item.cadence), Number(item.intervalCount));
      guard += 1;
    }
    let occurrences = 0;
    while (date <= end && guard < 1200) {
      occurrences += 1;
      date = advanceDate(date, String(item.cadence), Number(item.intervalCount));
      guard += 1;
    }
    const transaction = item.transaction as TransactionInput;
    const total = Number(transaction.amountMinor ?? 0) * occurrences;
    if (transaction.type === "expense") expenseMinor += total;
    if (transaction.type === "income") incomeMinor += total;
    if (occurrences > 0 && (transaction.type === "expense" || transaction.type === "income")) {
      const category = transaction.categoryId ? getDb().prepare("SELECT name FROM categories WHERE id = ?").get(transaction.categoryId) as { name: string } | undefined : undefined;
      items.push({ name: String(item.name), merchant: String(transaction.merchant ?? item.name), categoryName: category?.name ?? null, type: transaction.type, amountMinor: total, occurrences });
    }
  }
  return { expenseMinor, incomeMinor, items };
}

function prepaidRenewalsForMonth(month: string, recurringItems: Array<{ merchant: string; type: string }>) {
  const priorMonth = shiftMonth(month, -1);
  const recurringMerchants = new Set(recurringItems.filter((item) => item.type === "expense").map((item) => item.merchant.trim().toLowerCase()));
  const rows = getDb().prepare(`SELECT t.id, t.amount_minor, t.merchant, t.note, t.coverage_start_month, t.coverage_end_month,
      c.name AS category_name
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.deleted_at IS NULL AND t.type = 'expense' AND t.coverage_start_month IS NOT NULL
      AND t.coverage_end_month = ?
    ORDER BY t.date DESC`).all(priorMonth) as Row[];
  return rows
    .map((row) => ({
      id: String(row.id),
      merchant: String(row.merchant ?? row.note ?? "Covered expense"),
      categoryName: row.category_name ? String(row.category_name) : "Other",
      amountMinor: Number(row.amount_minor),
      priorCoverageStartMonth: String(row.coverage_start_month),
      priorCoverageEndMonth: String(row.coverage_end_month),
      expectedMonth: month
    }))
    .filter((item) => !recurringMerchants.has(item.merchant.trim().toLowerCase()));
}

export function getFinancialForecast(sourceMonth = zonedMonthValue(String(getSettings().timeZone ?? "Asia/Dubai"))) {
  monthBounds(sourceMonth);
  const settings = getSettings();
  const local = zonedDateParts(String(settings.timeZone ?? "Asia/Dubai"));
  const localMonth = `${local.year}-${local.month}`;
  const sourceMonths = Array.from({ length: 6 }, (_, index) => shiftMonth(sourceMonth, index - 5));
  const observations = sourceMonths.map((month) => {
    const { start, end } = monthBounds(month);
    const row = getDb().prepare(`SELECT COUNT(*) AS transaction_count,
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount_minor ELSE 0 END), 0) AS income_minor
      FROM transactions WHERE deleted_at IS NULL AND date BETWEEN ? AND ?`).get(start, end) as { transaction_count: number; income_minor: number };
    const categories = spendingByCategory(start, end, true) as Array<Record<string, any>>;
    const debtCost = getDb().prepare(`SELECT COALESCE(SUM(s.amount_minor),0) AS amount
      FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
      WHERE t.deleted_at IS NULL AND t.type = 'debt_payment' AND s.component IN ('interest','fee')
        AND t.date BETWEEN ? AND ?`).get(start, end) as { amount: number };
    const spentMinor = categories.reduce((sum, category) => sum + Number(category.spentMinor), 0);
    const [year, monthNumber] = month.split("-").map(Number);
    const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const observedDays = month === localMonth ? Number(local.day) : daysInMonth;
    const scale = month === localMonth && observedDays > 0 ? daysInMonth / observedDays : 1;
    const projectedCategories: Array<Record<string, any>> = categories
      .filter((category) => Number(category.spentMinor) > 0)
      .map((category) => ({ ...category, spentMinor: Math.round(Number(category.spentMinor) * scale) }));
    return {
      month,
      transactionCount: Number(row.transaction_count),
      observedDays,
      normalizedSpentMinor: Math.round(spentMinor * scale),
      normalizedDebtCostMinor: Math.round(Number(debtCost.amount) * scale),
      normalizedIncomeMinor: Number(row.income_minor),
      categories: projectedCategories
    };
  }).filter((observation) => observation.transactionCount > 0);

  const forecastMonth = shiftMonth(sourceMonth, 1);
  const recurring = recurringTotalsForMonth(forecastMonth);
  const prepaidRenewals = prepaidRenewalsForMonth(forecastMonth, recurring.items);
  const prepaidRenewalMinor = prepaidRenewals.reduce((sum, item) => sum + item.amountMinor, 0);
  const spendingValues = observations.map((observation) => observation.normalizedSpentMinor);
  const incomeValues = observations.map((observation) => observation.normalizedIncomeMinor).filter((value) => value > 0);
  const historyStart = monthBounds(sourceMonths[0]).start;
  const historyEnd = monthBounds(sourceMonth).end;
  const unseenRecurringExpenses = recurring.items.filter((item) => item.type === "expense").filter((item) => {
    const existing = getDb().prepare("SELECT 1 FROM transactions WHERE deleted_at IS NULL AND type = 'expense' AND date BETWEEN ? AND ? AND lower(COALESCE(merchant, note, '')) = lower(?) LIMIT 1")
      .get(historyStart, historyEnd, item.merchant);
    return !existing;
  });
  const unseenRecurringExpenseMinor = unseenRecurringExpenses.reduce((sum, item) => sum + item.amountMinor, 0);
  const expectedSpentMinor = Math.max(weightedAverage(spendingValues) + unseenRecurringExpenseMinor, recurring.expenseMinor) + prepaidRenewalMinor;
  const expectedIncomeMinor = Math.max(weightedAverage(incomeValues), recurring.incomeMinor);
  const range = forecastRange(spendingValues, expectedSpentMinor);

  const categoryNames = new Set(observations.flatMap((observation) => observation.categories.map((category) => String(category.categoryName))));
  const categories = [...categoryNames].map((categoryName) => {
    const values = observations.map((observation) => Number(observation.categories.find((category) => category.categoryName === categoryName)?.spentMinor ?? 0));
    return { categoryName, expectedMinor: weightedAverage(values) };
  });
  for (const item of unseenRecurringExpenses) {
    const categoryName = item.categoryName ?? "Other";
    const existing = categories.find((category) => category.categoryName === categoryName);
    if (existing) existing.expectedMinor += item.amountMinor;
    else categories.push({ categoryName, expectedMinor: item.amountMinor });
  }
  for (const item of prepaidRenewals) {
    const existing = categories.find((category) => category.categoryName === item.categoryName);
    if (existing) existing.expectedMinor += item.amountMinor;
    else categories.push({ categoryName: item.categoryName, expectedMinor: item.amountMinor });
  }
  categories.sort((a, b) => b.expectedMinor - a.expectedMinor);

  const forecastLoans = (getDb().prepare(`SELECT lc.id, lc.name, lc.linked_card_id, lc.emi_minor,
      CASE WHEN lc.account_id IS NOT NULL THEN MAX(0, a.opening_balance_minor + COALESCE((
        SELECT SUM(p.amount_minor) FROM transaction_postings p
        JOIN transactions t ON t.id = p.transaction_id
        WHERE p.account_id = a.id AND t.deleted_at IS NULL
      ), 0)) ELSE lc.current_balance_minor END AS balance_minor
    FROM loan_contracts lc LEFT JOIN accounts a ON a.id = lc.account_id
    WHERE lc.archived_at IS NULL`).all() as Row[]).map((loan) => {
    const balance = Math.max(0, Number(loan.balance_minor ?? 0));
    const paymentMinor = Math.min(balance, Math.max(0, Number(loan.emi_minor ?? 0)));
    return { id: String(loan.id), name: String(loan.name ?? "Loan"), linkedCardId: loan.linked_card_id ? String(loan.linked_card_id) : null, balanceMinor: balance, paymentMinor };
  });
  const loanPaymentMinor = forecastLoans.reduce((sum, loan) => sum + loan.paymentMinor, 0);
  const standaloneLoanPaymentMinor = forecastLoans.filter((loan) => !loan.linkedCardId).reduce((sum, loan) => sum + loan.paymentMinor, 0);
  const cardLinkedEmiMinor = forecastLoans.filter((loan) => loan.linkedCardId).reduce((sum, loan) => sum + loan.paymentMinor, 0);
  const missingDebtPaymentDebts = forecastLoans
    .filter((debt) => debt.balanceMinor > 0 && debt.paymentMinor <= 0)
    .map(({ id, name }) => ({ id, name }));
  const debtPaymentComplete = missingDebtPaymentDebts.length === 0;
  const cardOverview = getCardsOverview();
  const forecastCards = cardOverview.cards.filter((card) => String(card.currency) === String(settings.baseCurrency));
  const cardStatementDueMinor = forecastCards.reduce((sum, card) => sum + Number(card.statementDueMinor ?? 0), 0);
  const missingCardStatementCards = forecastCards
    .filter((card) => Number(card.currentOutstandingMinor) > 0 && !card.statementComplete)
    .map((card) => ({ id: String(card.id), name: String(card.name) }));
  const cardsWithStatements = new Set(forecastCards.filter((card) => card.statementComplete).map((card) => String(card.id)));
  const cardLinkedEmiOutsideStatementMinor = forecastLoans
    .filter((loan) => loan.linkedCardId && !cardsWithStatements.has(loan.linkedCardId))
    .reduce((sum, loan) => sum + loan.paymentMinor, 0);
  const loanCommitmentOutsideCardStatementsMinor = standaloneLoanPaymentMinor + cardLinkedEmiOutsideStatementMinor;
  const capacityComplete = debtPaymentComplete && missingCardStatementCards.length === 0;
  const totalCommitmentMinor = loanCommitmentOutsideCardStatementsMinor + cardStatementDueMinor;
  const savingsTarget = getDb().prepare(`SELECT COALESCE(SUM(monthly_target_minor), 0) AS amount
    FROM monthly_savings_plans WHERE archived_at IS NULL AND start_month <= ? AND (end_month IS NULL OR end_month >= ?)`)
    .get(forecastMonth, forecastMonth) as { amount: number };
  const savingsTargetMinor = Number(savingsTarget.amount);
  const expectedDebtCostMinor = weightedAverage(observations.map((observation) => observation.normalizedDebtCostMinor));
  const expectedEverydaySpentMinor = Math.max(0, expectedSpentMinor - expectedDebtCostMinor);
  const availableToSaveMinor = expectedIncomeMinor - expectedEverydaySpentMinor - totalCommitmentMinor;
  const savingsTargetGapMinor = availableToSaveMinor - savingsTargetMinor;
  const currentObservation = observations.find((observation) => observation.month === sourceMonth);
  const confidence = observations.length >= 4 && range.volatilityPercentage <= 35 ? "high" : observations.length >= 2 ? "medium" : "low";

  return {
    sourceMonth,
    forecastMonth,
    currency: settings.baseCurrency,
    expectedSpentMinor,
    expectedIncomeMinor,
    lowerSpentMinor: range.lowerMinor,
    upperSpentMinor: range.upperMinor,
    debtPaymentMinor: loanPaymentMinor,
    loanPaymentMinor,
    standaloneLoanPaymentMinor,
    cardLinkedEmiMinor,
    cardLinkedEmiOutsideStatementMinor,
    loanCommitmentOutsideCardStatementsMinor,
    cardStatementDueMinor,
    totalCommitmentMinor,
    debtPaymentComplete,
    missingDebtPaymentDebts,
    cardStatementComplete: missingCardStatementCards.length === 0,
    missingCardStatementCards,
    capacityComplete,
    missingCommitmentAccounts: [...missingDebtPaymentDebts, ...missingCardStatementCards],
    savingsTargetMinor,
    expectedDebtCostMinor,
    expectedEverydaySpentMinor,
    availableToSaveMinor,
    savingsTargetGapMinor,
    availableAfterCommitmentsMinor: availableToSaveMinor,
    recurringExpenseMinor: recurring.expenseMinor,
    recurringIncomeMinor: recurring.incomeMinor,
    newRecurringExpenseMinor: unseenRecurringExpenseMinor,
    prepaidRenewalMinor,
    prepaidRenewals,
    currentMonthProjectedMinor: currentObservation?.normalizedSpentMinor ?? 0,
    confidence,
    volatilityPercentage: range.volatilityPercentage,
    dataMonthCount: observations.length,
    categories,
    recurringItems: recurring.items,
    assumptions: [
      "Recent months count more than older months",
      sourceMonth === localMonth ? `Current month is projected from ${Number(local.day)} recorded days` : "Completed months use their recorded totals",
      "Loan EMIs and card statement amounts are shown separately from everyday spending",
      debtPaymentComplete ? "All active loans have an EMI amount" : `EMI missing for ${missingDebtPaymentDebts.map((debt) => debt.name).join(", ")}`,
      missingCardStatementCards.length === 0 ? "All active cards have statement data" : `Statement data missing for ${missingCardStatementCards.map((card) => card.name).join(", ")}`,
      "The savings target is compared with capacity and never counted as spending"
    ]
  };
}

export function getBudget(month: string) {
  const { start, end } = monthBounds(month);
  const spending = spendingByCategory(start, end) as Array<Row>;
  const spentMap = new Map(spending.map((row) => [String(row.categoryId), Number(row.spentMinor)]));
  const rows = getDb().prepare(`SELECT c.id AS category_id, c.name AS category_name, c.color, COALESCE(b.limit_minor,0) AS limit_minor, COALESCE(b.rollover,0) AS rollover
    FROM categories c LEFT JOIN budgets b ON b.category_id = c.id AND b.month = ?
    WHERE c.kind = 'expense' AND c.archived_at IS NULL ORDER BY c.sort_order, c.name`).all(month) as Row[];
  const lines: Array<Record<string, any>> = rows.map((row): Record<string, any> => {
    const value = camelize(row)!;
    const spentMinor = spentMap.get(String(value.categoryId)) ?? 0;
    const limitMinor = Number(value.limitMinor);
    return { ...value, spentMinor, remainingMinor: limitMinor - spentMinor, percentage: limitMinor > 0 ? Math.round(spentMinor / limitMinor * 100) : 0 };
  });
  const totalSpentMinor = spending.reduce((sum, line) => sum + Number(line.spentMinor), 0);
  const categorizedSpentMinor = lines.reduce((sum, line) => sum + Number(line.spentMinor), 0);
  return { month, lines, totalLimitMinor: lines.reduce((sum, line) => sum + Number(line.limitMinor), 0), totalSpentMinor, unbudgetedSpentMinor: totalSpentMinor - categorizedSpentMinor };
}

export function putBudget(month: string, lines: Array<{ categoryId: string; limitMinor: number; rollover?: boolean }>) {
  inTransaction((db) => {
    const statement = db.prepare("INSERT INTO budgets(month, category_id, limit_minor, rollover, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(month, category_id) DO UPDATE SET limit_minor=excluded.limit_minor, rollover=excluded.rollover, updated_at=excluded.updated_at");
    lines.forEach((line) => statement.run(month, line.categoryId, line.limitMinor, line.rollover ? 1 : 0, now()));
  });
  audit("update", "budget", month, "api", { lineCount: lines.length });
  return getBudget(month);
}

export function copyBudget(month: string, sourceMonth: string) {
  getDb().prepare(`INSERT INTO budgets(month, category_id, limit_minor, rollover, updated_at)
    SELECT ?, category_id, limit_minor, rollover, ? FROM budgets WHERE month = ?
    ON CONFLICT(month, category_id) DO UPDATE SET limit_minor=excluded.limit_minor, rollover=excluded.rollover, updated_at=excluded.updated_at`).run(month, now(), sourceMonth);
  audit("copy", "budget", month, "api", { sourceMonth });
  return getBudget(month);
}

function savingsProgressSql() {
  return `g.opening_saved_minor + COALESCE(SUM(CASE
    WHEN e.deleted_at IS NULL AND e.kind = 'contribution' THEN e.amount_minor
    WHEN e.deleted_at IS NULL AND e.kind = 'withdrawal' THEN -e.amount_minor
    ELSE 0 END), 0)`;
}

function decorateSavingsGoal(row: Row, entries?: Row[]): Record<string, any> {
  const goal = camelize(row) as Row;
  const savedMinor = Number(goal.savedMinor ?? goal.openingSavedMinor ?? 0);
  const targetMinor = Number(goal.targetMinor);
  const remainingMinor = Math.max(0, targetMinor - savedMinor);
  const today = zonedDateValue(String(getSettings().timeZone ?? "Asia/Dubai"));
  const targetDate = goal.targetDate ? String(goal.targetDate) : null;
  let status = savedMinor >= targetMinor ? "completed" : savedMinor > 0 ? "in_progress" : "not_started";
  if (remainingMinor > 0 && targetDate && targetDate < today) status = "overdue";
  let monthsRemaining: number | null = null;
  let requiredMonthlyMinor: number | null = null;
  if (targetDate && remainingMinor > 0 && targetDate >= today) {
    const current = new Date(`${today}T00:00:00Z`);
    const target = new Date(`${targetDate}T00:00:00Z`);
    monthsRemaining = Math.max(1, (target.getUTCFullYear() - current.getUTCFullYear()) * 12 + target.getUTCMonth() - current.getUTCMonth() + 1);
    requiredMonthlyMinor = Math.ceil(remainingMinor / monthsRemaining);
  }
  return {
    ...goal,
    savedMinor,
    remainingMinor,
    percentage: Math.min(100, Math.round(savedMinor / targetMinor * 100)),
    status,
    monthsRemaining,
    requiredMonthlyMinor,
    ...(entries ? { entries: entries.map((entry) => camelize(entry)!) } : {})
  };
}

export function listSavingsGoals(includeArchived = false) {
  const database = getDb();
  const rows = database.prepare(`SELECT g.*, ${savingsProgressSql()} AS saved_minor
    FROM savings_goals g LEFT JOIN savings_entries e ON e.goal_id = g.id
    ${includeArchived ? "" : "WHERE g.archived_at IS NULL"}
    GROUP BY g.id
    ORDER BY g.archived_at IS NOT NULL, g.target_date IS NULL, g.target_date, g.sort_order, g.created_at`).all() as Row[];
  const entries = database.prepare("SELECT * FROM savings_entries WHERE goal_id = ? AND deleted_at IS NULL ORDER BY date DESC, created_at DESC");
  return rows.map((row) => decorateSavingsGoal(row, entries.all(row.id) as Row[]));
}

export function getSavingsGoal(id: string) {
  const row = getDb().prepare(`SELECT g.*, ${savingsProgressSql()} AS saved_minor
    FROM savings_goals g LEFT JOIN savings_entries e ON e.goal_id = g.id
    WHERE g.id = ? GROUP BY g.id`).get(id) as Row | undefined;
  if (!row) return null;
  const entries = getDb().prepare("SELECT * FROM savings_entries WHERE goal_id = ? AND deleted_at IS NULL ORDER BY date DESC, created_at DESC").all(id) as Row[];
  return decorateSavingsGoal(row, entries);
}

export function createSavingsGoal(input: Row) {
  if (input.idempotencyKey) {
    const existing = getDb().prepare("SELECT id FROM savings_goals WHERE idempotency_key = ?").get(input.idempotencyKey) as { id: string } | undefined;
    if (existing) return getSavingsGoal(existing.id);
  }
  const id = randomUUID();
  const timestamp = now();
  getDb().prepare(`INSERT INTO savings_goals(
    id,name,target_minor,opening_saved_minor,target_date,note,color,sort_order,idempotency_key,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.name, input.targetMinor, input.openingSavedMinor ?? 0, input.targetDate ?? null,
    input.note ?? null, input.color ?? "#5f8f76", input.sortOrder ?? 0, input.idempotencyKey ?? null, timestamp, timestamp
  );
  audit("create", "savings_goal", id, String(input.source ?? "api"), { name: input.name, targetMinor: input.targetMinor });
  return getSavingsGoal(id);
}

export function updateSavingsGoal(id: string, input: Row) {
  if (!getSavingsGoal(id)) return null;
  const fields: Record<string, any> = {
    name: input.name,
    target_minor: input.targetMinor,
    target_date: input.targetDate,
    note: input.note,
    color: input.color,
    sort_order: input.sortOrder,
    archived_at: input.archived === true ? now() : input.archived === false ? null : undefined
  };
  const present = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (present.length) getDb().prepare(`UPDATE savings_goals SET ${present.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...present.map(([, value]) => value), now(), id);
  audit("update", "savings_goal", id, String(input.source ?? "api"), { fields: present.map(([key]) => key) });
  return getSavingsGoal(id);
}

export function addSavingsEntry(goalId: string, input: Row) {
  if (input.idempotencyKey) {
    const existing = getDb().prepare("SELECT id, goal_id FROM savings_entries WHERE idempotency_key = ?").get(input.idempotencyKey) as { id: string; goal_id: string } | undefined;
    if (existing) return { entry: camelize(getDb().prepare("SELECT * FROM savings_entries WHERE id = ?").get(existing.id) as Row), goal: getSavingsGoal(existing.goal_id) };
  }
  const id = randomUUID();
  const timestamp = now();
  inTransaction((db) => {
    const goal = db.prepare(`SELECT g.id, g.archived_at, ${savingsProgressSql()} AS saved_minor
      FROM savings_goals g LEFT JOIN savings_entries e ON e.goal_id = g.id WHERE g.id = ? GROUP BY g.id`).get(goalId) as Row | undefined;
    if (!goal || goal.archived_at) throw new Error("Savings objective not found");
    if (input.kind === "withdrawal" && Number(goal.saved_minor) < Number(input.amountMinor)) throw new Error("Withdrawal cannot exceed the amount saved");
    db.prepare("INSERT INTO savings_entries(id,goal_id,kind,amount_minor,date,note,source,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, goalId, input.kind, input.amountMinor, input.date, input.note ?? null, input.source ?? "api", input.idempotencyKey ?? null, timestamp);
  });
  audit("create", "savings_entry", id, String(input.source ?? "api"), { goalId, kind: input.kind, amountMinor: input.amountMinor });
  return { entry: camelize(getDb().prepare("SELECT * FROM savings_entries WHERE id = ?").get(id) as Row), goal: getSavingsGoal(goalId) };
}

export function deleteSavingsEntry(goalId: string, entryId: string, source = "api") {
  const result = getDb().prepare("UPDATE savings_entries SET deleted_at = ? WHERE id = ? AND goal_id = ? AND deleted_at IS NULL").run(now(), entryId, goalId);
  if (!Number(result.changes)) return null;
  audit("delete", "savings_entry", entryId, source, { goalId });
  return getSavingsGoal(goalId);
}

export function getDashboard(month = zonedMonthValue(String(getSettings().timeZone ?? "Asia/Dubai"))) {
  const { start, end } = monthBounds(month);
  const totals = getDb().prepare(`SELECT
    COALESCE(SUM(CASE WHEN type='expense' THEN amount_minor ELSE 0 END),0) AS spent_minor,
    COALESCE(SUM(CASE WHEN type='income' THEN amount_minor ELSE 0 END),0) AS income_minor
    FROM transactions WHERE deleted_at IS NULL AND date BETWEEN ? AND ?`).get(start, end) as Row;
  const debtCosts = getDb().prepare(`SELECT COALESCE(SUM(s.amount_minor),0) AS amount FROM transaction_splits s JOIN transactions t ON t.id=s.transaction_id
    WHERE t.deleted_at IS NULL AND t.type='debt_payment' AND s.component IN ('interest','fee') AND t.date BETWEEN ? AND ?`).get(start, end) as { amount: number };
  const accounts = listAccounts();
  const debts = accounts.filter((account) => account?.type === "personal_loan");
  const cards = getCardsOverview();
  const recurring = listRecurring().filter((item) => String(item.nextDate) >= start && String(item.nextDate) <= end).slice(0, 5);
  const budget = getBudget(month);
  return {
    month,
    currency: getSettings().baseCurrency,
    spentMinor: Number(totals.spent_minor) + Number(debtCosts.amount),
    incomeMinor: Number(totals.income_minor),
    savings: getSavingsPosition(month),
    budget,
    accounts,
    debts,
    cards,
    upcoming: recurring,
    recentTransactions: listTransactions({ start, end, limit: 8 }),
    spendingByCategory: spendingByCategory(start, end)
  };
}

export function getSavingsPosition(month = zonedMonthValue(String(getSettings().timeZone ?? "Asia/Dubai"))) {
  const { start, end } = monthBounds(month);
  const accounts = listAccounts().filter((account) => account?.purpose === "savings" && (account.type === "bank" || account.type === "cash"));
  const accountIds = accounts.map((account) => String(account?.id));
  let movementMinor = 0;
  if (accountIds.length) {
    const placeholders = accountIds.map(() => "?").join(",");
    const row = getDb().prepare(`SELECT COALESCE(SUM(p.amount_minor),0) AS amount
      FROM transaction_postings p JOIN transactions t ON t.id = p.transaction_id
      WHERE t.deleted_at IS NULL AND t.date BETWEEN ? AND ? AND p.account_id IN (${placeholders})`)
      .get(start, end, ...accountIds) as { amount: number };
    movementMinor = Number(row.amount);
  }
  const totalsByCurrency = Object.values(accounts.reduce<Record<string, { currency: string; balanceMinor: number }>>((totals, account) => {
    const currency = String(account?.currency ?? getSettings().baseCurrency ?? "AED");
    totals[currency] ??= { currency, balanceMinor: 0 };
    totals[currency].balanceMinor += Number(account?.balanceMinor ?? 0);
    return totals;
  }, {}));
  const baseCurrency = String(getSettings().baseCurrency ?? "AED");
  return {
    month,
    currency: baseCurrency,
    totalBalanceMinor: totalsByCurrency.find((total) => total.currency === baseCurrency)?.balanceMinor ?? 0,
    movementMinor,
    totalsByCurrency,
    accounts
  };
}

export function listDebts() {
  return listAccounts().filter((account) => account?.type === "personal_loan");
}

export function listRecurring(): Array<Record<string, any>> {
  return (getDb().prepare("SELECT * FROM recurring_items WHERE archived_at IS NULL ORDER BY next_date, name").all() as Row[]).map((row) => ({ ...camelize(row)!, transaction: JSON.parse(String(row.transaction_json)) }));
}

export function getRecurring(id: string): Record<string, any> | null {
  const row = getDb().prepare("SELECT * FROM recurring_items WHERE id = ?").get(id) as Row | undefined;
  return row ? { ...camelize(row)!, transaction: JSON.parse(String(row.transaction_json)) } : null;
}

export function createRecurring(input: Row) {
  if (input.idempotencyKey) {
    const existing = getDb().prepare("SELECT id FROM recurring_items WHERE idempotency_key = ?").get(input.idempotencyKey) as { id: string } | undefined;
    if (existing) return getRecurring(existing.id);
  }
  const id = randomUUID();
  const timestamp = now();
  getDb().prepare("INSERT INTO recurring_items(id,name,transaction_json,cadence,interval_count,next_date,auto_create,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(id, input.name, JSON.stringify(input.transaction ?? {}), input.cadence, input.intervalCount ?? 1, input.nextDate, input.autoCreate ? 1 : 0, input.idempotencyKey ?? null, timestamp, timestamp);
  audit("create", "recurring_item", id, String(input.source ?? "api"), { name: input.name });
  return getRecurring(id);
}

export function updateRecurring(id: string, input: Row) {
  const current = getRecurring(id);
  if (!current) return null;
  const fields: Record<string, any> = { name: input.name, transaction_json: input.transaction ? JSON.stringify(input.transaction) : undefined, cadence: input.cadence, interval_count: input.intervalCount, next_date: input.nextDate, auto_create: input.autoCreate === undefined ? undefined : input.autoCreate ? 1 : 0, archived_at: input.archived === true ? now() : undefined };
  const present = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (present.length) getDb().prepare(`UPDATE recurring_items SET ${present.map(([key]) => `${key}=?`).join(",")}, updated_at=? WHERE id=?`).run(...present.map(([, value]) => value), now(), id);
  audit("update", "recurring_item", id, String(input.source ?? "api"), { fields: present.map(([key]) => key) });
  return getRecurring(id);
}

function advanceDate(date: string, cadence: string, interval: number) {
  const [year, month, day] = date.split("-").map(Number);
  if (cadence === "weekly") {
    const value = new Date(Date.UTC(year, month - 1, day + 7 * interval));
    return value.toISOString().slice(0, 10);
  }
  const monthIndex = month - 1 + (cadence === "monthly" ? interval : interval * 12);
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

export function recordRecurring(id: string) {
  const item = getRecurring(id);
  if (!item) return null;
  const template = item.transaction as unknown as TransactionInput;
  const transaction = createTransaction({ ...template, date: String(item.nextDate), source: "recurring", idempotencyKey: `recurring:${id}:${String(item.nextDate)}` });
  getDb().prepare("UPDATE recurring_items SET last_recorded_date=?, next_date=?, updated_at=? WHERE id=?").run(item.nextDate, advanceDate(String(item.nextDate), String(item.cadence), Number(item.intervalCount)), now(), id);
  return { recurringItem: getRecurring(id), transaction };
}

export function saveRepaymentPlan(input: { name: string; strategy: string; monthlyAmountMinor: number; simulationInput: unknown; result: unknown; active?: boolean }) {
  const id = randomUUID();
  const timestamp = now();
  inTransaction((db) => {
    if (input.active) db.prepare("UPDATE repayment_plans SET active=0").run();
    db.prepare("INSERT INTO repayment_plans(id,name,strategy,monthly_amount_minor,input_json,result_json,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, input.name, input.strategy, input.monthlyAmountMinor, JSON.stringify(input.simulationInput), JSON.stringify(input.result), input.active ? 1 : 0, timestamp, timestamp);
  });
  audit("create", "repayment_plan", id, "api", { strategy: input.strategy, active: input.active });
  return getActiveRepaymentPlan(input.active ? undefined : id);
}

export function getActiveRepaymentPlan(id?: string) {
  const row = getDb().prepare(id ? "SELECT * FROM repayment_plans WHERE id=?" : "SELECT * FROM repayment_plans WHERE active=1 ORDER BY updated_at DESC LIMIT 1").get(...(id ? [id] : [])) as Row | undefined;
  return row ? { ...camelize(row), input: JSON.parse(String(row.input_json)), result: JSON.parse(String(row.result_json)) } : null;
}

export function getAuditEvents(limit = 100) {
  return (getDb().prepare("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?").all(Math.min(limit, 500)) as Row[]).map((row) => ({ ...camelize(row), summary: JSON.parse(String(row.summary_json)) }));
}
