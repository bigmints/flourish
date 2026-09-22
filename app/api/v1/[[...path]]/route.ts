import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import {
  copyBudget,
  createAccount,
  createCategory,
  createRecurring,
  createSavingsGoal,
  createTransaction,
  addSavingsEntry,
  deleteSavingsEntry,
  deleteTransaction,
  getAccount,
  getActiveRepaymentPlan,
  getAuditEvents,
  getBudget,
  getDashboard,
  getFinancialForecast,
  getRecurring,
  getSavingsGoal,
  getSpendingPatterns,
  getSettings,
  getSavingsPosition,
  getTransaction,
  listAccounts,
  listCategories,
  listRecurring,
  listSavingsGoals,
  listTransactions,
  putBudget,
  recordRecurring,
  saveRepaymentPlan,
  updateAccount,
  updateCategory,
  updateRecurring,
  updateSavingsGoal,
  updateSettings,
  updateTransaction
} from "@/lib/store";
import {
  applyImport,
  createImportProfile,
  deleteImportProfile,
  getImport,
  listImportProfiles,
  previewImport,
  updateImport,
  updateImportProfile
} from "@/lib/imports";
import { compareRepaymentPlans, simulateRepayment, type RepaymentDebt } from "@/lib/repayment";
import { getCard, getCardsOverview, listCards } from "@/lib/cards";
import { createLoan, getLoan, getLoansOverview, listLoans, recordLoanInstallment, repaymentLoanInputs, updateLoan } from "@/lib/loans";
import { getDb } from "@/lib/db";
import { zonedMonthValue } from "@/lib/time";
import {
  addMonthlySavingsCheckin,
  addWealthCashFlow,
  addWealthSnapshot,
  applyWealthImportDraft,
  cancelWealthImportDraft,
  createMonthlySavingsPlan,
  createWealthAsset,
  createWealthImportDraft,
  deleteMonthlySavingsCheckin,
  deleteWealthRecord,
  getMonthlySavingsPlan,
  getWealthAsset,
  getWealthImportDraft,
  getWealthOverview,
  listMonthlySavingsPlans,
  listWealthAssets,
  listWealthImportDrafts,
  updateMonthlySavingsPlan,
  updateWealthAsset
} from "@/lib/planning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ path?: string[] }> };
type JsonObject = Record<string, unknown>;

const accountSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["bank", "cash", "credit_card", "personal_loan"]),
  currency: z.string().length(3).optional(),
  purpose: z.enum(["spending", "savings"]).optional(),
  institution: z.string().max(160).nullable().optional(),
  prepaymentAllowed: z.boolean().optional(),
  openingBalanceMinor: z.number().int().optional(),
  creditLimitMinor: z.number().int().nonnegative().nullable().optional(),
  aprBps: z.number().int().nonnegative().nullable().optional(),
  statementDay: z.number().int().min(1).max(31).nullable().optional(),
  dueDay: z.number().int().min(1).max(31).nullable().optional(),
  lastStatementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  lastStatementBalanceMinor: z.number().int().nonnegative().nullable().optional(),
  minimumPaymentMinor: z.number().int().nonnegative().nullable().optional(),
  minimumPaymentBps: z.number().int().nonnegative().nullable().optional(),
  originalPrincipalMinor: z.number().int().nonnegative().nullable().optional(),
  installmentMinor: z.number().int().nonnegative().nullable().optional(),
  remainingTermMonths: z.number().int().nonnegative().nullable().optional(),
  nextDueDate: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  source: z.string().optional()
});

const loanBaseSchema = z.object({
  name: z.string().min(1).max(160),
  kind: z.enum(["personal_loan", "balance_transfer", "card_installment", "other"]),
  institution: z.string().max(160).nullable().optional(),
  currency: z.string().length(3).optional(),
  linkedCardId: z.string().uuid().nullable().optional(),
  includedInCardBalance: z.boolean().optional(),
  originalPrincipalMinor: z.number().int().nonnegative(),
  currentBalanceMinor: z.number().int().nonnegative(),
  emiMinor: z.number().int().nonnegative().nullable().optional(),
  totalInstallments: z.number().int().positive().nullable().optional(),
  remainingInstallments: z.number().int().nonnegative().nullable().optional(),
  aprBps: z.number().int().nonnegative().nullable().optional(),
  nextDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  prepaymentAllowed: z.boolean().optional(),
  archived: z.boolean().optional(),
  source: z.enum(["api", "ui", "hermes"]).optional()
});
const loanSchema = loanBaseSchema.refine((value) => value.remainingInstallments == null || value.totalInstallments == null || value.remainingInstallments <= value.totalInstallments, { message: "Remaining EMIs cannot exceed total EMIs", path: ["remainingInstallments"] });

const loanInstallmentSchema = z.object({
  paidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountMinor: z.number().int().positive(),
  principalMinor: z.number().int().nonnegative().optional(),
  interestMinor: z.number().int().nonnegative().optional(),
  feeMinor: z.number().int().nonnegative().optional(),
  transactionId: z.string().uuid().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  idempotencyKey: z.string().max(200).nullable().optional(),
  source: z.enum(["api", "ui", "hermes"]).optional()
});

