#!/usr/bin/env node

const baseUrl = process.env.FLOURISH_BASE_URL ?? "http://127.0.0.1:3210";
const month = process.env.FLOURISH_VERIFY_MONTH ?? new Date().toISOString().slice(0, 7);

async function get(path) {
  const response = await fetch(`${baseUrl}/api/v1${path}`);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return (await response.json()).data;
}

const [dashboard, accounts, monthlySavings, wealth, cards, loans] = await Promise.all([
  get(`/dashboard?month=${month}`),
  get("/accounts"),
  get(`/monthly-savings-plans?month=${month}`),
  get("/wealth"),
  get("/cards/overview"),
  get(`/loans/overview?month=${month}`)
]);

console.log(JSON.stringify({
  month,
  spentMinor: dashboard.spentMinor,
  incomeMinor: dashboard.incomeMinor,
  accountCount: accounts.length,
  savingsBalanceMinor: dashboard.savings.totalBalanceMinor,
  savingsMovementMinor: dashboard.savings.movementMinor,
  monthlyTargetMinor: monthlySavings.reduce((sum, plan) => sum + Number(plan.monthlyTargetMinor), 0),
  monthlyActualMinor: dashboard.savings.movementMinor,
  wealthAssetCount: wealth.assetCount,
  wealthTotalsByCurrency: wealth.totalsByCurrency,
  cardOutstandingMinor: cards.currentOutstandingMinor,
  cardStatementDueMinor: cards.statementDueMinor,
  missingCardStatements: cards.missingStatementCards,
  totalLoanMinor: loans.totalBalanceMinor,
  loansIncludedInCardsMinor: loans.includedInCardsMinor,
  additionalLoanBalanceMinor: loans.additionalLoanBalanceMinor,
  remainingEmis: loans.remainingEmis,
  allLoansFinishMonth: loans.allLoansFinishMonth
}, null, 2));
