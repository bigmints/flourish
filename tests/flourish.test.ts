import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";
import { closeDbForTests } from "@/lib/db";
import { addSavingsEntry, createAccount, createCategory, createRecurring, createSavingsGoal, createTransaction, deleteSavingsEntry, getAccount, getBudget, getDashboard, getFinancialForecast, getRecurring, getSavingsGoal, getSavingsPosition, getSpendingPatterns, listAccounts, listCategories, listSavingsGoals, listTransactions, putBudget, recordRecurring, saveRepaymentPlan, updateAccount, updateCategory, updateRecurring, updateSavingsGoal, updateTransaction } from "@/lib/store";
import { applyImport, previewImport } from "@/lib/imports";
import { compareRepaymentPlans, simulateRepayment } from "@/lib/repayment";
import { inferExpenseCategoryName } from "@/lib/categorization";
import { getDebtOverview } from "@/lib/debts";
import { getCard, getCardsOverview } from "@/lib/cards";
import { createLoan, getLoan, getLoansOverview, recordLoanInstallment } from "@/lib/loans";
import { zonedDateValue, zonedMonthValue } from "@/lib/time";
import { formatMoney } from "@/lib/money";
import { addWealthCashFlow, addWealthSnapshot, applyWealthImportDraft, createMonthlySavingsPlan, createWealthAsset, createWealthImportDraft, getMonthlySavingsPlan, getWealthAsset, getWealthImportDraft, getWealthOverview, updateMonthlySavingsPlan, updateWealthAsset } from "@/lib/planning";

const testData = mkdtempSync(join(tmpdir(), "flourish-test-"));

beforeAll(() => { process.env.FLOURISH_DATA_DIR = testData; });
afterAll(() => { closeDbForTests(); rmSync(testData, { recursive: true, force: true }); });