const transactionSchema = z.object({
  type: z.enum(["expense", "income", "transfer", "debt_payment", "adjustment"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().length(3).optional(),
  accountId: z.string().uuid(),
  transferAccountId: z.string().uuid().nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  merchant: z.string().max(200).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  coverageStartMonth: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
  coverageEndMonth: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
  source: z.enum(["api", "ui", "hermes", "import", "recurring"]).optional(),
  idempotencyKey: z.string().max(200).nullable().optional(),
  balanceDeltaMinor: z.number().int().optional(),
  principalMinor: z.number().int().nonnegative().optional(),
  interestMinor: z.number().int().nonnegative().optional(),
  feeMinor: z.number().int().nonnegative().optional(),
  splits: z.array(z.object({ categoryId: z.string().uuid().nullable().optional(), component: z.enum(["category", "principal", "interest", "fee"]).optional(), amountMinor: z.number().int().nonnegative() })).optional()
});

const savingsGoalSchema = z.object({
  name: z.string().min(1).max(120),
  targetMinor: z.number().int().positive(),
  openingSavedMinor: z.number().int().nonnegative().optional(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  sortOrder: z.number().int().optional(),
  archived: z.boolean().optional(),
  source: z.enum(["api", "ui", "hermes"]).optional()
});

const savingsEntrySchema = z.object({
  kind: z.enum(["contribution", "withdrawal"]),
  amountMinor: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().max(500).nullable().optional(),
  source: z.enum(["api", "ui", "hermes"]).optional(),
  idempotencyKey: z.string().max(200).nullable().optional()
});

const monthSchema = z.string().regex(/^\d{4}-\d{2}$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sourceSchema = z.enum(["api", "ui", "hermes"]);

const monthlySavingsPlanBaseSchema = z.object({
  name: z.string().min(1).max(120),
  monthlyTargetMinor: z.number().int().positive(),
  startMonth: monthSchema,
  endMonth: monthSchema.nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  archived: z.boolean().optional(),
  source: sourceSchema.optional()
});
const monthlySavingsPlanSchema = monthlySavingsPlanBaseSchema.refine((value) => !value.endMonth || value.endMonth >= value.startMonth, { message: "End month must be on or after start month", path: ["endMonth"] });

const monthlySavingsCheckinSchema = z.object({
  month: monthSchema,
  kind: z.enum(["contribution", "withdrawal"]).default("contribution"),
  amountMinor: z.number().int().positive(),
  note: z.string().max(500).nullable().optional(),
  source: sourceSchema.optional(),
  idempotencyKey: z.string().max(200).nullable().optional()
});

const wealthTypeSchema = z.enum(["mutual_fund", "savings_account", "fixed_deposit", "stock", "bond", "crypto", "real_estate", "other"]);
const wealthAssetSchema = z.object({
  name: z.string().min(1).max(160),
  type: wealthTypeSchema,
  institution: z.string().max(160).nullable().optional(),
  currency: z.string().length(3).optional(),
  openingInvestedMinor: z.number().int().nonnegative().optional(),
  currentValueMinor: z.number().int().nonnegative().optional(),
  investedValueMinor: z.number().int().nonnegative().nullable().optional(),
  asOfDate: dateSchema.optional(),
  note: z.string().max(1000).nullable().optional(),
  archived: z.boolean().optional(),
  source: sourceSchema.optional()
});
const wealthSnapshotSchema = z.object({ currentValueMinor: z.number().int().nonnegative(), investedValueMinor: z.number().int().nonnegative().nullable().optional(), asOfDate: dateSchema, note: z.string().max(500).nullable().optional(), source: sourceSchema.optional(), idempotencyKey: z.string().max(200).nullable().optional() });
const wealthCashFlowSchema = z.object({ kind: z.enum(["contribution", "withdrawal", "income", "fee"]), amountMinor: z.number().int().positive(), date: dateSchema, note: z.string().max(500).nullable().optional(), source: sourceSchema.optional(), idempotencyKey: z.string().max(200).nullable().optional() });
const wealthProposalSchema = z.object({ assetId: z.string().uuid().optional(), name: z.string().min(1).max(160), type: wealthTypeSchema, institution: z.string().max(160).nullable().optional(), currency: z.string().length(3).optional(), currentValueMinor: z.number().int().nonnegative(), investedValueMinor: z.number().int().nonnegative().nullable().optional(), asOfDate: dateSchema, note: z.string().max(500).nullable().optional() });
const wealthDraftSchema = z.object({ sourceFilename: z.string().min(1).max(255), sourceSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).nullable().optional(), capturedAt: z.string().max(40).nullable().optional(), institution: z.string().max(160).nullable().optional(), proposals: z.array(wealthProposalSchema).min(1).max(100), extractionNotes: z.string().max(2000).nullable().optional(), source: sourceSchema.optional() });
const recurringTransactionSchema = z.object({
  type: z.enum(["expense", "income", "transfer", "debt_payment"]),
  amountMinor: z.number().int().positive(),
  currency: z.string().length(3).optional(),
  accountId: z.string().uuid(),
  transferAccountId: z.string().uuid().nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  merchant: z.string().max(200).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  principalMinor: z.number().int().nonnegative().optional(),
  interestMinor: z.number().int().nonnegative().optional(),
  feeMinor: z.number().int().nonnegative().optional()
}).superRefine((value, context) => {
  if ((value.type === "transfer" || value.type === "debt_payment") && !value.transferAccountId) {
    context.addIssue({ code: "custom", path: ["transferAccountId"], message: "A destination account is required" });
  }
  if (value.transferAccountId && value.transferAccountId === value.accountId) {
    context.addIssue({ code: "custom", path: ["transferAccountId"], message: "Choose two different accounts" });
  }
});
const recurringItemSchema = z.object({
  name: z.string().min(1).max(160),
  cadence: z.enum(["weekly", "monthly", "yearly"]),
  intervalCount: z.number().int().min(1).max(120),
  nextDate: dateSchema,
  transaction: recurringTransactionSchema,
  autoCreate: z.boolean().optional(),
  archived: z.boolean().optional(),
  source: sourceSchema.optional()
});

function allowedOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const configured = (process.env.FLOURISH_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  let sameHost = false;
  try { sameHost = Boolean(forwardedHost) && new URL(origin).host === forwardedHost; }
  catch { sameHost = false; }
  return sameHost || configured.includes(origin);
}

function ok(data: unknown, status = 200, requestId = randomUUID()) {
  return NextResponse.json({ data, requestId }, { status, headers: { "Cache-Control": "no-store" } });
}

function problem(status: number, code: string, message: string, requestId: string, fieldErrors?: unknown) {
  return NextResponse.json({ error: { code, message, fieldErrors, requestId } }, { status, headers: { "Cache-Control": "no-store" } });
}

async function json(request: NextRequest) {
  try { return await request.json() as JsonObject; }
  catch { throw new Error("Request body must be valid JSON"); }
}

function query(request: NextRequest, key: string) {
  return request.nextUrl.searchParams.get(key) ?? undefined;
}

function debtInputs(prepaymentOnly = false): RepaymentDebt[] {
  return repaymentLoanInputs(prepaymentOnly);
}

function openApi(request: NextRequest) {
  const route = (summary: string, methods: string[]) => Object.fromEntries(methods.map((method) => [method, { summary, responses: { "200": { description: "Successful response" }, "400": { description: "Validation error" } } }]));
  return {
    openapi: "3.1.0",
    info: { title: "Flourish API", version: "1.1.0", description: "Personal finance API. Money fields use integer minor units." },
    servers: [{ url: `${request.nextUrl.origin}/api/v1` }],
    paths: {
      "/health": route("Service and database health", ["get"]),
      "/settings": route("Application settings", ["get", "patch"]),
      "/dashboard": route("Monthly finance overview", ["get"]),
      "/spending-patterns": route("Monthly spending patterns and comparisons", ["get"]),
      "/forecast": route("Next-month spending, income, loans, cards, and savings forecast", ["get"]),
      "/accounts": route("Accounts", ["get", "post"]),
      "/accounts/{id}": route("Account detail", ["get", "patch"]),
      "/cards": route("Credit cards with statement and transaction calculations", ["get"]),
      "/cards/overview": route("Credit card totals and statement readiness", ["get"]),
      "/cards/{id}": route("Credit card statement and account details", ["get", "patch"]),
      "/categories": route("Categories", ["get", "post"]),
      "/categories/{id}": route("Category detail", ["patch"]),
      "/transactions": route("Transactions", ["get", "post"]),
      "/transactions/{id}": route("Transaction detail", ["get", "patch", "delete"]),
      "/budgets/{month}": route("Monthly budget", ["get", "put"]),
      "/budgets/{month}/copy": route("Copy monthly budget", ["post"]),
      "/savings-goals": route("Savings objectives", ["get", "post"]),
      "/savings/position": route("Savings account balances and monthly movement", ["get"]),
      "/savings-goals/{id}": route("Savings objective detail", ["get", "patch"]),
      "/savings-goals/{id}/entries": route("Savings contributions and withdrawals", ["post"]),
      "/savings-goals/{id}/entries/{entryId}": route("Correct a savings entry", ["delete"]),
      "/monthly-savings-plans": route("Monthly savings targets", ["get", "post"]),
      "/monthly-savings-plans/{id}": route("Monthly savings plan detail", ["get", "patch"]),
      "/wealth": route("Wealth overview", ["get"]),
      "/wealth/assets": route("Investment and savings holdings", ["get", "post"]),
      "/wealth/assets/{id}": route("Wealth holding detail", ["get", "patch"]),
      "/wealth/assets/{id}/snapshots": route("Periodic holding valuations", ["post"]),
      "/wealth/assets/{id}/cash-flows": route("Investment contributions and withdrawals", ["post"]),
      "/wealth/import-drafts": route("Reviewable screenshot extraction drafts", ["get", "post"]),
      "/wealth/import-drafts/{id}": route("Screenshot extraction draft", ["get", "delete"]),
      "/wealth/import-drafts/{id}/apply": route("Apply a confirmed screenshot draft", ["post"]),
      "/loans": route("Standalone and card-linked loans", ["get", "post"]),
      "/loans/overview": route("Loan balances, EMIs, linked cards, and completion dates", ["get"]),
      "/loans/{id}": route("Loan terms", ["get", "patch"]),
      "/loans/{id}/installments": route("Record a paid loan installment", ["post"]),
      "/debt-payments": route("Record a debt payment", ["post"]),
      "/repayment-plans/simulate": route("Simulate repayment", ["post"]),
      "/repayment-plans/compare": route("Compare current, lowest-interest, and smallest-balance repayment paths", ["post"]),
      "/repayment-plans/active": route("Legacy saved repayment scenario", ["get"]),
      "/recurring-items": route("Recurring items", ["get", "post"]),
      "/recurring-items/{id}": route("Recurring item", ["get", "patch", "delete"]),
      "/recurring-items/{id}/record": route("Record recurring item", ["post"]),
      "/upcoming": route("Upcoming items", ["get"]),
      "/imports/preview": route("Preview statement attachment", ["post"]),
      "/imports/{id}": route("Import preview", ["get", "patch"]),
      "/imports/{id}/apply": route("Apply statement import", ["post"]),
      "/import-profiles": route("Statement mappings", ["get", "post"]),
      "/exports/data.json": route("Portable JSON export", ["get"]),
      "/exports/transactions.csv": route("Transaction CSV export", ["get"])
    }
  };
}

async function handle(request: NextRequest, context: Context) {
  const requestId = randomUUID();
  if (!allowedOrigin(request)) return problem(403, "ORIGIN_NOT_ALLOWED", "This browser origin is not allowed", requestId);
  const { path: segments = [] } = await context.params;
  const path = segments.join("/");
  const method = request.method;

  try {
    if (path === "health" && method === "GET") {
      getDb().prepare("SELECT 1").get();
      return ok({ status: "ok", database: "ready", version: process.env.npm_package_version ?? "0.1.0", time: new Date().toISOString() }, 200, requestId);
    }
    if (path === "openapi.json" && method === "GET") return NextResponse.json(openApi(request), { headers: { "Cache-Control": "no-store" } });
    if (path === "settings" && method === "GET") return ok(getSettings(), 200, requestId);
    if (path === "settings" && method === "PATCH") return ok(updateSettings(z.record(z.string()).parse(await json(request))), 200, requestId);
    if (path === "dashboard" && method === "GET") return ok(getDashboard(query(request, "month")), 200, requestId);

    if (path === "accounts" && method === "GET") return ok(listAccounts(query(request, "includeArchived") === "true"), 200, requestId);
    if (path === "accounts" && method === "POST") return ok(createAccount({ ...accountSchema.parse(await json(request)), idempotencyKey: request.headers.get("idempotency-key") }), 201, requestId);
    if (segments[0] === "accounts" && segments.length === 2 && method === "GET") {
      const account = getAccount(segments[1]);
      return account ? ok(account, 200, requestId) : problem(404, "NOT_FOUND", "Account not found", requestId);
    }
    if (segments[0] === "accounts" && segments.length === 2 && method === "PATCH") {
      const account = updateAccount(segments[1], accountSchema.partial().parse(await json(request)));
      return account ? ok(account, 200, requestId) : problem(404, "NOT_FOUND", "Account not found", requestId);
    }

    if (path === "cards" && method === "GET") return ok(listCards(), 200, requestId);
    if (path === "cards/overview" && method === "GET") return ok(getCardsOverview(), 200, requestId);
    if (segments[0] === "cards" && segments.length === 2 && method === "GET") {
      const card = getCard(segments[1]);
      return card ? ok(card, 200, requestId) : problem(404, "NOT_FOUND", "Card not found", requestId);
    }
    if (segments[0] === "cards" && segments.length === 2 && method === "PATCH") {
      const current = getCard(segments[1]);
      if (!current) return problem(404, "NOT_FOUND", "Card not found", requestId);
      updateAccount(segments[1], accountSchema.partial().parse(await json(request)));
      return ok(getCard(segments[1]), 200, requestId);
    }

    if (path === "categories" && method === "GET") return ok(listCategories(query(request, "includeArchived") === "true"), 200, requestId);
    if (path === "categories" && method === "POST") return ok(createCategory(z.object({ name: z.string().min(1), kind: z.enum(["expense", "income"]).optional(), color: z.string().optional(), icon: z.string().optional(), sortOrder: z.number().int().optional(), source: z.string().optional() }).parse(await json(request))), 201, requestId);
    if (segments[0] === "categories" && segments.length === 2 && method === "PATCH") {
      const category = updateCategory(segments[1], await json(request));
      return category ? ok(category, 200, requestId) : problem(404, "NOT_FOUND", "Category not found", requestId);
    }

    if (path === "transactions" && method === "GET") return ok(listTransactions({ start: query(request, "start"), end: query(request, "end"), accountId: query(request, "accountId"), categoryId: query(request, "categoryId"), type: query(request, "type"), search: query(request, "search"), limit: Number(query(request, "limit") ?? 100) }), 200, requestId);
    if (path === "transactions" && method === "POST") {
      const body = transactionSchema.parse(await json(request));
      return ok(createTransaction({ ...body, idempotencyKey: body.idempotencyKey ?? request.headers.get("idempotency-key") }), 201, requestId);
    }
    if (segments[0] === "transactions" && segments.length === 2 && method === "GET") {
      const transaction = getTransaction(segments[1]);
      return transaction ? ok(transaction, 200, requestId) : problem(404, "NOT_FOUND", "Transaction not found", requestId);
    }
    if (segments[0] === "transactions" && segments.length === 2 && method === "PATCH") {
      const transaction = updateTransaction(segments[1], transactionSchema.partial().parse(await json(request)));
      return transaction ? ok(transaction, 200, requestId) : problem(404, "NOT_FOUND", "Transaction not found", requestId);
    }
    if (segments[0] === "transactions" && segments.length === 2 && method === "DELETE") return deleteTransaction(segments[1], query(request, "source") ?? "api") ? ok({ deleted: true }, 200, requestId) : problem(404, "NOT_FOUND", "Transaction not found", requestId);

    if (segments[0] === "budgets" && segments.length === 2 && method === "GET") return ok(getBudget(segments[1]), 200, requestId);
    if (segments[0] === "budgets" && segments.length === 2 && method === "PUT") {
      const body = z.object({ lines: z.array(z.object({ categoryId: z.string().uuid(), limitMinor: z.number().int().nonnegative(), rollover: z.boolean().optional() })) }).parse(await json(request));
      return ok(putBudget(segments[1], body.lines), 200, requestId);
    }
    if (segments[0] === "budgets" && segments[2] === "copy" && method === "POST") {
      const body = z.object({ sourceMonth: z.string().regex(/^\d{4}-\d{2}$/) }).parse(await json(request));
      return ok(copyBudget(segments[1], body.sourceMonth), 200, requestId);
    }

    if (path === "spending-patterns" && method === "GET") {
      const month = query(request, "month") ?? zonedMonthValue(String(getSettings().timeZone ?? "Asia/Dubai"));
      return ok(getSpendingPatterns(month, Number(query(request, "months") ?? 6)), 200, requestId);
    }
    if (path === "forecast" && method === "GET") {
      const month = query(request, "month") ?? zonedMonthValue(String(getSettings().timeZone ?? "Asia/Dubai"));
      return ok(getFinancialForecast(month), 200, requestId);
    }

    if (path === "savings-goals" && method === "GET") return ok(listSavingsGoals(query(request, "includeArchived") === "true"), 200, requestId);
    if (path === "savings/position" && method === "GET") return ok(getSavingsPosition(query(request, "month")), 200, requestId);
    if (path === "savings-goals" && method === "POST") {
      const body = savingsGoalSchema.parse(await json(request));
      return ok(createSavingsGoal({ ...body, idempotencyKey: request.headers.get("idempotency-key") }), 201, requestId);
    }
    if (segments[0] === "savings-goals" && segments.length === 2 && method === "GET") {
      const goal = getSavingsGoal(segments[1]);
      return goal ? ok(goal, 200, requestId) : problem(404, "NOT_FOUND", "Savings objective not found", requestId);
    }
    if (segments[0] === "savings-goals" && segments.length === 2 && method === "PATCH") {
      const goal = updateSavingsGoal(segments[1], savingsGoalSchema.partial().parse(await json(request)));
      return goal ? ok(goal, 200, requestId) : problem(404, "NOT_FOUND", "Savings objective not found", requestId);
    }
    if (segments[0] === "savings-goals" && segments[2] === "entries" && segments.length === 3 && method === "POST") {
      savingsEntrySchema.parse(await json(request));
      return problem(409, "LEDGER_REQUIRED", "Record money moving into or out of a savings account instead", requestId);
    }
    if (segments[0] === "savings-goals" && segments[2] === "entries" && segments.length === 4 && method === "DELETE") {
      const goal = deleteSavingsEntry(segments[1], segments[3], query(request, "source") ?? "api");
      return goal ? ok(goal, 200, requestId) : problem(404, "NOT_FOUND", "Savings entry not found", requestId);
    }

    if (path === "monthly-savings-plans" && method === "GET") return ok(listMonthlySavingsPlans(query(request, "month"), query(request, "includeArchived") === "true"), 200, requestId);
    if (path === "monthly-savings-plans" && method === "POST") {
      const body = monthlySavingsPlanSchema.parse(await json(request));
      return ok(createMonthlySavingsPlan({ ...body, idempotencyKey: request.headers.get("idempotency-key") }), 201, requestId);
    }
    if (segments[0] === "monthly-savings-plans" && segments.length === 2 && method === "GET") {
      const plan = getMonthlySavingsPlan(segments[1], query(request, "month"));
      return plan ? ok(plan, 200, requestId) : problem(404, "NOT_FOUND", "Monthly savings plan not found", requestId);
    }
    if (segments[0] === "monthly-savings-plans" && segments.length === 2 && method === "PATCH") {
      const plan = updateMonthlySavingsPlan(segments[1], monthlySavingsPlanBaseSchema.partial().parse(await json(request)));
      return plan ? ok(plan, 200, requestId) : problem(404, "NOT_FOUND", "Monthly savings plan not found", requestId);
    }
    if (segments[0] === "monthly-savings-plans" && segments[2] === "check-ins" && segments.length === 3 && method === "POST") {
      monthlySavingsCheckinSchema.parse(await json(request));
      return problem(409, "LEDGER_REQUIRED", "Record money moving into or out of a savings account instead", requestId);
    }
    if (segments[0] === "monthly-savings-plans" && segments[2] === "check-ins" && segments.length === 4 && method === "DELETE") {
      const plan = deleteMonthlySavingsCheckin(segments[1], segments[3], query(request, "source") ?? "api");
      return plan ? ok(plan, 200, requestId) : problem(404, "NOT_FOUND", "Monthly savings check-in not found", requestId);
    }

    if (path === "wealth" && method === "GET") return ok(getWealthOverview(), 200, requestId);
    if (path === "wealth/assets" && method === "GET") return ok(listWealthAssets(query(request, "includeArchived") === "true"), 200, requestId);
    if (path === "wealth/assets" && method === "POST") {
      const body = wealthAssetSchema.parse(await json(request));
      return ok(createWealthAsset({ ...body, idempotencyKey: request.headers.get("idempotency-key"), snapshotIdempotencyKey: request.headers.get("idempotency-key") ? `${request.headers.get("idempotency-key")}:snapshot` : null }), 201, requestId);
    }
    if (segments[0] === "wealth" && segments[1] === "assets" && segments.length === 3 && method === "GET") {
      const asset = getWealthAsset(segments[2]);
      return asset ? ok(asset, 200, requestId) : problem(404, "NOT_FOUND", "Wealth asset not found", requestId);
    }
    if (segments[0] === "wealth" && segments[1] === "assets" && segments.length === 3 && method === "PATCH") {
      const asset = updateWealthAsset(segments[2], wealthAssetSchema.partial().parse(await json(request)));
      return asset ? ok(asset, 200, requestId) : problem(404, "NOT_FOUND", "Wealth asset not found", requestId);
    }
    if (segments[0] === "wealth" && segments[1] === "assets" && segments[3] === "snapshots" && segments.length === 4 && method === "POST") {
      const body = wealthSnapshotSchema.parse(await json(request));
      return ok(addWealthSnapshot(segments[2], { ...body, idempotencyKey: body.idempotencyKey ?? request.headers.get("idempotency-key") }), 201, requestId);
    }
    if (segments[0] === "wealth" && segments[1] === "assets" && segments[3] === "cash-flows" && segments.length === 4 && method === "POST") {
      const body = wealthCashFlowSchema.parse(await json(request));
      return ok(addWealthCashFlow(segments[2], { ...body, idempotencyKey: body.idempotencyKey ?? request.headers.get("idempotency-key") }), 201, requestId);
    }
    if (segments[0] === "wealth" && segments[1] === "assets" && (segments[3] === "snapshots" || segments[3] === "cash-flows") && segments.length === 5 && method === "DELETE") {
      const asset = deleteWealthRecord(segments[2], segments[3] as "snapshots" | "cash-flows", segments[4], query(request, "source") ?? "api");
      return asset ? ok(asset, 200, requestId) : problem(404, "NOT_FOUND", "Wealth record not found", requestId);
    }
    if (path === "wealth/import-drafts" && method === "GET") return ok(listWealthImportDrafts(query(request, "status")), 200, requestId);
    if (path === "wealth/import-drafts" && method === "POST") {
      const body = wealthDraftSchema.parse(await json(request));
      return ok(createWealthImportDraft({ ...body, idempotencyKey: request.headers.get("idempotency-key") }), 201, requestId);
    }
    if (segments[0] === "wealth" && segments[1] === "import-drafts" && segments.length === 3 && method === "GET") {
      const draft = getWealthImportDraft(segments[2]);
      return draft ? ok(draft, 200, requestId) : problem(404, "NOT_FOUND", "Wealth import draft not found", requestId);
    }
    if (segments[0] === "wealth" && segments[1] === "import-drafts" && segments.length === 3 && method === "DELETE") {
      const draft = cancelWealthImportDraft(segments[2], query(request, "source") ?? "api");
      return draft ? ok(draft, 200, requestId) : problem(409, "DRAFT_NOT_EDITABLE", "Wealth import draft is missing or no longer editable", requestId);
    }
    if (segments[0] === "wealth" && segments[1] === "import-drafts" && segments[3] === "apply" && segments.length === 4 && method === "POST") {
      const applyBody = await json(request).catch(() => ({} as JsonObject));
      const draft = applyWealthImportDraft(segments[2], String(applyBody.source ?? "api"));
      return draft ? ok(draft, 200, requestId) : problem(404, "NOT_FOUND", "Wealth import draft not found", requestId);
    }

    if (path === "reports/spending" && method === "GET") {
      const month = query(request, "month") ?? zonedMonthValue(String(getSettings().timeZone ?? "Asia/Dubai"));
      return ok(getDashboard(month).spendingByCategory, 200, requestId);
    }
    if (path === "reports/cash-flow" && method === "GET") {
      const transactions = listTransactions({ start: query(request, "start"), end: query(request, "end"), limit: 500 }) as Array<Record<string, unknown>>;
      const totals = transactions.reduce<{ incomeMinor: number; spentMinor: number }>((value, transaction) => {
        if (transaction.type === "income") value.incomeMinor += Number(transaction.amountMinor);
        if (transaction.type === "expense") value.spentMinor += Number(transaction.amountMinor);
        return value;
      }, { incomeMinor: 0, spentMinor: 0 });
      return ok({ ...totals, netMinor: totals.incomeMinor - totals.spentMinor, transactions }, 200, requestId);
    }

    if (path === "loans" && method === "GET") return ok(listLoans(query(request, "month"), query(request, "includeArchived") === "true"), 200, requestId);
    if (path === "loans" && method === "POST") {
      const body = loanSchema.parse(await json(request));
      return ok(createLoan({ ...body, idempotencyKey: request.headers.get("idempotency-key") }), 201, requestId);
    }
    if (path === "loans/overview" && method === "GET") return ok(getLoansOverview(query(request, "month")), 200, requestId);
    if (segments[0] === "loans" && segments.length === 2 && method === "GET") {
      const loan = getLoan(segments[1], query(request, "month"));
      return loan ? ok(loan, 200, requestId) : problem(404, "NOT_FOUND", "Loan not found", requestId);
    }
    if (segments[0] === "loans" && segments.length === 2 && method === "PATCH") {
      const loan = updateLoan(segments[1], loanBaseSchema.partial().parse(await json(request)));
      return loan ? ok(loan, 200, requestId) : problem(404, "NOT_FOUND", "Loan not found", requestId);
    }
    if (segments[0] === "loans" && segments[2] === "installments" && segments.length === 3 && method === "POST") {
      const body = loanInstallmentSchema.parse(await json(request));
      const loan = recordLoanInstallment(segments[1], { ...body, idempotencyKey: body.idempotencyKey ?? request.headers.get("idempotency-key") });
      return loan ? ok(loan, 201, requestId) : problem(404, "NOT_FOUND", "Loan not found", requestId);
    }
    // Compatibility aliases for older Hermes installations and saved links.
    if (path === "debts" && method === "GET") return ok(listLoans(query(request, "month")), 200, requestId);
    if (path === "debts/overview" && method === "GET") return ok(getLoansOverview(query(request, "month")), 200, requestId);
    if (segments[0] === "debts" && segments.length === 2 && method === "GET") {
      const loan = getLoan(segments[1], query(request, "month"));
      return loan ? ok(loan, 200, requestId) : problem(404, "NOT_FOUND", "Loan not found", requestId);
    }
    if (path === "debt-payments" && method === "POST") {
      const body = transactionSchema.omit({ type: true }).parse(await json(request));
      return ok(createTransaction({ ...body, type: "debt_payment", idempotencyKey: body.idempotencyKey ?? request.headers.get("idempotency-key") }), 201, requestId);
    }
    if (path === "repayment-plans/simulate" && method === "POST") {
      const body = z.object({ strategy: z.enum(["avalanche", "snowball", "fixed"]), monthlyAmountMinor: z.number().int().positive(), startMonth: z.string().optional(), debts: z.array(z.object({ id: z.string(), name: z.string(), balanceMinor: z.number().int().nonnegative(), aprBps: z.number().int().nonnegative(), minimumPaymentMinor: z.number().int().nonnegative() })).optional(), fixedAllocations: z.record(z.number()).optional() }).parse(await json(request));
      const simulationInput = { ...body, debts: body.debts ?? debtInputs(true) };
      return ok({ input: simulationInput, result: simulateRepayment(simulationInput) }, 200, requestId);
    }
    if (path === "repayment-plans/compare" && method === "POST") {
      const body = z.object({
        currentMonthlyAmountMinor: z.number().int().nonnegative(),
        extraPaymentMinor: z.number().int().nonnegative(),
        startMonth: z.string().regex(/^\d{4}-\d{2}$/).optional(),
        debts: z.array(z.object({ id: z.string(), name: z.string(), balanceMinor: z.number().int().nonnegative(), aprBps: z.number().int().nonnegative(), minimumPaymentMinor: z.number().int().nonnegative() })).optional()
      }).parse(await json(request));
      const debts = body.debts ?? debtInputs(true);
      const liveLoans = listLoans();
      const excludedDebts = body.debts ? [] : liveLoans.filter((loan) => Number(loan.balanceMinor) > 0 && !loan.prepaymentAllowed).map((loan) => ({ id: String(loan.id), name: String(loan.name), reason: "prepayment_not_allowed" }));
      const missingAprDebts = body.debts ? [] : liveLoans
        .filter((loan) => Number(loan.balanceMinor) > 0 && loan.prepaymentAllowed && loan.aprBps == null)
        .map((loan) => ({ id: String(loan.id), name: String(loan.name) }));
      return ok({
        ...compareRepaymentPlans({ ...body, debts }),
        interestDataComplete: missingAprDebts.length === 0,
        missingAprDebts,
        excludedDebts
      }, 200, requestId);
    }
    if (path === "repayment-plans/active" && method === "GET") return ok(getActiveRepaymentPlan(), 200, requestId);
    if (path === "repayment-plans/active" && method === "PUT") {
      await json(request);
      return problem(409, "SCENARIO_ONLY", "Repayment comparisons are scenarios and cannot change actual debt data", requestId);
    }

    if (path === "recurring-items" && method === "GET") return ok(listRecurring(), 200, requestId);
    if (path === "recurring-items" && method === "POST") {
      const body = recurringItemSchema.parse(await json(request));
      return ok(createRecurring({ ...body, idempotencyKey: request.headers.get("idempotency-key") }), 201, requestId);
    }
    if (path === "upcoming" && method === "GET") return ok({ recurring: listRecurring(), loans: listLoans().filter((loan) => loan.nextDueDate), cards: listCards().filter((card) => card.paymentDueDate) }, 200, requestId);
    if (segments[0] === "recurring-items" && segments.length === 2 && method === "GET") {
      const item = getRecurring(segments[1]);
      return item ? ok(item, 200, requestId) : problem(404, "NOT_FOUND", "Recurring item not found", requestId);
    }
    if (segments[0] === "recurring-items" && segments.length === 2 && method === "PATCH") {
      const item = updateRecurring(segments[1], recurringItemSchema.partial().parse(await json(request)));
      return item ? ok(item, 200, requestId) : problem(404, "NOT_FOUND", "Recurring item not found", requestId);
    }
    if (segments[0] === "recurring-items" && segments.length === 2 && method === "DELETE") {
      const item = updateRecurring(segments[1], { archived: true });
      return item ? ok({ archived: true }, 200, requestId) : problem(404, "NOT_FOUND", "Recurring item not found", requestId);
    }
    if (segments[0] === "recurring-items" && segments[2] === "record" && method === "POST") {
      const result = recordRecurring(segments[1]);
      return result ? ok(result, 201, requestId) : problem(404, "NOT_FOUND", "Recurring item not found", requestId);
    }

    if (path === "imports/preview" && method === "POST") {
      const form = await request.formData();
      const file = form.get("file");
      const accountId = String(form.get("accountId") ?? "");
      if (!(file instanceof File)) return problem(400, "FILE_REQUIRED", "A statement attachment is required", requestId);
      const maxBytes = Number(process.env.FLOURISH_MAX_UPLOAD_MB ?? 20) * 1024 * 1024;
      if (file.size > maxBytes) return problem(413, "FILE_TOO_LARGE", `Statement exceeds ${process.env.FLOURISH_MAX_UPLOAD_MB ?? 20} MB`, requestId);
      const mappingText = String(form.get("mapping") ?? "");
      const data = await previewImport({ accountId, filename: file.name, buffer: Buffer.from(await file.arrayBuffer()), profileId: String(form.get("profileId") ?? "") || undefined, mapping: mappingText ? JSON.parse(mappingText) : undefined });
      return ok(data, 201, requestId);
    }
    if (segments[0] === "imports" && segments.length === 2 && method === "GET") {
      const value = getImport(segments[1]);
      return value ? ok(value, 200, requestId) : problem(404, "NOT_FOUND", "Import batch not found", requestId);
    }
    if (segments[0] === "imports" && segments.length === 2 && method === "PATCH") {
      const value = updateImport(segments[1], await json(request));
      return value ? ok(value, 200, requestId) : problem(409, "IMPORT_NOT_EDITABLE", "Import batch is missing or no longer editable", requestId);
    }
    if (segments[0] === "imports" && segments[2] === "apply" && method === "POST") {
      const key = request.headers.get("idempotency-key") ?? randomUUID();
      const value = applyImport(segments[1], key);
      return value ? ok(value, 200, requestId) : problem(404, "NOT_FOUND", "Import batch not found", requestId);
    }
    if (path === "import-profiles" && method === "GET") return ok(listImportProfiles(), 200, requestId);
    if (path === "import-profiles" && method === "POST") return ok(createImportProfile(await json(request) as never), 201, requestId);
    if (segments[0] === "import-profiles" && segments.length === 2 && method === "PATCH") {
      const value = updateImportProfile(segments[1], await json(request));
      return value ? ok(value, 200, requestId) : problem(404, "NOT_FOUND", "Import profile not found", requestId);
    }
    if (segments[0] === "import-profiles" && segments.length === 2 && method === "DELETE") return deleteImportProfile(segments[1]) ? ok({ deleted: true }, 200, requestId) : problem(404, "NOT_FOUND", "Import profile not found", requestId);

    if (path === "exports/data.json" && method === "GET") {
      const data = { exportedAt: new Date().toISOString(), version: 3, settings: getSettings(), accounts: listAccounts(true), loans: listLoans(undefined, true), loanInstallments: getDb().prepare("SELECT * FROM loan_installments ORDER BY paid_date, created_at").all(), categories: listCategories(true), transactions: listTransactions({ limit: 500 }), savingsGoals: listSavingsGoals(true), monthlySavingsPlans: listMonthlySavingsPlans(undefined, true), wealthAssets: listWealthAssets(true), wealthImportDrafts: listWealthImportDrafts(), recurringItems: listRecurring(), activeRepaymentPlan: getActiveRepaymentPlan() };
      return new NextResponse(JSON.stringify(data, null, 2), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="flourish-${new Date().toISOString().slice(0, 10)}.json"` } });
    }
    if (path === "exports/transactions.csv" && method === "GET") {
      const values = listTransactions({ start: query(request, "start"), end: query(request, "end"), limit: 500 }) as Array<Record<string, unknown>>;
      const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
      const rows = ["date,type,amountMinor,currency,merchant,category,account,transferAccount,note", ...values.map((value) => [value.date, value.type, value.amountMinor, value.currency, value.merchant, value.categoryName, value.accountName, value.transferAccountName, value.note].map(escape).join(","))];
      return new NextResponse(rows.join("\n"), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="flourish-transactions-${new Date().toISOString().slice(0, 10)}.csv"` } });
    }
    if (path === "audit-events" && method === "GET") return ok(getAuditEvents(Number(query(request, "limit") ?? 100)), 200, requestId);

    return problem(404, "NOT_FOUND", "Endpoint not found", requestId);
  } catch (error) {
    if (error instanceof ZodError) return problem(400, "VALIDATION_ERROR", "Request validation failed", requestId, error.flatten().fieldErrors);
    const message = error instanceof Error ? error.message : "Unexpected error";
    const conflict = /UNIQUE constraint|already exists/i.test(message);
    console.error(JSON.stringify({ level: "error", requestId, path, method, message }));
    return problem(conflict ? 409 : 400, conflict ? "CONFLICT" : "BAD_REQUEST", message, requestId);
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
