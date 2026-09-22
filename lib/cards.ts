import { getDb } from "@/lib/db";
import { zonedDateValue } from "@/lib/time";

type CardRecord = Record<string, any>;

function camelize(row: CardRecord) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value]));
}

function getSettings() {
  const rows = getDb().prepare("SELECT key, value FROM settings ORDER BY key").all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function rawCards(includeId?: string) {
  const rows = getDb().prepare(`SELECT a.*, a.opening_balance_minor + COALESCE((
      SELECT SUM(p.amount_minor) FROM transaction_postings p
      JOIN transactions t ON t.id = p.transaction_id
      WHERE p.account_id = a.id AND t.deleted_at IS NULL
    ), 0) AS balance_minor
    FROM accounts a
    WHERE a.archived_at IS NULL AND a.type = 'credit_card' ${includeId ? "AND a.id = ?" : ""}
    ORDER BY a.name`).all(...(includeId ? [includeId] : [])) as CardRecord[];
  return rows.map(camelize);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function dateWithDay(year: number, monthIndex: number, day: number) {
  const date = new Date(Date.UTC(year, monthIndex, 1));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

function nextDateForDay(afterDate: string, day: number) {
  const [year, month] = afterDate.split("-").map(Number);
  const sameMonth = dateWithDay(year, month - 1, day);
  return sameMonth > afterDate ? sameMonth : dateWithDay(year, month, day);
}

function nextStatementDate(card: CardRecord, today: string) {
  const statementDay = Number(card.statementDay ?? 0);
  if (validDate(card.lastStatementDate)) {
    const [year, month] = card.lastStatementDate.split("-").map(Number);
    const day = statementDay || Number(card.lastStatementDate.slice(8, 10));
    return dateWithDay(year, month, day);
  }
  return statementDay >= 1 && statementDay <= 31 ? nextDateForDay(today, statementDay) : null;
}

function paymentDueDate(card: CardRecord) {
  if (validDate(card.nextDueDate)) return card.nextDueDate;
  const dueDay = Number(card.dueDay ?? 0);
  if (!validDate(card.lastStatementDate) || dueDay < 1 || dueDay > 31) return null;
  return nextDateForDay(card.lastStatementDate, dueDay);
}

function statementActivity(cardId: string, statementDate: string | null) {
  if (!statementDate) {
    return { spendingSinceStatementMinor: 0, paymentsSinceStatementMinor: 0, creditsSinceStatementMinor: 0 };
  }
  const rows = getDb().prepare(`SELECT t.type, p.amount_minor
    FROM transaction_postings p
    JOIN transactions t ON t.id = p.transaction_id
    WHERE p.account_id = ? AND t.deleted_at IS NULL AND t.date > ?`)
    .all(cardId, statementDate) as Array<{ type: string; amount_minor: number }>;
  let spendingSinceStatementMinor = 0;
  let paymentsSinceStatementMinor = 0;
  let creditsSinceStatementMinor = 0;
  for (const row of rows) {
    const posting = Number(row.amount_minor);
    if (row.type === "expense" && posting > 0) spendingSinceStatementMinor += posting;
    if (posting >= 0) continue;
    if (row.type === "debt_payment" || row.type === "transfer") paymentsSinceStatementMinor += Math.abs(posting);
    else creditsSinceStatementMinor += Math.abs(posting);
  }
  return { spendingSinceStatementMinor, paymentsSinceStatementMinor, creditsSinceStatementMinor };
}

function totalCardSpending(cardId: string) {
  const row = getDb().prepare(`SELECT COALESCE(SUM(p.amount_minor), 0) AS amount
    FROM transaction_postings p
    JOIN transactions t ON t.id = p.transaction_id
    WHERE p.account_id = ? AND t.deleted_at IS NULL AND t.type = 'expense' AND p.amount_minor > 0`)
    .get(cardId) as { amount: number };
  return Number(row.amount);
}

function linkedLoans(cardId: string) {
  const rows = getDb().prepare(`SELECT id, name, kind, institution, currency, current_balance_minor,
      original_principal_minor, emi_minor, total_installments, remaining_installments, apr_bps,
      next_due_date, included_in_card_balance, prepayment_allowed
    FROM loan_contracts
    WHERE linked_card_id = ? AND archived_at IS NULL
    ORDER BY next_due_date IS NULL, next_due_date, name`).all(cardId) as CardRecord[];
  return rows.map(camelize).map((loan) => {
    const balanceMinor = Math.max(0, Number(loan.currentBalanceMinor));
    const emiMinor = Math.min(balanceMinor, Math.max(0, Number(loan.emiMinor ?? 0)));
    const remainingPayments = loan.remainingInstallments == null ? emiMinor > 0 ? Math.ceil(balanceMinor / emiMinor) : null : Math.max(0, Number(loan.remainingInstallments));
    return { ...loan, balanceMinor, emiMinor, remainingPayments, includedInCardBalance: Boolean(loan.includedInCardBalance), prepaymentAllowed: Boolean(loan.prepaymentAllowed) };
  });
}

export function calculateCard(card: CardRecord, today = zonedDateValue(String(getSettings().timeZone ?? "Asia/Dubai"))): CardRecord {
  const cardView = { ...card };
  for (const legacyField of ["minimumPaymentMinor", "minimumPaymentBps", "originalPrincipalMinor", "installmentMinor", "remainingTermMonths", "prepaymentAllowed"]) {
    delete cardView[legacyField];
  }
  const currentBalance = Number(card.balanceMinor ?? 0);
  const currentOutstandingMinor = Math.max(0, currentBalance);
  const creditBalanceMinor = Math.max(0, -currentBalance);
  const statementComplete = validDate(card.lastStatementDate) && card.lastStatementBalanceMinor != null;
  const lastStatementBalanceMinor = statementComplete ? Math.max(0, Number(card.lastStatementBalanceMinor)) : null;
  const activity = statementActivity(String(card.id), statementComplete ? String(card.lastStatementDate) : null);
  const statementCreditsMinor = activity.paymentsSinceStatementMinor + activity.creditsSinceStatementMinor;
  const statementDueMinor = lastStatementBalanceMinor == null ? null : Math.max(0, lastStatementBalanceMinor - statementCreditsMinor);
  const creditLimitMinor = card.creditLimitMinor == null ? null : Math.max(0, Number(card.creditLimitMinor));
  const availableCreditMinor = creditLimitMinor == null ? null : Math.max(0, creditLimitMinor - currentOutstandingMinor);
  const utilizationPercentage = creditLimitMinor && creditLimitMinor > 0
    ? Math.round(currentOutstandingMinor / creditLimitMinor * 1000) / 10
    : null;
  const loans = linkedLoans(String(card.id));

  return {
    ...cardView,
    balanceMinor: currentBalance,
    currentOutstandingMinor,
    creditBalanceMinor,
    statementComplete,
    lastStatementBalanceMinor,
    spendingSinceStatementMinor: activity.spendingSinceStatementMinor,
    paymentsSinceStatementMinor: activity.paymentsSinceStatementMinor,
    creditsSinceStatementMinor: activity.creditsSinceStatementMinor,
    statementCreditsMinor,
    statementDueMinor,
    totalCardSpendingMinor: totalCardSpending(String(card.id)),
    creditLimitMinor,
    availableCreditMinor,
    utilizationPercentage,
    paymentDueDate: paymentDueDate(card),
    nextStatementDate: nextStatementDate(card, today),
    loans,
    linkedLoanBalanceMinor: loans.reduce((sum, loan) => sum + Number(loan.balanceMinor), 0),
    linkedLoanEmiMinor: loans.reduce((sum, loan) => sum + Number(loan.emiMinor), 0)
  };
}

export function listCards(today?: string) {
  return rawCards().map((account) => calculateCard(account, today));
}

export function getCard(id: string, today?: string) {
  const account = rawCards(id)[0];
  return account ? calculateCard(account, today) : null;
}

export function getCardsOverview(today?: string) {
  const settings = getSettings();
  const currency = String(settings.baseCurrency ?? "AED");
  const cards = listCards(today);
  const totalsByCurrency = Object.values(cards.reduce<Record<string, {
    currency: string;
    cardCount: number;
    currentOutstandingMinor: number;
    statementDueMinor: number;
    spendingSinceStatementMinor: number;
    availableCreditMinor: number;
    statementComplete: boolean;
    creditLimitComplete: boolean;
  }>>((totals, card) => {
    const cardCurrency = String(card.currency || currency);
    totals[cardCurrency] ??= { currency: cardCurrency, cardCount: 0, currentOutstandingMinor: 0, statementDueMinor: 0, spendingSinceStatementMinor: 0, availableCreditMinor: 0, statementComplete: true, creditLimitComplete: true };
    const total = totals[cardCurrency];
    total.cardCount += 1;
    total.currentOutstandingMinor += Number(card.currentOutstandingMinor);
    total.statementDueMinor += Number(card.statementDueMinor ?? 0);
    total.spendingSinceStatementMinor += Number(card.spendingSinceStatementMinor);
    total.availableCreditMinor += Number(card.availableCreditMinor ?? 0);
    total.statementComplete = total.statementComplete && Boolean(card.statementComplete);
    total.creditLimitComplete = total.creditLimitComplete && card.creditLimitMinor != null;
    return totals;
  }, {})).sort((a, b) => a.currency.localeCompare(b.currency));
  const base = totalsByCurrency.find((total) => total.currency === currency) ?? {
    currency,
    cardCount: 0,
    currentOutstandingMinor: 0,
    statementDueMinor: 0,
    spendingSinceStatementMinor: 0,
    availableCreditMinor: 0,
    statementComplete: true,
    creditLimitComplete: true
  };
  const missingStatementCards = cards
    .filter((card) => card.currentOutstandingMinor > 0 && !card.statementComplete)
    .map((card) => ({ id: String(card.id), name: String(card.name), currency: String(card.currency) }));
  return {
    asOfDate: today ?? zonedDateValue(String(settings.timeZone ?? "Asia/Dubai")),
    ...base,
    currency,
    knownStatementDueMinor: base.statementDueMinor,
    statementDueMinor: base.statementComplete ? base.statementDueMinor : null,
    totalsByCurrency,
    excludedCurrencyCount: cards.filter((card) => String(card.currency) !== currency).length,
    statementComplete: missingStatementCards.length === 0,
    missingStatementCards,
    cards
  };
}