describe("repayment engine", () => {
  it("formats money with exactly two decimal places", () => {
    expect(formatMoney(123_400, "AED", "en-AE")).toMatch(/1,234\.00$/);
    expect(formatMoney(123_456, "AED", "en-AE")).toMatch(/1,234\.56$/);
  });

  it("uses the configured time zone at the UTC day boundary", () => {
    const instant = new Date("2026-07-26T22:30:00.000Z");
    expect(zonedDateValue("Asia/Dubai", instant)).toBe("2026-07-27");
    expect(zonedMonthValue("Asia/Dubai", instant)).toBe("2026-07");
  });
  it("pays higher APR debt first with avalanche and never creates negative balances", () => {
    const result = simulateRepayment({
      strategy: "avalanche",
      monthlyAmountMinor: 30_000,
      startMonth: "2026-08",
      debts: [
        { id: "high", name: "High APR", balanceMinor: 80_000, aprBps: 3600, minimumPaymentMinor: 5_000 },
        { id: "low", name: "Low APR", balanceMinor: 100_000, aprBps: 800, minimumPaymentMinor: 5_000 }
      ]
    });
    expect(result.status).toBe("ok");
    expect(result.payoffMonth).toBeTruthy();
    expect(result.months[0].payments.find((payment) => payment.debtId === "high")!.paymentMinor).toBeGreaterThan(5_000);
    expect(result.months.every((month) => month.payments.every((payment) => payment.balanceMinor >= 0))).toBe(true);
  });

  it("rejects a plan that cannot cover minimum payments", () => {
    const result = simulateRepayment({ strategy: "snowball", monthlyAmountMinor: 5_000, debts: [{ id: "one", name: "Card", balanceMinor: 100_000, aprBps: 3000, minimumPaymentMinor: 8_000 }] });
    expect(result.status).toBe("insufficient");
    expect(result.minimumNeededMinor).toBe(8_000);
  });

  it("compares the current path with extra-payment strategies and exposes payoff order", () => {
    const comparison = compareRepaymentPlans({
      currentMonthlyAmountMinor: 10_000,
      extraPaymentMinor: 10_000,
      startMonth: "2026-08",
      debts: [
        { id: "high", name: "High interest", balanceMinor: 100_000, aprBps: 3000, minimumPaymentMinor: 5_000 },
        { id: "small", name: "Small balance", balanceMinor: 50_000, aprBps: 800, minimumPaymentMinor: 5_000 }
      ]
    });
    expect(comparison.plannedMonthlyAmountMinor).toBe(20_000);
    expect(comparison.monthsSaved).toBeGreaterThan(0);
    expect(comparison.recommendedStrategy).toBe("avalanche");
    expect(comparison.avalanche.payoffOrder).toHaveLength(2);
    expect(comparison.avalanche.result.payoffMonth).toBeTruthy();
  });

  it("tracks remaining EMIs and the final payment month from the live loan balance", () => {
    const bank = createAccount({ name: "EMI Test Bank", type: "bank", openingBalanceMinor: 500_000 })!;
    const loan = createAccount({
      name: "EMI Test Loan",
      type: "personal_loan",
      openingBalanceMinor: 120_000,
      originalPrincipalMinor: 120_000,
      installmentMinor: 10_000,
      aprBps: 0,
      nextDueDate: "2026-08-05"
    })!;
    const cardEmi = createAccount({
      name: "EMI Test Card",
      type: "credit_card",
      openingBalanceMinor: 60_000,
      installmentMinor: 10_000,
      remainingTermMonths: 6,
      aprBps: 0,
      nextDueDate: "2026-08-15"
    })!;

    const initialOverview = getDebtOverview("2026-07");
    const initial = initialOverview.debts.find((debt: Record<string, any>) => debt.id === loan.id)!;
    expect(initial).toMatchObject({ scheduledPaymentMinor: 10_000, remainingPayments: 12, payoffMonth: "2027-07", paymentsRecorded: 0 });
    expect(initialOverview.projectedMonths).toBe(12);
    expect(initialOverview.debts.find((debt: Record<string, any>) => debt.id === cardEmi.id)).toBeUndefined();
    expect(getCard(String(cardEmi.id))).not.toHaveProperty("remainingPayments");
    expect(initialOverview.remainingEmis).toBe(12);
    expect(initialOverview).toMatchObject({ interestDataComplete: true, missingAprDebts: [] });

    createTransaction({ type: "debt_payment", date: "2026-08-05", amountMinor: 10_000, accountId: String(bank.id), transferAccountId: String(loan.id), principalMinor: 10_000, source: "hermes" });
    createTransaction({ type: "debt_payment", date: "2026-09-05", amountMinor: 10_000, accountId: String(bank.id), transferAccountId: String(loan.id), principalMinor: 10_000, source: "hermes" });

    const updated = getDebtOverview("2026-10").debts.find((debt: Record<string, any>) => debt.id === loan.id)!;
    expect(updated).toMatchObject({ balanceMinor: 100_000, remainingPayments: 10, payoffMonth: "2027-07", paymentsRecorded: 2, lastPaymentDate: "2026-09-05", nextDueDate: "2026-10-05" });

    createAccount({ name: "APR Missing Loan", type: "personal_loan", openingBalanceMinor: 20_000, installmentMinor: 2_000, nextDueDate: "2026-10-20" });
    expect(getDebtOverview("2026-10")).toMatchObject({
      interestDataComplete: false,
      projectedInterestMinor: null,
      missingAprDebts: [{ name: "APR Missing Loan" }]
    });
  });

  it("never lets a saved repayment scenario change contractual monthly payments", () => {
    const before = getDebtOverview("2026-11").monthlyCommitmentMinor;
    saveRepaymentPlan({ name: "Scenario only", strategy: "avalanche", monthlyAmountMinor: before + 500_000, simulationInput: {}, result: {}, active: true });
    const after = getDebtOverview("2026-11");
    expect(after.monthlyCommitmentMinor).toBe(before);
    expect(after).not.toHaveProperty("planMonthlyAmountMinor");
  });

  it("derives a six-part card-linked balance transfer EMI without counting it twice", () => {
    const before = getLoansOverview("2026-08");
    const card = createAccount({
      name: "Linked Loan Card",
      type: "credit_card",
      institution: "Test Bank",
      openingBalanceMinor: 4_084_000,
      lastStatementDate: "2026-07-20",
      lastStatementBalanceMinor: 680_000
    })!;
    const loan = createLoan({
      name: "Six month balance transfer",
      kind: "balance_transfer",
      institution: "Test Bank",
      linkedCardId: card.id,
      includedInCardBalance: true,
      originalPrincipalMinor: 4_084_000,
      currentBalanceMinor: 4_084_000,
      totalInstallments: 6,
      remainingInstallments: 6,
      aprBps: 0,
      nextDueDate: "2026-08-20"
    })!;
    const overview = getLoansOverview("2026-08");
    expect(overview.totalBalanceMinor - before.totalBalanceMinor).toBe(4_084_000);
    expect(overview.additionalLoanBalanceMinor).toBe(before.additionalLoanBalanceMinor);
    expect(overview.includedInCardsMinor - before.includedInCardsMinor).toBe(4_084_000);
    expect(loan).toMatchObject({ emiMinor: 680_667, scheduledPaymentMinor: 680_667, remainingPayments: 6 });
    expect(getCard(String(card.id))?.loans).toMatchObject([{ id: loan.id, remainingPayments: 6, balanceMinor: 4_084_000, emiMinor: 680_667 }]);
    const forecast = getFinancialForecast("2026-07");
    expect(forecast.cardLinkedEmiMinor).toBe(680_667);
    expect(forecast.cardLinkedEmiOutsideStatementMinor).toBe(0);
    expect(forecast.loanCommitmentOutsideCardStatementsMinor).toBe(forecast.standaloneLoanPaymentMinor);
    expect(forecast.totalCommitmentMinor).toBe(forecast.cardStatementDueMinor + forecast.loanCommitmentOutsideCardStatementsMinor);

    recordLoanInstallment(String(loan.id), { paidDate: "2026-08-20", amountMinor: 680_667, principalMinor: 680_667, idempotencyKey: "linked-loan-emi-1" });
    expect(getLoan(String(loan.id), "2026-09")).toMatchObject({ balanceMinor: 3_403_333, scheduledPaymentMinor: 680_667, remainingPayments: 5, nextDueDate: "2026-09-20", finalEmiMonth: "2027-01" });
  });
});

