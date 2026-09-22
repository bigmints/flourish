export type RepaymentDebt = {
  id: string;
  name: string;
  balanceMinor: number;
  aprBps: number;
  minimumPaymentMinor: number;
};

export type RepaymentInput = {
  debts: RepaymentDebt[];
  monthlyAmountMinor: number;
  strategy: "avalanche" | "snowball" | "fixed";
  fixedAllocations?: Record<string, number>;
  startMonth?: string;
  maxMonths?: number;
};

export type RepaymentMonth = {
  month: string;
  payments: Array<{ debtId: string; name: string; paymentMinor: number; interestMinor: number; balanceMinor: number }>;
  totalPaymentMinor: number;
  totalInterestMinor: number;
  remainingBalanceMinor: number;
};

export type RepaymentComparisonInput = {
  debts: RepaymentDebt[];
  currentMonthlyAmountMinor: number;
  extraPaymentMinor: number;
  startMonth?: string;
};

function nextMonth(month: string, offset: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1 + offset, 1)).toISOString().slice(0, 7);
}

export function simulateRepayment(input: RepaymentInput) {
  const maxMonths = input.maxMonths ?? 600;
  const startMonth = input.startMonth ?? new Date().toISOString().slice(0, 7);
  const debts = input.debts.map((debt) => ({ ...debt, balanceMinor: Math.max(0, Math.round(debt.balanceMinor)) }));
  const minimumNeeded = debts.reduce((total, debt) => total + Math.min(debt.minimumPaymentMinor, debt.balanceMinor), 0);
  if (input.monthlyAmountMinor < minimumNeeded) {
    return { status: "insufficient" as const, minimumNeededMinor: minimumNeeded, months: [], payoffMonth: null, totalInterestMinor: 0 };
  }

  const months: RepaymentMonth[] = [];
  let totalInterestMinor = 0;
  for (let index = 0; index < maxMonths && debts.some((debt) => debt.balanceMinor > 0); index += 1) {
    const interest = new Map<string, number>();
    for (const debt of debts) {
      const charge = debt.balanceMinor > 0 ? Math.round(debt.balanceMinor * (debt.aprBps / 10000) / 12) : 0;
      debt.balanceMinor += charge;
      interest.set(debt.id, charge);
      totalInterestMinor += charge;
    }

    const payments = new Map<string, number>();
    let remaining = input.monthlyAmountMinor;
    for (const debt of debts) {
      const payment = Math.min(debt.balanceMinor, debt.minimumPaymentMinor);
      payments.set(debt.id, payment);
      remaining -= payment;
    }

    const ordered = [...debts].filter((debt) => debt.balanceMinor - (payments.get(debt.id) ?? 0) > 0).sort((a, b) => {
      if (input.strategy === "snowball") return a.balanceMinor - b.balanceMinor || b.aprBps - a.aprBps;
      if (input.strategy === "fixed") return (input.fixedAllocations?.[b.id] ?? 0) - (input.fixedAllocations?.[a.id] ?? 0);
      return b.aprBps - a.aprBps || a.balanceMinor - b.balanceMinor;
    });

    if (input.strategy === "fixed" && input.fixedAllocations) {
      for (const debt of ordered) {
        const desired = Math.max(0, input.fixedAllocations[debt.id] ?? 0);
        const already = payments.get(debt.id) ?? 0;
        const extra = Math.min(remaining, Math.max(0, Math.min(debt.balanceMinor, desired) - already));
        payments.set(debt.id, already + extra);
        remaining -= extra;
      }
    }

    for (const debt of ordered) {
      if (remaining <= 0) break;
      const already = payments.get(debt.id) ?? 0;
      const extra = Math.min(remaining, debt.balanceMinor - already);
      payments.set(debt.id, already + extra);
      remaining -= extra;
    }

    const paymentRows = debts.filter((debt) => debt.balanceMinor > 0).map((debt) => {
      const paymentMinor = Math.min(debt.balanceMinor, payments.get(debt.id) ?? 0);
      debt.balanceMinor -= paymentMinor;
      return { debtId: debt.id, name: debt.name, paymentMinor, interestMinor: interest.get(debt.id) ?? 0, balanceMinor: debt.balanceMinor };
    });
    months.push({
      month: nextMonth(startMonth, index),
      payments: paymentRows,
      totalPaymentMinor: paymentRows.reduce((sum, row) => sum + row.paymentMinor, 0),
      totalInterestMinor: paymentRows.reduce((sum, row) => sum + row.interestMinor, 0),
      remainingBalanceMinor: debts.reduce((sum, debt) => sum + debt.balanceMinor, 0)
    });
  }

  const paidOff = debts.every((debt) => debt.balanceMinor <= 0);
  return {
    status: paidOff ? ("ok" as const) : ("non_terminating" as const),
    minimumNeededMinor: minimumNeeded,
    months,
    payoffMonth: paidOff ? months.at(-1)?.month ?? startMonth : null,
    totalInterestMinor
  };
}

