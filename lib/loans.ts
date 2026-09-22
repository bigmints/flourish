import { randomUUID } from "node:crypto";
import { audit, getDb, inTransaction } from "@/lib/db";
import { createAccount, getAccount, getSettings, updateAccount } from "@/lib/store";
import { zonedMonthValue } from "@/lib/time";

type LoanRecord = Record<string, any>;

const now = () => new Date().toISOString();

function camelize(row: LoanRecord) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value]));
}

function addMonths(date: string, count = 1) {
  const [year, month, day] = date.split("-").map(Number);
  const monthIndex = month - 1 + count;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function installmentCount(value: unknown, allowZero = false) {
  if (value == null || value === "") return null;
  const count = Math.floor(Number(value));
  if (!Number.isFinite(count) || count < (allowZero ? 0 : 1)) return null;
  return count;
}

function scheduledEmiMinor(balanceMinor: number, providedEmiMinor: unknown, remainingInstallments: unknown, totalInstallments: unknown) {
  const explicit = Math.round(Number(providedEmiMinor ?? 0));
  if (explicit > 0) return Math.min(balanceMinor, explicit);
  const remaining = installmentCount(remainingInstallments, true);
  const count = remaining == null ? installmentCount(totalInstallments) : remaining;
  return balanceMinor > 0 && count != null && count > 0 ? Math.round(balanceMinor / count) : 0;
}

function rawLoans(includeArchived = false, id?: string) {
  const conditions = [includeArchived ? "1 = 1" : "lc.archived_at IS NULL"];
  const values: any[] = [];
  if (id) { conditions.push("lc.id = ?"); values.push(id); }
  const rows = getDb().prepare(`SELECT lc.*,
      linked.name AS linked_card_name,
      linked.institution AS linked_card_institution,
      linked.currency AS linked_card_currency,
      backing.opening_balance_minor + COALESCE((
        SELECT SUM(p.amount_minor) FROM transaction_postings p
        JOIN transactions t ON t.id = p.transaction_id
        WHERE p.account_id = backing.id AND t.deleted_at IS NULL
      ), 0) AS account_balance_minor
    FROM loan_contracts lc
    LEFT JOIN accounts linked ON linked.id = lc.linked_card_id
    LEFT JOIN accounts backing ON backing.id = lc.account_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY lc.archived_at IS NOT NULL, lc.next_due_date IS NULL, lc.next_due_date, lc.name`).all(...values) as LoanRecord[];
  return rows.map(camelize);
}

function paymentHistory(loan: LoanRecord) {
  const contractRows = getDb().prepare(`SELECT paid_date FROM loan_installments
    WHERE loan_id = ? AND deleted_at IS NULL ORDER BY paid_date DESC`).all(String(loan.id)) as Array<{ paid_date: string }>;
  const accountRows = loan.accountId ? getDb().prepare(`SELECT t.date FROM transactions t
    WHERE t.deleted_at IS NULL AND t.type = 'debt_payment' AND t.transfer_account_id = ?
    ORDER BY t.date DESC`).all(String(loan.accountId)) as Array<{ date: string }> : [];
  const dates = [...contractRows.map((row) => row.paid_date), ...accountRows.map((row) => row.date)].sort().reverse();
  return { count: dates.length, lastPaymentDate: dates[0] ?? null };
}

function calculateLoan(loan: LoanRecord, startMonth: string): LoanRecord {
  const balanceMinor = Math.max(0, Number(loan.accountId ? loan.accountBalanceMinor : loan.currentBalanceMinor));
  const storedRemaining = loan.remainingInstallments == null ? null : Math.max(0, Number(loan.remainingInstallments));
  const emiMinor = scheduledEmiMinor(balanceMinor, loan.emiMinor, storedRemaining, loan.totalInstallments);
  const history = paymentHistory(loan);
  let nextDueDate = validDate(loan.nextDueDate) ? loan.nextDueDate : null;
  while (nextDueDate && history.lastPaymentDate && nextDueDate <= history.lastPaymentDate) nextDueDate = addMonths(nextDueDate);
  const calculatedRemaining = emiMinor > 0 ? Math.ceil(balanceMinor / emiMinor) : null;
  const remainingPayments = balanceMinor <= 0 ? 0 : storedRemaining ?? calculatedRemaining;
  const firstPaymentMonth = nextDueDate?.slice(0, 7) && nextDueDate.slice(0, 7) > startMonth ? nextDueDate.slice(0, 7) : startMonth;
  const finalEmiMonth = remainingPayments != null && remainingPayments > 0
    ? addMonths(`${firstPaymentMonth}-01`, remainingPayments - 1).slice(0, 7)
    : balanceMinor <= 0 ? startMonth : null;
  return {
    ...loan,
    balanceMinor,
    emiMinor,
    scheduledPaymentMinor: emiMinor,
    remainingPayments,
    remainingEmis: remainingPayments,
    nextDueDate,
    finalEmiMonth,
    payoffMonth: finalEmiMonth,
    fixedEmiSchedule: storedRemaining != null,
    projectionStatus: balanceMinor <= 0 ? "paid_off" : emiMinor > 0 ? "fixed_emi" : "missing_payment",
    paymentsRecorded: history.count,
    lastPaymentDate: history.lastPaymentDate,
    prepaymentAllowed: Boolean(loan.prepaymentAllowed),
    includedInCardBalance: Boolean(loan.includedInCardBalance),
    linkedCard: loan.linkedCardId ? {
      id: loan.linkedCardId,
      name: loan.linkedCardName,
      institution: loan.linkedCardInstitution,
      currency: loan.linkedCardCurrency
    } : null
  };
}

export function listLoans(startMonth = zonedMonthValue(String(getSettings().timeZone ?? "Asia/Dubai")), includeArchived = false): LoanRecord[] {
  return rawLoans(includeArchived).map((loan) => calculateLoan(loan, startMonth));
}

export function getLoan(id: string, startMonth = zonedMonthValue(String(getSettings().timeZone ?? "Asia/Dubai"))): LoanRecord | null {
  const loan = rawLoans(true, id)[0];
  return loan ? calculateLoan(loan, startMonth) : null;
}

export function getLoansOverview(startMonth = zonedMonthValue(String(getSettings().timeZone ?? "Asia/Dubai"))): LoanRecord {
  const loans = listLoans(startMonth);
  const activeLoans = loans.filter((loan) => loan.balanceMinor > 0);
  const totalBalanceMinor = activeLoans.reduce((sum, loan) => sum + Number(loan.balanceMinor), 0);
  const linkedBalanceMinor = activeLoans.filter((loan) => loan.linkedCardId).reduce((sum, loan) => sum + Number(loan.balanceMinor), 0);
  const includedInCardsMinor = activeLoans.filter((loan) => loan.linkedCardId && loan.includedInCardBalance).reduce((sum, loan) => sum + Number(loan.balanceMinor), 0);
  const additionalLoanBalanceMinor = totalBalanceMinor - includedInCardsMinor;
  const monthlyCommitmentMinor = activeLoans.reduce((sum, loan) => sum + Number(loan.scheduledPaymentMinor), 0);
  const missingEmiLoans = activeLoans.filter((loan) => loan.scheduledPaymentMinor <= 0).map((loan) => ({ id: String(loan.id), name: String(loan.name) }));
  const missingAprLoans = activeLoans.filter((loan) => loan.aprBps == null).map((loan) => ({ id: String(loan.id), name: String(loan.name) }));
  const finalMonths = activeLoans.map((loan) => loan.finalEmiMonth).filter(Boolean).sort() as string[];
  const allLoansFinishMonth = activeLoans.length > 0 && finalMonths.length === activeLoans.length ? finalMonths.at(-1) ?? null : totalBalanceMinor === 0 ? startMonth : null;
  const firstDueMonth = activeLoans.map((loan) => String(loan.nextDueDate ?? "").slice(0, 7)).filter((month) => /^\d{4}-\d{2}$/.test(month)).sort()[0];
  const planStartMonth = firstDueMonth && firstDueMonth > startMonth ? firstDueMonth : startMonth;
  const projectedMonths = allLoansFinishMonth
    ? Math.max(0, (Number(allLoansFinishMonth.slice(0, 4)) - Number(planStartMonth.slice(0, 4))) * 12 + Number(allLoansFinishMonth.slice(5, 7)) - Number(planStartMonth.slice(5, 7)) + 1)
    : null;
  const typeGroups = ["personal_loan", "balance_transfer", "card_installment", "other"].map((kind) => {
    const items = loans.filter((loan) => loan.kind === kind);
    return {
      kind,
      loanCount: items.length,
      totalBalanceMinor: items.reduce((sum, loan) => sum + Number(loan.balanceMinor), 0),
      monthlyCommitmentMinor: items.reduce((sum, loan) => sum + Number(loan.scheduledPaymentMinor), 0),
      loans: items
    };
  }).filter((group) => group.loanCount > 0);
  const institutionGroups = Object.values(loans.reduce<Record<string, { institution: string; totalBalanceMinor: number; monthlyCommitmentMinor: number; loanCount: number; loans: LoanRecord[] }>>((groups, loan) => {
    const institution = String(loan.institution || loan.linkedCardInstitution || "Other");
    groups[institution] ??= { institution, totalBalanceMinor: 0, monthlyCommitmentMinor: 0, loanCount: 0, loans: [] };
    groups[institution].totalBalanceMinor += Number(loan.balanceMinor);
    groups[institution].monthlyCommitmentMinor += Number(loan.scheduledPaymentMinor);
    groups[institution].loanCount += 1;
    groups[institution].loans.push(loan);
    return groups;
  }, {})).sort((a, b) => b.totalBalanceMinor - a.totalBalanceMinor);
  return {
    asOfMonth: startMonth,
    planStartMonth,
    totalBalanceMinor,
    linkedBalanceMinor,
    includedInCardsMinor,
    additionalLoanBalanceMinor,
    monthlyCommitmentMinor,
    allLoansFinishMonth,
    debtFreeMonth: allLoansFinishMonth,
    projectedMonths,
    remainingEmis: activeLoans.filter((loan) => loan.remainingPayments != null).reduce((sum, loan) => sum + Number(loan.remainingPayments), 0),
    missingEmiLoans,
    missingDebtPaymentDebts: missingEmiLoans,
    paymentComplete: missingEmiLoans.length === 0,
    interestDataComplete: missingAprLoans.length === 0,
    projectedInterestMinor: null,
    missingAprLoans,
    missingAprDebts: missingAprLoans,
    typeGroups,
    institutionGroups,
    scenarioEligibleLoanCount: activeLoans.filter((loan) => loan.prepaymentAllowed).length,
    scenarioEligibleDebtCount: activeLoans.filter((loan) => loan.prepaymentAllowed).length,
    fixedLoanCount: activeLoans.filter((loan) => !loan.prepaymentAllowed).length,
    fixedDebtCount: activeLoans.filter((loan) => !loan.prepaymentAllowed).length,
    loans,
    debts: loans
  };
}

export function createLoan(input: LoanRecord) {
  if (input.idempotencyKey) {
    const existing = getDb().prepare("SELECT id FROM loan_contracts WHERE idempotency_key = ?").get(input.idempotencyKey) as { id: string } | undefined;
    if (existing) return getLoan(existing.id);
  }
  const linkedCardId = input.linkedCardId ? String(input.linkedCardId) : null;
  if (linkedCardId) {
    const card = getAccount(linkedCardId);
    if (!card || card.type !== "credit_card" || card.archivedAt) throw new Error("Choose an active credit card");
  }
  const settings = getSettings();
  const currency = String(input.currency ?? settings.baseCurrency ?? "AED");
  const currentBalanceMinor = Math.max(0, Number(input.currentBalanceMinor ?? input.originalPrincipalMinor ?? 0));
  const totalInstallments = installmentCount(input.totalInstallments);
  const remainingInstallments = installmentCount(input.remainingInstallments, true) ?? totalInstallments;
  const emiMinor = scheduledEmiMinor(currentBalanceMinor, input.emiMinor, remainingInstallments, totalInstallments);
  if (!linkedCardId) {
    const account = createAccount({
      name: String(input.name),
      type: "personal_loan",
      currency,
      institution: input.institution ?? null,
      openingBalanceMinor: currentBalanceMinor,
      originalPrincipalMinor: Number(input.originalPrincipalMinor ?? currentBalanceMinor),
      installmentMinor: emiMinor || null,
      remainingTermMonths: remainingInstallments,
      aprBps: input.aprBps ?? null,
      nextDueDate: input.nextDueDate ?? null,
      prepaymentAllowed: Boolean(input.prepaymentAllowed),
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:account` : null,
      source: input.source ?? "api"
    });
    if (!account) throw new Error("Could not create the loan account");
    getDb().prepare(`UPDATE loan_contracts SET kind = ?, total_installments = ?, remaining_installments = ?, updated_at = ? WHERE id = ?`)
      .run(String(input.kind ?? "personal_loan"), totalInstallments, remainingInstallments, now(), String(account.id));
    return getLoan(String(account.id));
  }
  const id = randomUUID();
  const timestamp = now();
  getDb().prepare(`INSERT INTO loan_contracts(
    id, name, kind, institution, currency, linked_card_id, included_in_card_balance,
    original_principal_minor, current_balance_minor, emi_minor, total_installments,
    remaining_installments, apr_bps, next_due_date, prepayment_allowed, idempotency_key,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, String(input.name), String(input.kind ?? "balance_transfer"), input.institution ?? null, currency,
      linkedCardId, input.includedInCardBalance === false ? 0 : 1,
      Number(input.originalPrincipalMinor ?? currentBalanceMinor), currentBalanceMinor, emiMinor || null,
      totalInstallments, remainingInstallments, input.aprBps ?? null,
      input.nextDueDate ?? null, input.prepaymentAllowed ? 1 : 0, input.idempotencyKey ?? null,
      timestamp, timestamp
    );
  audit("create", "loan", id, String(input.source ?? "api"), { name: input.name, kind: input.kind, linkedCardId });
  return getLoan(id);
}

export function updateLoan(id: string, input: LoanRecord) {
  const current = getLoan(id);
  if (!current) return null;
  if (input.linkedCardId !== undefined && current.accountId) throw new Error("A standalone loan cannot be moved onto a card");
  if (input.linkedCardId !== undefined && input.linkedCardId !== null) {
    const card = getAccount(String(input.linkedCardId));
    if (!card || card.type !== "credit_card" || card.archivedAt) throw new Error("Choose an active credit card");
  }
  const effectiveBalanceMinor = Math.max(0, Number(input.currentBalanceMinor ?? current.balanceMinor ?? 0));
  const effectiveTotalInstallments = input.totalInstallments === undefined ? installmentCount(current.totalInstallments) : installmentCount(input.totalInstallments);
  const effectiveRemainingInstallments = input.remainingInstallments === undefined
    ? installmentCount(current.remainingInstallments ?? current.remainingPayments, true)
    : installmentCount(input.remainingInstallments, true);
  const effectiveEmiMinor = scheduledEmiMinor(
    effectiveBalanceMinor,
    input.emiMinor === undefined ? current.emiMinor : input.emiMinor,
    effectiveRemainingInstallments,
    effectiveTotalInstallments
  );
  const emiUpdate = input.emiMinor !== undefined || Number(current.emiMinor ?? 0) <= 0 ? effectiveEmiMinor || null : undefined;
  if (current.accountId) {
    const desiredBalance = input.currentBalanceMinor;
    const account = getAccount(String(current.accountId));
    updateAccount(String(current.accountId), {
      name: input.name,
      currency: input.currency,
      institution: input.institution,
      originalPrincipalMinor: input.originalPrincipalMinor,
      installmentMinor: emiUpdate,
      remainingTermMonths: input.remainingInstallments,
      aprBps: input.aprBps,
      nextDueDate: input.nextDueDate,
      prepaymentAllowed: input.prepaymentAllowed,
      openingBalanceMinor: desiredBalance === undefined || !account ? undefined : Number(account.openingBalanceMinor) + Number(desiredBalance) - Number(account.balanceMinor),
      archived: input.archived,
      source: input.source ?? "api"
    });
  }
  const fields: Record<string, any> = {
    name: input.name,
    kind: input.kind,
    institution: input.institution,
    currency: input.currency,
    linked_card_id: input.linkedCardId,
    included_in_card_balance: input.includedInCardBalance === undefined ? undefined : input.includedInCardBalance ? 1 : 0,
    original_principal_minor: input.originalPrincipalMinor,
    current_balance_minor: input.currentBalanceMinor,
    emi_minor: emiUpdate,
    total_installments: input.totalInstallments,
    remaining_installments: input.remainingInstallments,
    apr_bps: input.aprBps,
    next_due_date: input.nextDueDate,
    prepayment_allowed: input.prepaymentAllowed === undefined ? undefined : input.prepaymentAllowed ? 1 : 0,
    archived_at: input.archived === true ? now() : input.archived === false ? null : undefined
  };
  const present = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (present.length) {
    const assignments = [...present.map(([key]) => `${key} = ?`), "updated_at = ?"].join(", ");
    getDb().prepare(`UPDATE loan_contracts SET ${assignments} WHERE id = ?`).run(...present.map(([, value]) => value), now(), id);
  }
  audit("update", "loan", id, String(input.source ?? "api"), { fields: present.map(([key]) => key) });
  return getLoan(id);
}

export function recordLoanInstallment(id: string, input: LoanRecord) {
  const loan = getLoan(id);
  if (!loan || loan.archivedAt) return null;
  if (input.idempotencyKey) {
    const existing = getDb().prepare("SELECT id FROM loan_installments WHERE idempotency_key = ?").get(input.idempotencyKey) as { id: string } | undefined;
    if (existing) return getLoan(id);
  }
  const amountMinor = Number(input.amountMinor);
  const interestMinor = Math.max(0, Number(input.interestMinor ?? 0));
  const feeMinor = Math.max(0, Number(input.feeMinor ?? 0));
  const principalMinor = Math.max(0, Number(input.principalMinor ?? amountMinor - interestMinor - feeMinor));
  if (amountMinor <= 0 || principalMinor + interestMinor + feeMinor !== amountMinor) throw new Error("Installment parts must equal the paid amount");
  if (principalMinor > Number(loan.balanceMinor)) throw new Error("Principal cannot exceed the remaining loan balance");
  const paymentId = randomUUID();
  const timestamp = now();
  inTransaction((db) => {
    db.prepare(`INSERT INTO loan_installments(id, loan_id, paid_date, amount_minor, principal_minor, interest_minor, fee_minor, transaction_id, note, source, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(paymentId, id, input.paidDate, amountMinor, principalMinor, interestMinor, feeMinor, input.transactionId ?? null, input.note ?? null, input.source ?? "api", input.idempotencyKey ?? null, timestamp);
    const nextBalance = Math.max(0, Number(loan.balanceMinor) - principalMinor);
    const nextRemaining = loan.remainingInstallments == null ? null : Math.max(0, Number(loan.remainingInstallments) - 1);
    const nextDueDate = validDate(loan.nextDueDate) ? addMonths(loan.nextDueDate) : null;
    db.prepare("UPDATE loan_contracts SET current_balance_minor = ?, remaining_installments = ?, next_due_date = ?, updated_at = ? WHERE id = ?")
      .run(nextBalance, nextRemaining, nextDueDate, timestamp, id);
    if (loan.accountId && !input.transactionId) {
      db.prepare("UPDATE accounts SET opening_balance_minor = MAX(0, opening_balance_minor - ?), updated_at = ? WHERE id = ?")
        .run(principalMinor, timestamp, String(loan.accountId));
    }
  });
  audit("record", "loan_installment", paymentId, String(input.source ?? "api"), { loanId: id, amountMinor, principalMinor });
  return getLoan(id);
}

export function repaymentLoanInputs(prepaymentOnly = false) {
  return listLoans().filter((loan) => !prepaymentOnly || loan.prepaymentAllowed).map((loan) => ({
    id: String(loan.id),
    name: String(loan.name),
    balanceMinor: Number(loan.balanceMinor),
    aprBps: Number(loan.aprBps ?? 0),
    minimumPaymentMinor: Number(loan.scheduledPaymentMinor)
  }));
}