describe("ledger, budgets, and idempotency", () => {
  it("categorizes AI and Google Cloud expenses as Work", () => {
    expect(inferExpenseCategoryName("OPENAI CHATGPT PLUS")).toBe("Work");
    expect(inferExpenseCategoryName("GOOGLE *CLOUD EMEA")).toBe("Work");
    expect(inferExpenseCategoryName("ANTHROPIC CLAUDE PRO")).toBe("Work");
    const bank = createAccount({ name: "Work Category Bank", type: "bank", openingBalanceMinor: 100_000 })!;
    const transaction = createTransaction({ type: "expense", date: "2024-01-10", amountMinor: 2_000, accountId: String(bank.id), merchant: "Google Cloud", source: "ui" })!;
    expect(transaction.categoryName).toBe("Work");
  });

  it("archives accounts without returning them in the active list", () => {
    const account = createAccount({ name: "Archive me", type: "bank", openingBalanceMinor: 0 })!;
    updateAccount(String(account.id), { archived: true, source: "test" });
    expect(listAccounts().some((item) => item?.id === account.id)).toBe(false);
    expect(listAccounts(true).find((item) => item?.id === account.id)?.archivedAt).toBeTruthy();
  });

  it("creates accounts idempotently", () => {
    const first = createAccount({ name: "Idempotent Account", type: "bank", idempotencyKey: "account-create-1" })!;
    const retried = createAccount({ name: "Different retry name", type: "bank", idempotencyKey: "account-create-1" })!;
    expect(retried.id).toBe(first.id);
    expect(retried.name).toBe("Idempotent Account");
  });

  it("keeps transfers and debt principal out of spending", () => {
    const bank = createAccount({ name: "Test Bank", type: "bank", openingBalanceMinor: 200_000 })!;
    const card = createAccount({ name: "Test Card", type: "credit_card", openingBalanceMinor: 50_000, aprBps: 3600, minimumPaymentMinor: 5_000 })!;
    const groceries = listCategories().find((category) => category?.name === "Groceries")!;
    const fees = listCategories().find((category) => category?.name === "Interest & fees")!;

    const expense = createTransaction({ type: "expense", date: "2026-07-10", amountMinor: 10_000, accountId: String(bank.id), categoryId: String(groceries.id), merchant: "Market", idempotencyKey: "expense-1", source: "hermes" });
    const retried = createTransaction({ type: "expense", date: "2026-07-10", amountMinor: 10_000, accountId: String(bank.id), categoryId: String(groceries.id), merchant: "Market", idempotencyKey: "expense-1", source: "hermes" });
    expect(retried?.id).toBe(expense?.id);

    createTransaction({ type: "debt_payment", date: "2026-07-15", amountMinor: 20_000, accountId: String(bank.id), transferAccountId: String(card.id), principalMinor: 18_000, interestMinor: 2_000, categoryId: String(fees.id), idempotencyKey: "payment-1", source: "hermes" });
    expect(getAccount(String(bank.id))?.balanceMinor).toBe(170_000);
    expect(getAccount(String(card.id))?.balanceMinor).toBe(32_000);
    expect(listTransactions({ accountId: String(bank.id) }).length).toBe(2);
    expect(getDashboard("2026-07").spentMinor).toBe(12_000);

    putBudget("2026-07", [{ categoryId: String(groceries.id), limitMinor: 50_000 }, { categoryId: String(fees.id), limitMinor: 10_000 }]);
    const budget = getBudget("2026-07");
    expect(budget.lines.find((line) => line.categoryId === groceries.id)?.spentMinor).toBe(10_000);
    expect(budget.lines.find((line) => line.categoryId === fees.id)?.spentMinor).toBe(2_000);
  });

  it("rejects debt payments sent to a non-debt destination", () => {
    const source = createAccount({ name: "Debt Source", type: "bank", openingBalanceMinor: 20_000 })!;
    const destination = createAccount({ name: "Not A Debt", type: "bank", openingBalanceMinor: 0 })!;
    expect(() => createTransaction({ type: "debt_payment", date: "2026-07-20", amountMinor: 5_000, accountId: String(source.id), transferAccountId: String(destination.id), source: "ui" })).toThrow("credit card or personal loan");
  });

  it("compares monthly spending patterns without requiring budget limits", () => {
    const bank = createAccount({ name: "Pattern Bank", type: "bank", openingBalanceMinor: 100_000 })!;
    const groceries = listCategories().find((category) => category?.name === "Groceries")!;
    createTransaction({ type: "expense", date: "2025-05-10", amountMinor: 10_000, accountId: String(bank.id), categoryId: String(groceries.id), merchant: "May market", source: "ui" });
    createTransaction({ type: "expense", date: "2025-06-10", amountMinor: 30_000, accountId: String(bank.id), categoryId: String(groceries.id), merchant: "June market", source: "ui" });

    const pattern = getSpendingPatterns("2025-06");
    expect(pattern).toMatchObject({ totalSpentMinor: 30_000, previousMonth: "2025-05", previousSpentMinor: 10_000, changeMinor: 20_000, changePercentage: 200, observedDays: 30, dailyAverageMinor: 1_000 });
    expect(pattern.topCategory).toMatchObject({ categoryName: "Groceries", spentMinor: 30_000, sharePercentage: 100, previousSpentMinor: 10_000, changeMinor: 20_000 });
    expect(pattern.monthlyTrend).toHaveLength(6);
    expect(pattern.monthlyTrend.at(-1)).toEqual({ month: "2025-06", spentMinor: 30_000 });
  });

  it("forecasts the next month from weighted history and exposes category projections", () => {
    const bank = createAccount({ name: "Forecast Bank", type: "bank", openingBalanceMinor: 1_000_000 })!;
    const work = listCategories().find((category) => category?.name === "Work")!;
    createTransaction({ type: "income", date: "2030-05-01", amountMinor: 100_000, accountId: String(bank.id), merchant: "Salary", source: "ui" });
    createTransaction({ type: "expense", date: "2030-05-10", amountMinor: 20_000, accountId: String(bank.id), categoryId: String(work.id), merchant: "OpenAI", source: "ui" });
    createTransaction({ type: "income", date: "2030-06-01", amountMinor: 120_000, accountId: String(bank.id), merchant: "Salary", source: "ui" });
    createTransaction({ type: "expense", date: "2030-06-10", amountMinor: 30_000, accountId: String(bank.id), categoryId: String(work.id), merchant: "Google Cloud", source: "ui" });

    const forecast = getFinancialForecast("2030-06");
    expect(forecast).toMatchObject({ forecastMonth: "2030-07", expectedSpentMinor: 26_667, expectedIncomeMinor: 113_333, dataMonthCount: 2, confidence: "medium" });
    expect(forecast.categories[0]).toMatchObject({ categoryName: "Work", expectedMinor: 26_667 });
    expect(forecast.lowerSpentMinor).toBeLessThan(forecast.expectedSpentMinor);
    expect(forecast.upperSpentMinor).toBeGreaterThan(forecast.expectedSpentMinor);
  });

  it("keeps savings targets outside available-to-save calculations", () => {
    const bank = createAccount({ name: "Capacity Bank", type: "bank", openingBalanceMinor: 1_000_000 })!;
    createTransaction({ type: "income", date: "2040-06-01", amountMinor: 500_000, accountId: String(bank.id), source: "ui" });
    createTransaction({ type: "expense", date: "2040-06-10", amountMinor: 100_000, accountId: String(bank.id), source: "ui" });
    const before = getFinancialForecast("2040-06");
    createMonthlySavingsPlan({ name: "Capacity target", monthlyTargetMinor: 250_000, startMonth: "2040-07", source: "ui" });
    const after = getFinancialForecast("2040-06");
    expect(after.availableToSaveMinor).toBe(before.availableToSaveMinor);
    expect(after.savingsTargetMinor).toBe(before.savingsTargetMinor + 250_000);
    expect(after.savingsTargetGapMinor).toBe(after.availableToSaveMinor - after.savingsTargetMinor);
  });

  it("marks savings capacity incomplete when an active card has no statement", () => {
    const bank = createAccount({ name: "Incomplete Capacity Bank", type: "bank", openingBalanceMinor: 1_000_000 })!;
    createTransaction({ type: "income", date: "2041-06-01", amountMinor: 500_000, accountId: String(bank.id), source: "ui" });
    createAccount({ name: "Payment missing card", type: "credit_card", openingBalanceMinor: 200_000, creditLimitMinor: 500_000 })!;
    const forecast = getFinancialForecast("2041-06");
    expect(forecast.debtPaymentComplete).toBe(true);
    expect(forecast.capacityComplete).toBe(false);
    expect(forecast.missingCardStatementCards).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Payment missing card" })]));
  });

  it("calculates cards from the latest statement and ledger postings without EMI fields", () => {
    const bank = createAccount({ name: "Card Calculation Bank", type: "bank", openingBalanceMinor: 500_000 })!;
    const card = createAccount({
      name: "Statement Card",
      type: "credit_card",
      openingBalanceMinor: 60_000,
      creditLimitMinor: 200_000,
      lastStatementDate: "2026-07-20",
      lastStatementBalanceMinor: 50_000,
      statementDay: 20,
      dueDay: 10,
      installmentMinor: 9_999,
      remainingTermMonths: 99
    })!;
    createTransaction({ type: "expense", date: "2026-07-21", amountMinor: 15_000, accountId: String(card.id), merchant: "After statement", source: "ui" });
    createTransaction({ type: "debt_payment", date: "2026-07-22", amountMinor: 20_000, principalMinor: 20_000, accountId: String(bank.id), transferAccountId: String(card.id), source: "ui" });
    createTransaction({ type: "income", date: "2026-07-23", amountMinor: 5_000, accountId: String(card.id), merchant: "Refund", source: "ui" });

    expect(getCard(String(card.id), "2026-07-24")).toMatchObject({
      currentOutstandingMinor: 50_000,
      lastStatementBalanceMinor: 50_000,
      spendingSinceStatementMinor: 15_000,
      paymentsSinceStatementMinor: 20_000,
      creditsSinceStatementMinor: 5_000,
      statementDueMinor: 25_000,
      availableCreditMinor: 150_000,
      utilizationPercentage: 25,
      paymentDueDate: "2026-08-10",
      nextStatementDate: "2026-08-20",
      statementComplete: true
    });
    expect(getCard(String(card.id))).not.toHaveProperty("remainingPayments");
    expect(getCard(String(card.id))).not.toHaveProperty("installmentMinor");
    expect(getCard(String(card.id))).not.toHaveProperty("remainingTermMonths");
    expect(getDebtOverview("2026-07").debts.some((debt: Record<string, any>) => debt.id === card.id)).toBe(false);
    expect(getCardsOverview().cards.some((value) => value.id === card.id)).toBe(true);
  });

  it("keeps prepaid spending in actuals and forecasts its next renewal after coverage ends", () => {
    const bank = createAccount({ name: "Prepaid Rent Bank", type: "bank", openingBalanceMinor: 1_000_000 })!;
    const home = listCategories().find((category) => category?.name === "Home")!;
    const coveredBaseline = getFinancialForecast("2035-08");
    const renewalBaseline = getFinancialForecast("2035-09");
    createTransaction({ type: "expense", date: "2035-07-01", amountMinor: 300_000, accountId: String(bank.id), categoryId: String(home.id), merchant: "Quarterly rent", coverageStartMonth: "2035-07", coverageEndMonth: "2035-09", source: "ui" });
    expect(getSpendingPatterns("2035-07").totalSpentMinor).toBe(300_000);
    expect(getFinancialForecast("2035-08").expectedSpentMinor).toBe(coveredBaseline.expectedSpentMinor);
    const renewal = getFinancialForecast("2035-09");
    expect(renewal.prepaidRenewalMinor).toBe(300_000);
    expect(renewal.expectedSpentMinor).toBe(renewalBaseline.expectedSpentMinor + 300_000);
    expect(renewal.prepaidRenewals[0]).toMatchObject({ merchant: "Quarterly rent", expectedMonth: "2035-10" });
  });

  it("creates, edits, and archives categories", () => {
    const category = createCategory({ name: "Temporary category", kind: "expense", color: "#123456", source: "ui" })!;
    expect(updateCategory(String(category.id), { name: "Renamed category", color: "#654321", source: "ui" })).toMatchObject({ name: "Renamed category", color: "#654321" });
    updateCategory(String(category.id), { archived: true, source: "ui" });
    expect(listCategories().some((item) => item?.id === category.id)).toBe(false);
    expect(listCategories(true).find((item) => item?.id === category.id)?.archivedAt).toBeTruthy();
  });

  it("keeps lower-spend Work history available to the forecast UI", () => {
    const bank = createAccount({ name: "Full Forecast Bank", type: "bank", openingBalanceMinor: 2_000_000 })!;
    const work = listCategories().find((category) => category?.name === "Work")!;
    createTransaction({ type: "expense", date: "2031-06-05", amountMinor: 1_000, accountId: String(bank.id), categoryId: String(work.id), merchant: "OpenAI", source: "ui" });
    for (let index = 0; index < 8; index += 1) {
      const category = createCategory({ name: `Forecast category ${index + 1}`, kind: "expense", sortOrder: 300 + index, source: "test" })!;
      createTransaction({ type: "expense", date: "2031-06-10", amountMinor: 10_000 + index, accountId: String(bank.id), categoryId: String(category.id), merchant: `Forecast merchant ${index + 1}`, source: "ui" });
    }

    const forecast = getFinancialForecast("2031-06");
    expect(forecast.categories).toHaveLength(9);
    expect(forecast.categories.find((category) => category.categoryName === "Work")).toMatchObject({ expectedMinor: 1_000 });
  });

  it("includes uncategorized expenses and debt costs in every spending total", () => {
    const bank = createAccount({ name: "Uncategorized Bank", type: "bank", openingBalanceMinor: 100_000 })!;
    const card = createAccount({ name: "Uncategorized Card", type: "credit_card", openingBalanceMinor: 50_000 })!;
    createTransaction({ type: "expense", date: "2025-07-10", amountMinor: 12_500, accountId: String(bank.id), merchant: "Uncategorized", source: "ui" });
    createTransaction({ type: "debt_payment", date: "2025-07-15", amountMinor: 10_000, principalMinor: 8_500, interestMinor: 1_500, accountId: String(bank.id), transferAccountId: String(card.id), source: "ui" });

    const dashboard = getDashboard("2025-07");
    const pattern = getSpendingPatterns("2025-07");
    const budget = getBudget("2025-07");
    expect(dashboard.spentMinor).toBe(14_000);
    expect(pattern.totalSpentMinor).toBe(14_000);
    expect(budget).toMatchObject({ totalSpentMinor: 14_000, unbudgetedSpentMinor: 1_500 });
    expect(pattern.categories.find((category: Record<string, any>) => category.categoryName === "Other")).toMatchObject({ spentMinor: 12_500 });
    expect(pattern.categories.find((category: Record<string, any>) => category.categoryName === "Uncategorized")).toMatchObject({ spentMinor: 1_500 });
  });
});