function payoffOrder(result: ReturnType<typeof simulateRepayment>) {
  if (result.status !== "ok") return [];
  const paid = new Set<string>();
  const order: Array<{ debtId: string; name: string; payoffMonth: string }> = [];
  for (const month of result.months) {
    for (const payment of month.payments) {
      if (payment.balanceMinor > 0 || paid.has(payment.debtId)) continue;
      paid.add(payment.debtId);
      order.push({ debtId: payment.debtId, name: payment.name, payoffMonth: month.month });
    }
  }
  return order;
}

export function compareRepaymentPlans(input: RepaymentComparisonInput) {
  const minimumNeededMinor = input.debts.reduce((sum, debt) => sum + Math.min(Math.max(0, debt.balanceMinor), Math.max(0, debt.minimumPaymentMinor)), 0);
  const currentMonthlyAmountMinor = Math.max(minimumNeededMinor, Math.round(input.currentMonthlyAmountMinor));
  const extraPaymentMinor = Math.max(0, Math.round(input.extraPaymentMinor));
  const plannedMonthlyAmountMinor = currentMonthlyAmountMinor + extraPaymentMinor;
  const baseInput = { debts: input.debts, startMonth: input.startMonth };
  const baseline = currentMonthlyAmountMinor > 0
    ? simulateRepayment({ ...baseInput, strategy: "avalanche", monthlyAmountMinor: currentMonthlyAmountMinor })
    : { status: "insufficient" as const, minimumNeededMinor, months: [], payoffMonth: null, totalInterestMinor: 0 };
  const avalanche = plannedMonthlyAmountMinor > 0
    ? simulateRepayment({ ...baseInput, strategy: "avalanche", monthlyAmountMinor: plannedMonthlyAmountMinor })
    : baseline;
  const snowball = plannedMonthlyAmountMinor > 0
    ? simulateRepayment({ ...baseInput, strategy: "snowball", monthlyAmountMinor: plannedMonthlyAmountMinor })
    : baseline;
  const avalancheMonths = avalanche.status === "ok" ? avalanche.months.length : Number.POSITIVE_INFINITY;
  const snowballMonths = snowball.status === "ok" ? snowball.months.length : Number.POSITIVE_INFINITY;
  const sameResult = avalanche.totalInterestMinor === snowball.totalInterestMinor && avalancheMonths === snowballMonths;
  const recommendedStrategy = sameResult
    ? "either"
    : avalanche.totalInterestMinor < snowball.totalInterestMinor
      ? "avalanche"
      : snowball.totalInterestMinor < avalanche.totalInterestMinor
        ? "snowball"
        : avalancheMonths < snowballMonths ? "avalanche" : "snowball";
  const recommended = recommendedStrategy === "snowball" ? snowball : avalanche;
  const baselineMonths = baseline.status === "ok" ? baseline.months.length : null;
  const recommendedMonths = recommended.status === "ok" ? recommended.months.length : null;

  return {
    currentMonthlyAmountMinor,
    extraPaymentMinor,
    plannedMonthlyAmountMinor,
    minimumNeededMinor,
    recommendedStrategy,
    monthsSaved: baselineMonths != null && recommendedMonths != null ? Math.max(0, baselineMonths - recommendedMonths) : null,
    interestSavedMinor: baseline.status === "ok" && recommended.status === "ok" ? Math.max(0, baseline.totalInterestMinor - recommended.totalInterestMinor) : null,
    baseline: { result: baseline, payoffOrder: payoffOrder(baseline) },
    avalanche: { result: avalanche, payoffOrder: payoffOrder(avalanche) },
    snowball: { result: snowball, payoffOrder: payoffOrder(snowball) }
  };
}
