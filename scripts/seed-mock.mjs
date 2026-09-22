const baseUrl = process.env.FLOURISH_BASE_URL ?? "http://127.0.0.1:3210/api/v1";

async function api(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers }
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? `${init.method ?? "GET"} ${path} failed`);
  return payload.data;
}

async function ensureAccount(input, key) {
  const accounts = await api("/accounts");
  const existing = accounts.find((account) => account.name === input.name);
  if (existing) return existing;
  return api("/accounts", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ ...input, source: "api" }) });
}

const bank = await ensureAccount({ name: "Mock Salary Bank", type: "bank", openingBalanceMinor: 8_000_000 }, "mock-account-bank");
const savings = await ensureAccount({ name: "Mock Savings", type: "bank", purpose: "savings", openingBalanceMinor: 1_500_000 }, "mock-account-savings");
const card = await ensureAccount({ name: "Mock Credit Card", type: "credit_card", institution: "Mock Bank", openingBalanceMinor: 4_084_000, creditLimitMinor: 5_200_000, lastStatementDate: "2026-07-18", lastStatementBalanceMinor: 3_700_000, statementDay: 18, dueDay: 12, nextDueDate: "2026-08-12" }, "mock-account-card");
await api(`/cards/${card.id}`, { method: "PATCH", body: JSON.stringify({ creditLimitMinor: 5_200_000, lastStatementDate: "2026-07-18", lastStatementBalanceMinor: 3_700_000, statementDay: 18, dueDay: 12, nextDueDate: "2026-08-12", source: "api" }) });
await ensureAccount({ name: "Mock Personal Loan", type: "personal_loan", institution: "Mock Bank", prepaymentAllowed: false, openingBalanceMinor: 11_761_266, originalPrincipalMinor: 31_847_954, aprBps: 800, installmentMinor: 684_900, remainingTermMonths: 18, nextDueDate: "2026-08-26" }, "mock-account-loan");
const loans = await api("/loans");
if (!loans.some((loan) => loan.name === "Mock Balance Transfer")) {
  await api("/loans", { method: "POST", headers: { "Idempotency-Key": "mock-card-linked-loan" }, body: JSON.stringify({ name: "Mock Balance Transfer", kind: "balance_transfer", institution: "Mock Bank", currency: "AED", linkedCardId: card.id, includedInCardBalance: true, originalPrincipalMinor: 4_080_000, currentBalanceMinor: 4_080_000, emiMinor: 680_000, totalInstallments: 6, remainingInstallments: 6, aprBps: 0, nextDueDate: "2026-08-12", source: "api" }) });
}

const categories = await api("/categories");
const categoryId = (name) => categories.find((category) => category.name === name)?.id;
const transactions = [
  ["2026-05-22", "income", 4_000_000, "Salary", null],
  ["2026-05-03", "expense", 100_000, "OPENAI CHATGPT PLUS", null],
  ["2026-05-08", "expense", 160_000, "NESTO HYPERMARKET", null],
  ["2026-05-15", "expense", 120_000, "KEETA", null],
  ["2026-06-22", "income", 4_000_000, "Salary", null],
  ["2026-06-04", "expense", 150_000, "GOOGLE *CLOUD EMEA", null],
  ["2026-06-09", "expense", 175_000, "CARREFOUR", null],
  ["2026-06-16", "expense", 145_000, "RESTAURANT", null],
  ["2026-07-22", "income", 4_000_000, "Salary", null],
  ["2026-07-02", "expense", 120_000, "OPENAI", "Work"],
  ["2026-07-06", "expense", 180_000, "GOOGLE CLOUD", "Work"],
  ["2026-07-10", "expense", 190_000, "NESTO HYPERMARKET", "Groceries"],
  ["2026-07-15", "expense", 155_000, "KEETA", "Dining"],
  ["2026-07-20", "expense", 90_000, "ADNOC", "Transport"]
];

for (const [date, type, amountMinor, merchant, category] of transactions) {
  await api("/transactions", {
    method: "POST",
    headers: { "Idempotency-Key": `mock-${date}-${merchant.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` },
    body: JSON.stringify({ type, date, amountMinor, accountId: type === "expense" ? card.id : bank.id, categoryId: category ? categoryId(category) : undefined, merchant, source: "api" })
  });
}

await api("/transactions", { method: "POST", headers: { "Idempotency-Key": "mock-prepaid-rent" }, body: JSON.stringify({ type: "expense", date: "2026-07-01", amountMinor: 2_400_000, accountId: bank.id, categoryId: categoryId("Home"), merchant: "Rent", coverageStartMonth: "2026-07", coverageEndMonth: "2026-09", source: "api" }) });
await api("/transactions", { method: "POST", headers: { "Idempotency-Key": "mock-savings-transfer" }, body: JSON.stringify({ type: "transfer", date: "2026-07-23", amountMinor: 1_000_000, accountId: bank.id, transferAccountId: savings.id, note: "Monthly savings", source: "api" }) });

await api("/monthly-savings-plans", {
  method: "POST",
  headers: { "Idempotency-Key": "mock-monthly-savings" },
  body: JSON.stringify({ name: "Monthly savings", monthlyTargetMinor: 1_000_000, startMonth: "2026-05", source: "api" })
});

const recurring = await api("/recurring-items");
if (!recurring.some((item) => item.name === "Mock salary")) {
  await api("/recurring-items", { method: "POST", headers: { "Idempotency-Key": "mock-recurring-salary" }, body: JSON.stringify({ name: "Mock salary", cadence: "monthly", intervalCount: 1, nextDate: "2026-08-22", transaction: { type: "income", amountMinor: 4_000_000, accountId: bank.id, merchant: "Salary" }, source: "api" }) });
}
if (!recurring.some((item) => item.name === "Mock rent")) {
  await api("/recurring-items", { method: "POST", headers: { "Idempotency-Key": "mock-recurring-rent" }, body: JSON.stringify({ name: "Mock rent", cadence: "monthly", intervalCount: 3, nextDate: "2026-10-01", transaction: { type: "expense", amountMinor: 2_400_000, accountId: bank.id, categoryId: categoryId("Home"), merchant: "Rent" }, source: "api" }) });
}

const forecast = await api("/forecast?month=2026-07");
const loanOverview = await api("/loans/overview?month=2026-07");
console.log(JSON.stringify({ forecast, allLoansFinishMonth: loanOverview.allLoansFinishMonth, remainingEmis: loanOverview.remainingEmis }, null, 2));