describe("record editing", () => {
  it("updates every top-level record family and preserves calculated balances", () => {
    const bank = createAccount({ name: "Edit Bank", type: "bank", purpose: "savings", openingBalanceMinor: 100_000, currency: "AED" })!;
    expect(bank.purpose).toBe("savings");
    expect(updateAccount(String(bank.id), { purpose: "spending", source: "ui" })?.purpose).toBe("spending");
    const expense = createTransaction({ type: "expense", date: "2026-07-01", amountMinor: 10_000, accountId: String(bank.id), merchant: "Before edit", source: "ui" })!;
    const editedExpense = updateTransaction(String(expense.id), { amountMinor: 15_000, merchant: "After edit", source: "ui" })!;
    expect(editedExpense.merchant).toBe("After edit");
    expect(getAccount(String(bank.id))?.balanceMinor).toBe(85_000);

    const debt = createAccount({ name: "Edit Card", type: "credit_card", currency: "AED", openingBalanceMinor: 50_000, aprBps: 2400, creditLimitMinor: 200_000, minimumPaymentMinor: 5_000 })!;
    const editedDebt = updateAccount(String(debt.id), { name: "Edited Card", aprBps: 2199, creditLimitMinor: 250_000, minimumPaymentMinor: 6_000, statementDay: 5, dueDay: 25, nextDueDate: "2026-08-25", source: "ui" })!;
    expect(editedDebt).toMatchObject({ name: "Edited Card", aprBps: 2199, creditLimitMinor: 250_000, minimumPaymentMinor: 6_000, statementDay: 5, dueDay: 25, nextDueDate: "2026-08-25", balanceMinor: 50_000 });

    const editedPayment = updateTransaction(String(expense.id), { type: "debt_payment", transferAccountId: String(debt.id), principalMinor: 15_000, interestMinor: 0, feeMinor: 0, source: "ui" })!;
    expect(editedPayment).toMatchObject({ type: "debt_payment", accountId: bank.id, transferAccountId: debt.id, amountMinor: 15_000 });
    expect(getAccount(String(bank.id))?.balanceMinor).toBe(85_000);
    expect(getAccount(String(debt.id))?.balanceMinor).toBe(35_000);

    const goal = createSavingsGoal({ name: "Edit Goal", targetMinor: 100_000, targetDate: "2026-12-31", source: "ui" })!;
    expect(updateSavingsGoal(String(goal.id), { name: "Edited Goal", targetMinor: 120_000, targetDate: null, note: "Updated", source: "ui" })).toMatchObject({ name: "Edited Goal", targetMinor: 120_000, targetDate: null, note: "Updated" });

    const monthly = createMonthlySavingsPlan({ name: "Edit monthly", monthlyTargetMinor: 20_000, startMonth: "2026-07", source: "ui" })!;
    expect(updateMonthlySavingsPlan(String(monthly.id), { name: "Edited monthly", monthlyTargetMinor: 25_000, endMonth: "2026-12", source: "ui" })).toMatchObject({ name: "Edited monthly", monthlyTargetMinor: 25_000, endMonth: "2026-12" });

    const asset = createWealthAsset({ name: "Edit fund", type: "mutual_fund", currency: "AED", openingInvestedMinor: 100_000, currentValueMinor: 110_000, asOfDate: "2026-07-01", source: "ui" })!;
    const editedAsset = updateWealthAsset(String(asset.id), { name: "Edited fund", type: "fixed_deposit", institution: "Updated Bank", currency: "USD", note: "Updated", source: "ui" })!;
    expect(editedAsset).toMatchObject({ name: "Edited fund", type: "fixed_deposit", institution: "Updated Bank", currency: "USD", currentValueMinor: 110_000 });
    expect(editedAsset.snapshots).toHaveLength(1);
    updateWealthAsset(String(asset.id), { archived: true, source: "ui" });

    const recurring = createRecurring({ name: "Edit rent", cadence: "monthly", intervalCount: 1, nextDate: "2026-08-01", transaction: { type: "expense", amountMinor: 5_000, accountId: bank.id }, source: "ui" })!;
    updateRecurring(String(recurring.id), { name: "Edited rent", cadence: "weekly", intervalCount: 2, nextDate: "2026-08-15", transaction: { type: "expense", amountMinor: 6_000, accountId: bank.id, merchant: "Landlord" }, source: "ui" });
    expect(getRecurring(String(recurring.id))).toMatchObject({ name: "Edited rent", cadence: "weekly", intervalCount: 2, nextDate: "2026-08-15", transaction: { amountMinor: 6_000, merchant: "Landlord" } });
  });

  it("creates recurring items idempotently and advances end-of-month dates safely", () => {
    const bank = createAccount({ name: "Recurring Bank", type: "bank", openingBalanceMinor: 100_000 })!;
    const input = { name: "Month end", cadence: "monthly", intervalCount: 1, nextDate: "2026-01-31", transaction: { type: "expense", amountMinor: 1_000, accountId: bank.id }, idempotencyKey: "recurring-month-end", source: "ui" };
    const item = createRecurring(input)!;
    expect(createRecurring(input)?.id).toBe(item.id);
    const recorded = recordRecurring(String(item.id))!;
    expect(recorded.recurringItem?.nextDate).toBe("2026-02-28");
    expect(recorded.transaction).toMatchObject({ date: "2026-01-31", amountMinor: 1_000, type: "expense" });
  });
});

describe("savings objectives", () => {
  it("tracks idempotent contributions, withdrawals, progress, corrections, and archiving", () => {
    const goal = createSavingsGoal({ name: "Emergency fund", targetMinor: 100_000, openingSavedMinor: 10_000, targetDate: "2099-12-31", idempotencyKey: "goal-1", source: "hermes" })!;
    const retriedGoal = createSavingsGoal({ name: "Ignored retry", targetMinor: 200_000, idempotencyKey: "goal-1", source: "hermes" })!;
    expect(retriedGoal.id).toBe(goal.id);

    const contribution = addSavingsEntry(String(goal.id), { kind: "contribution", amountMinor: 25_000, date: "2026-07-26", idempotencyKey: "saving-1", source: "hermes" });
    const retriedContribution = addSavingsEntry(String(goal.id), { kind: "contribution", amountMinor: 25_000, date: "2026-07-26", idempotencyKey: "saving-1", source: "hermes" });
    expect(retriedContribution.entry?.id).toBe(contribution.entry?.id);
    expect(retriedContribution.goal?.savedMinor).toBe(35_000);
    expect(retriedContribution.goal?.remainingMinor).toBe(65_000);
    expect(retriedContribution.goal?.percentage).toBe(35);

    const withdrawal = addSavingsEntry(String(goal.id), { kind: "withdrawal", amountMinor: 5_000, date: "2026-07-27", idempotencyKey: "saving-2", source: "hermes" });
    expect(withdrawal.goal?.savedMinor).toBe(30_000);
    expect(() => addSavingsEntry(String(goal.id), { kind: "withdrawal", amountMinor: 30_001, date: "2026-07-27", source: "hermes" })).toThrow("Withdrawal cannot exceed");

    expect(deleteSavingsEntry(String(goal.id), String(withdrawal.entry?.id), "hermes")?.savedMinor).toBe(35_000);
    updateSavingsGoal(String(goal.id), { archived: true, source: "hermes" });
    expect(listSavingsGoals().some((item) => item.id === goal.id)).toBe(false);
    expect(getSavingsGoal(String(goal.id))?.archivedAt).toBeTruthy();
  });
});

describe("monthly savings targets", () => {
  it("derives actual savings and target progress from savings-account ledger movement", () => {
    const source = createAccount({ name: "Savings Source", type: "bank", openingBalanceMinor: 500_000 })!;
    const savings = createAccount({ name: "Savings Ledger", type: "bank", purpose: "savings", openingBalanceMinor: 10_000 })!;
    const plan = createMonthlySavingsPlan({ name: "Save from salary", monthlyTargetMinor: 50_000, startMonth: "2026-06", idempotencyKey: "monthly-plan-1", source: "hermes" })!;
    const retried = createMonthlySavingsPlan({ name: "Ignored", monthlyTargetMinor: 90_000, startMonth: "2026-07", idempotencyKey: "monthly-plan-1", source: "hermes" })!;
    expect(retried.id).toBe(plan.id);
    createTransaction({ type: "transfer", date: "2026-06-05", amountMinor: 50_000, accountId: String(source.id), transferAccountId: String(savings.id), source: "ui" });
    createTransaction({ type: "transfer", date: "2026-07-05", amountMinor: 35_000, accountId: String(source.id), transferAccountId: String(savings.id), source: "ui" });
    expect(getSavingsPosition("2026-07")).toMatchObject({ totalBalanceMinor: 95_000, movementMinor: 35_000 });
    expect(getMonthlySavingsPlan(String(plan.id), "2026-07")).toMatchObject({ actualMinor: 35_000, remainingMinor: 15_000, streak: 1, actualSource: "savings_accounts" });
    createTransaction({ type: "transfer", date: "2026-07-15", amountMinor: 15_000, accountId: String(source.id), transferAccountId: String(savings.id), source: "ui" });
    expect(getMonthlySavingsPlan(String(plan.id), "2026-07")).toMatchObject({ actualMinor: 50_000, complete: true, streak: 2 });
    createTransaction({ type: "expense", date: "2026-07-20", amountMinor: 15_000, accountId: String(savings.id), source: "ui" });
    expect(getMonthlySavingsPlan(String(plan.id), "2026-07")).toMatchObject({ actualMinor: 35_000, remainingMinor: 15_000, complete: false });
    expect(() => updateMonthlySavingsPlan(String(plan.id), { endMonth: "2026-05", source: "hermes" })).toThrow("End month must be");
  });
});

describe("wealth tracking and screenshot review", () => {
  it("keeps dated valuations, cash flows, and confirmation-gated screenshot drafts", () => {
    const asset = createWealthAsset({ name: "Growth Fund", type: "mutual_fund", institution: "Example Bank", currency: "AED", openingInvestedMinor: 100_000, currentValueMinor: 120_000, investedValueMinor: 100_000, asOfDate: "2026-06-30", idempotencyKey: "wealth-asset-1", snapshotIdempotencyKey: "wealth-open-1", source: "hermes" })!;
    addWealthCashFlow(String(asset.id), { kind: "contribution", amountMinor: 50_000, date: "2026-07-01", idempotencyKey: "wealth-flow-1", source: "hermes" });
    const valuation = addWealthSnapshot(String(asset.id), { currentValueMinor: 180_000, investedValueMinor: 150_000, asOfDate: "2026-07-20", idempotencyKey: "wealth-value-1", source: "hermes" });
    expect(valuation.asset?.gainLossMinor).toBe(30_000);
    expect(valuation.asset?.returnPercentage).toBe(20);

    const contribution = addWealthCashFlow(String(asset.id), { kind: "contribution", amountMinor: 10_000, date: "2026-07-21", idempotencyKey: "wealth-flow-after-value", source: "hermes" });
    expect(contribution.asset).toMatchObject({ currentValueMinor: 190_000, investedMinor: 160_000, gainLossMinor: 30_000 });
    const withdrawal = addWealthCashFlow(String(asset.id), { kind: "withdrawal", amountMinor: 5_000, date: "2026-07-22", idempotencyKey: "wealth-withdraw-after-value", source: "hermes" });
    expect(withdrawal.asset).toMatchObject({ currentValueMinor: 185_000, investedMinor: 155_000, gainLossMinor: 30_000 });
    const fee = addWealthCashFlow(String(asset.id), { kind: "fee", amountMinor: 1_000, date: "2026-07-23", idempotencyKey: "wealth-fee-after-value", source: "hermes" });
    expect(fee.asset).toMatchObject({ currentValueMinor: 184_000, investedMinor: 155_000, gainLossMinor: 29_000 });

    createWealthAsset({ name: "India Fund", type: "mutual_fund", currency: "INR", openingInvestedMinor: 500_000, currentValueMinor: 550_000, investedValueMinor: 500_000, asOfDate: "2026-07-20", idempotencyKey: "wealth-inr-1", snapshotIdempotencyKey: "wealth-inr-open-1", source: "hermes" });
    createWealthAsset({ name: "US Deposit", type: "fixed_deposit", currency: "USD", openingInvestedMinor: 100_000, currentValueMinor: 90_000, investedValueMinor: 100_000, asOfDate: "2026-07-20", idempotencyKey: "wealth-usd-1", snapshotIdempotencyKey: "wealth-usd-open-1", source: "hermes" });
    const mixedWealth = getWealthOverview();
    expect(mixedWealth.excludedCurrencyCount).toBe(2);
    expect(mixedWealth.currentValueMinor).toBe(184_000);
    expect(mixedWealth.totalsByCurrency).toEqual(expect.arrayContaining([
      expect.objectContaining({ currency: "AED", currentValueMinor: 184_000 }),
      expect.objectContaining({ currency: "INR", currentValueMinor: 550_000 }),
      expect.objectContaining({ currency: "USD", currentValueMinor: 90_000 })
    ]));

    const draft = createWealthImportDraft({ sourceFilename: "fund-screenshot.png", sourceSha256: "a".repeat(64), capturedAt: "2026-07-26T10:00:00+04:00", institution: "Example Bank", proposals: [{ assetId: asset.id, name: "Growth Fund", type: "mutual_fund", institution: "Example Bank", currency: "AED", currentValueMinor: 200_000, investedValueMinor: 150_000, asOfDate: "2026-07-26" }], extractionNotes: "Values visibly labelled in screenshot", idempotencyKey: "wealth-draft-1", source: "hermes" })!;
    expect(draft.status).toBe("draft");
    expect(getWealthAsset(String(asset.id))?.currentValueMinor).toBe(184_000);
    const applied = applyWealthImportDraft(String(draft.id), "hermes")!;
    expect(applied.status).toBe("applied");
    expect(getWealthAsset(String(asset.id))?.currentValueMinor).toBe(200_000);
    expect(getWealthAsset(String(asset.id))?.gainLossMinor).toBe(50_000);
    expect(applyWealthImportDraft(String(draft.id), "hermes")?.appliedAssets).toHaveLength(1);
    expect(getWealthImportDraft(String(draft.id))?.sourceFilename).toBe("fund-screenshot.png");
  });
});

describe("statement import", () => {
  it("previews, applies, and deduplicates repeated statement rows", async () => {
    const account = createAccount({ name: "Import Bank", type: "bank", openingBalanceMinor: 0 })!;
    const csv = Buffer.from("Date,Description,Debit,Credit\n25/07/2026,Carrefour,123.45,\n26/07/2026,Salary,,1000.00\n");
    const preview = await previewImport({ accountId: String(account.id), filename: "statement.csv", buffer: csv, mapping: { dateFormat: "dd/mm/yyyy" } }) as any;
    expect(preview.status).toBe("preview");
    expect(preview.rowCount).toBe(2);
    expect(preview.totalOutMinor).toBe(12_345);
    expect(preview.totalInMinor).toBe(100_000);

    const applied = applyImport(preview.id, "statement-test") as any;
    expect(applied.status).toBe("applied");
    expect(applied.rows.filter((row: any) => row.status === "applied")).toHaveLength(2);

    const repeated = await previewImport({ accountId: String(account.id), filename: "statement.csv", buffer: csv, mapping: { dateFormat: "dd/mm/yyyy" } }) as any;
    expect(repeated.duplicateCount).toBe(2);
    expect(repeated.rows.filter((row: any) => row.status === "ready")).toHaveLength(0);
  });

  it("previews XLSX statements with the patched workbook parser", async () => {
    const account = createAccount({ name: "XLSX Bank", type: "bank", openingBalanceMinor: 0 })!;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Statement");
    sheet.addRow(["Date", "Description", "Debit", "Credit"]);
    sheet.addRow(["26/07/2026", "Lulu XLSX", "45.25", ""]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const preview = await previewImport({ accountId: String(account.id), filename: "statement.xlsx", buffer, mapping: { dateFormat: "dd/mm/yyyy" } }) as any;
    expect(preview.rowCount).toBe(1);
    expect(preview.totalOutMinor).toBe(4_525);
    expect(preview.rows[0].normalized).not.toHaveProperty("raw");
  });
});
