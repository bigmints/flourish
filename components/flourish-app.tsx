"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownLeft, ArrowRightLeft, ArrowUpRight, Banknote, CalendarDays, ChartNoAxesCombined,
  ChevronRight, CircleDollarSign, CreditCard, Download, FileUp, House, Landmark, LayoutDashboard,
  List, LoaderCircle, Menu, MoreHorizontal, PiggyBank, Plus, ReceiptText, RefreshCw,
  Pencil, Settings2, Sparkles, Target, TrendingDown, Upload, WalletCards
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription as UiDialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { DatePicker, MonthPicker } from "@/components/ui/date-picker";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

type RecordValue = Record<string, any>;
type Tab = "home" | "transactions" | "spending" | "savings" | "wealth" | "cards" | "loans" | "more";

const tabs: Array<{ id: Tab; label: string; shortLabel?: string; icon: typeof House }> = [
  { id: "home", label: "Home", icon: House },
  { id: "transactions", label: "Transactions", shortLabel: "Activity", icon: List },
  { id: "spending", label: "Spending", icon: ReceiptText },
  { id: "savings", label: "Savings", icon: PiggyBank },
  { id: "wealth", label: "Wealth", icon: ChartNoAxesCombined },
  { id: "cards", label: "Cards", icon: CreditCard },
  { id: "loans", label: "Loans", icon: Landmark },
  { id: "more", label: "More", icon: MoreHorizontal }
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { ...init, headers: { ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...init?.headers } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const fields = payload?.error?.fieldErrors as Record<string, string[] | undefined> | undefined;
    const field = fields && Object.entries(fields).find(([, messages]) => messages?.length);
    const fieldMessage = field ? `${field[0]}: ${field[1]?.[0]}` : undefined;
    throw new Error(fieldMessage ?? payload?.error?.message ?? `Request failed (${response.status})`);
  }
  return payload.data as T;
}

function idempotencyKey(prefix: string) {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    return `${prefix}:${webCrypto.randomUUID()}`;
  }

  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
    const randomPart = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `${prefix}:${randomPart}`;
  }

  return `${prefix}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function money(minor: number | undefined, currency = "AED") {
  return new Intl.NumberFormat("en-AE", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(minor ?? 0) / 100);
}

function shortDate(value: string | undefined) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en-AE", { day: "numeric", month: "short" }).format(new Date(`${value}T00:00:00`));
}

function monthLabel(value: string, includeYear = false) {
  const [year, month] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-AE", { month: "short", year: includeYear ? "numeric" : undefined }).format(new Date(year, month - 1, 1));
}

function standardAmount(minor: number) {
  return new Intl.NumberFormat("en-AE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(minor) / 100);
}

function decimalFromMinor(minor: unknown, emptyWhenZero = false) {
  if (minor == null || minor === "") return "";
  const amount = Number(minor) / 100;
  if (!Number.isFinite(amount) || (emptyWhenZero && amount === 0)) return "";
  return amount.toFixed(2);
}

function derivedEmiInput(balance: unknown, remainingInstallments: unknown, totalInstallments: unknown) {
  const balanceAmount = Number(balance);
  const remaining = remainingInstallments === "" || remainingInstallments == null ? null : Number(remainingInstallments);
  const total = totalInstallments === "" || totalInstallments == null ? null : Number(totalInstallments);
  const count = remaining ?? total;
  if (!Number.isFinite(balanceAmount) || balanceAmount <= 0 || !Number.isInteger(Number(count)) || Number(count) <= 0) return "";
  return (Math.round(balanceAmount * 100 / Number(count)) / 100).toFixed(2);
}

function localToday() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localMonth() {
  return localToday().slice(0, 7);
}

function SectionHeading({ title, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold tracking-tight md:text-2xl">{title}</h2>{action}</div>;
}

function RefreshButton({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [refreshing, setRefreshing] = useState(false);
  return <Button type="button" variant="outline" size="icon" disabled={refreshing} onClick={() => { setRefreshing(true); void onRefresh().finally(() => setRefreshing(false)); }} aria-label="Refresh data"><RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} /></Button>;
}

function Empty({ icon: Icon, title, message }: { icon: typeof WalletCards; title: string; message?: string }) {
  const label = title === "Build your wealth view" ? "No holdings" : title;
  return <div className="flex min-h-48 flex-col items-center justify-center rounded-2xl border border-dashed p-6 text-center"><span className="mb-3 rounded-2xl bg-secondary p-3"><Icon className="h-6 w-6 text-primary" /></span><h3 className="font-semibold">{label}</h3>{message && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{message}</p>}</div>;
}

function DialogDescription(_: React.PropsWithChildren) {
  return <UiDialogDescription className="sr-only">Form details.</UiDialogDescription>;
}

function StatCard({ label, value, note, icon: Icon, tone = "default" }: { label: string; value: string; note?: string; icon: typeof WalletCards; tone?: "default" | "warm" }) {
  return <Card className={cn("overflow-hidden", tone === "warm" && "border-amber-200 bg-amber-50/70")}><CardContent className="p-4 md:p-5"><div className="flex items-center justify-between gap-2"><p className="text-[11px] font-medium uppercase tracking-[.12em] text-muted-foreground md:text-xs">{label}</p><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary md:h-10 md:w-10 md:rounded-xl"><Icon className="h-4 w-4 md:h-5 md:w-5" /></span></div><p className="mt-2 text-xl font-semibold tracking-tight md:text-2xl">{value}</p>{note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}</CardContent></Card>;
}

export function FlourishApp() {
  const [tab, setTab] = useState<Tab>("home");
  const [month, setMonth] = useState(localMonth);
  const [data, setData] = useState<RecordValue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [transactionOpen, setTransactionOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<RecordValue | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<RecordValue | null>(null);
  const [newAccountType, setNewAccountType] = useState("bank");
  const [loanOpen, setLoanOpen] = useState(false);
  const [editingLoan, setEditingLoan] = useState<RecordValue | null>(null);
  const [linkedCardId, setLinkedCardId] = useState<string | null>(null);
  const [installmentLoan, setInstallmentLoan] = useState<RecordValue | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [dashboard, spending, forecast, transactions, categories, recurring, savings, monthlySavings, wealth, cardsOverview, loanOverview] = await Promise.all([
        api<RecordValue>(`/dashboard?month=${month}`), api<RecordValue>(`/spending-patterns?month=${month}`), api<RecordValue>(`/forecast?month=${month}`), api<RecordValue[]>("/transactions?limit=150"), api<RecordValue[]>("/categories"), api<RecordValue[]>("/recurring-items"), api<RecordValue[]>("/savings-goals"), api<RecordValue[]>(`/monthly-savings-plans?month=${month}`), api<RecordValue>("/wealth"), api<RecordValue>("/cards/overview"), api<RecordValue>(`/loans/overview?month=${month}`)
      ]);
      setData({ dashboard, spending, forecast, transactions, categories, recurring, savings, monthlySavings, wealth, cardsOverview, cards: cardsOverview.cards, loanOverview, accounts: dashboard.accounts, loans: loanOverview.loans });
    } catch (value) { setError(value instanceof Error ? value.message : "Could not load Flourish"); }
    finally { setLoading(false); }
  }, [month]);

  useEffect(() => { void load(); }, [load]);
  const currency = String(data?.dashboard?.currency ?? "AED");
  return <div className="min-h-dvh md:grid md:grid-cols-[240px_1fr]">
    <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r bg-white px-4 py-5 md:flex">
      <Brand />
      <nav className="mt-8 space-y-1" aria-label="Main navigation">{tabs.map(({ id, label, icon: Icon }) => <Button type="button" variant="ghost" key={id} onClick={() => setTab(id)} className={cn("w-full justify-start gap-3 px-3 text-left text-sm font-medium", tab === id ? "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground" : "text-muted-foreground hover:text-foreground")}><Icon className="h-5 w-5" />{label}</Button>)}</nav>
    </aside>

    <main className="min-w-0 md:col-start-2">
      <div className="mx-auto max-w-7xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
        {error && <div role="alert" className="mb-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>}
        {loading && !data ? <div className="flex min-h-[60vh] items-center justify-center"><LoaderCircle className="h-7 w-7 animate-spin text-primary" /><span className="ml-3 text-sm text-muted-foreground">Loading your finances…</span></div> : data && <div className="page-enter" key={tab}>
          {tab === "home" && <Home data={data} month={month} setMonth={setMonth} currency={currency} setTab={setTab} onRefresh={load} />}
          {tab === "transactions" && <Transactions data={data} currency={currency} onAdd={() => { setEditingTransaction(null); setTransactionOpen(true); }} onEdit={(transaction) => { setEditingTransaction(transaction); setTransactionOpen(true); }} onSaved={load} onRefresh={load} />}
          {tab === "spending" && <Spending data={data} currency={currency} month={month} setMonth={setMonth} onSaved={load} onRefresh={load} />}
          {tab === "savings" && <Savings data={data} currency={currency} month={month} setMonth={setMonth} onSaved={load} onRefresh={load} />}
          {tab === "wealth" && <Wealth data={data} currency={currency} onSaved={load} onRefresh={load} />}
          {tab === "cards" && <Cards data={data} currency={currency} onAdd={() => { setEditingAccount(null); setNewAccountType("credit_card"); setAccountOpen(true); }} onEdit={(card) => { setEditingAccount(card); setAccountOpen(true); }} onAddLoan={(card) => { setEditingLoan(null); setLinkedCardId(String(card.id)); setLoanOpen(true); }} onEditLoan={(loan) => { setEditingLoan(loan); setLinkedCardId(loan.linkedCardId || null); setLoanOpen(true); }} onRefresh={load} />}
          {tab === "loans" && <Loans data={data} currency={currency} onAdd={() => { setEditingLoan(null); setLinkedCardId(null); setLoanOpen(true); }} onEdit={(loan) => { setEditingLoan(loan); setLinkedCardId(loan.linkedCardId || null); setLoanOpen(true); }} onRecord={(loan) => setInstallmentLoan(loan)} onRefresh={load} />}
          {tab === "more" && <More data={data} currency={currency} onAddAccount={() => { setEditingAccount(null); setNewAccountType("bank"); setAccountOpen(true); }} onEditAccount={(account) => { setEditingAccount(account); setAccountOpen(true); }} onSaved={load} onRefresh={load} />}
        </div>}
      </div>
    </main>

    <Button type="button" size="icon" onClick={() => { setEditingTransaction(null); setTransactionOpen(true); }} className="fixed bottom-24 right-4 z-30 h-14 min-h-14 w-14 rounded-full shadow-lg transition hover:scale-105 md:hidden" aria-label="Add transaction"><Plus className="h-6 w-6" /></Button>
    <nav className="safe-bottom fixed inset-x-0 bottom-0 z-20 grid grid-cols-8 border-t bg-white/95 px-1 pt-2 backdrop-blur md:hidden" aria-label="Main navigation">{tabs.map(({ id, label, shortLabel, icon: Icon }) => <Button type="button" variant="ghost" key={id} onClick={() => setTab(id)} className={cn("h-auto min-h-14 min-w-0 flex-col gap-1 rounded-xl px-0 text-[8px] font-medium hover:bg-transparent min-[380px]:text-[9px]", tab === id ? "text-primary hover:text-primary" : "text-muted-foreground")}><Icon className={cn("h-5 w-5", tab === id && "fill-primary/10")} />{shortLabel ?? label}</Button>)}</nav>

    <TransactionDialog open={transactionOpen} onOpenChange={(open) => { setTransactionOpen(open); if (!open) setEditingTransaction(null); }} transaction={editingTransaction} data={data} onSaved={load} />
    <AccountDialog open={accountOpen} onOpenChange={(open) => { setAccountOpen(open); if (!open) setEditingAccount(null); }} account={editingAccount} defaultType={newAccountType} currency={currency} onSaved={load} />
    <LoanDialog open={loanOpen} onOpenChange={(open) => { setLoanOpen(open); if (!open) { setEditingLoan(null); setLinkedCardId(null); } }} loan={editingLoan} defaultLinkedCardId={linkedCardId} cards={(data?.cards ?? []) as RecordValue[]} currency={currency} onSaved={load} />
    <InstallmentDialog open={Boolean(installmentLoan)} onOpenChange={(open) => { if (!open) setInstallmentLoan(null); }} loan={installmentLoan} onSaved={load} />
  </div>;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="flex items-center gap-2.5"><span className={cn("flex items-center justify-center rounded-xl bg-primary text-primary-foreground", compact ? "h-9 w-9" : "h-10 w-10")}><ChartNoAxesCombined className="h-5 w-5" /></span><p className={cn("font-semibold tracking-tight", compact ? "text-lg" : "text-xl")}>Flourish</p></div>;
}

function Home({ data, month, setMonth, currency, setTab, onRefresh }: { data: RecordValue; month: string; setMonth: (month: string) => void; currency: string; setTab: (tab: Tab) => void; onRefresh: () => Promise<void> }) {
  const dashboard = data.dashboard;
  const forecast = data.forecast as RecordValue;
  const loans = data.loans as RecordValue[];
  const loanOverview = data.loanOverview as RecordValue;
  const cards = data.cards as RecordValue[];
  const totalLoans = loans.filter((loan) => String(loan.currency || currency) === currency).reduce((sum, loan) => sum + Math.max(0, Number(loan.balanceMinor)), 0);
  const totalCards = cards.filter((card) => String(card.currency || currency) === currency).reduce((sum, card) => sum + Math.max(0, Number(card.currentOutstandingMinor)), 0);
  const additionalLoans = Number(loanOverview.additionalLoanBalanceMinor ?? totalLoans);
  const totalDebt = totalCards + additionalLoans;
  const missingCommitments = (forecast.missingCommitmentAccounts as RecordValue[] ?? []).map((item) => String(item.name));
  return <>
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Overview</h1>
      <div className="flex items-center gap-2"><RefreshButton onRefresh={onRefresh} /><MonthPicker value={month} onChange={setMonth} className="w-[165px]" aria-label="Dashboard month" required /></div>
    </div>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard label="Income" value={money(dashboard.incomeMinor, currency)} note={monthLabel(month, true)} icon={ArrowDownLeft} />
      <StatCard label="Spending" value={money(dashboard.spentMinor, currency)} note={monthLabel(month, true)} icon={ArrowUpRight} />
      <StatCard label="Total owed" value={money(totalDebt, currency)} note={`${money(totalCards, currency)} cards · ${money(additionalLoans, currency)} outside cards`} icon={TrendingDown} />
      <StatCard label="Total savings" value={money(dashboard.savings?.totalBalanceMinor, currency)} note="Savings accounts" icon={PiggyBank} />
    </div>
    <Card className="mt-6">
      <CardHeader><CardTitle>{monthLabel(forecast.forecastMonth, true)} forecast</CardTitle><CardDescription>Based on {forecast.dataMonthCount} recorded {Number(forecast.dataMonthCount) === 1 ? "month" : "months"}</CardDescription></CardHeader>
      <CardContent><div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6"><div><p className="text-xs text-muted-foreground">Expected income</p><p className="mt-1 font-semibold">{money(forecast.expectedIncomeMinor, currency)}</p></div><div><p className="text-xs text-muted-foreground">Expected spending</p><p className="mt-1 font-semibold">{money(forecast.expectedSpentMinor, currency)}</p><p className="mt-1 text-xs text-muted-foreground">{money(forecast.lowerSpentMinor, currency)}–{money(forecast.upperSpentMinor, currency)}</p></div><div><p className="text-xs text-muted-foreground">Loan EMIs outside cards</p><p className="mt-1 font-semibold">{money(forecast.loanCommitmentOutsideCardStatementsMinor, currency)}</p>{Number(forecast.cardLinkedEmiMinor) > Number(forecast.cardLinkedEmiOutsideStatementMinor) && <p className="mt-1 text-xs text-muted-foreground">{money(Number(forecast.cardLinkedEmiMinor) - Number(forecast.cardLinkedEmiOutsideStatementMinor), currency)} included in card statements</p>}</div><div><p className="text-xs text-muted-foreground">Card statement due</p><p className="mt-1 font-semibold">{forecast.cardStatementComplete === false ? "Not available" : money(forecast.cardStatementDueMinor, currency)}</p></div><div><p className="text-xs text-muted-foreground">{forecast.capacityComplete === false ? "Maximum available" : "Available to save"}</p><p className={cn("mt-1 font-semibold", Number(forecast.availableToSaveMinor) < 0 ? "text-red-700" : "text-emerald-700")}>{money(forecast.availableToSaveMinor, currency)}</p>{missingCommitments.length > 0 && <p className="mt-1 text-xs text-amber-700">Missing {missingCommitments.join(", ")}</p>}</div><div><p className="text-xs text-muted-foreground">Savings target</p><p className="mt-1 font-semibold">{money(forecast.savingsTargetMinor, currency)}</p><p className="mt-1 text-xs text-muted-foreground">{forecast.capacityComplete === false ? "Capacity incomplete" : Number(forecast.savingsTargetGapMinor) >= 0 ? `${money(forecast.savingsTargetGapMinor, currency)} below capacity` : `${money(Math.abs(Number(forecast.savingsTargetGapMinor)), currency)} above capacity`}</p></div></div></CardContent>
    </Card>
    <div className="mt-6 grid gap-5 lg:grid-cols-[1.25fr_.75fr]">
      <Card><CardHeader className="flex-row items-start justify-between"><CardTitle>Spending by category</CardTitle><Button variant="ghost" size="sm" onClick={() => setTab("spending")}>Spending <ChevronRight className="h-4 w-4" /></Button></CardHeader><CardContent>{(dashboard.spendingByCategory as RecordValue[]).some((item) => Number(item.spentMinor) > 0) ? <div className="space-y-4">{(dashboard.spendingByCategory as RecordValue[]).filter((item) => Number(item.spentMinor) > 0).slice(0, 6).map((item) => { const max = Math.max(...dashboard.spendingByCategory.map((row: RecordValue) => Number(row.spentMinor)), 1); return <div key={item.categoryId}><div className="mb-1.5 flex justify-between gap-3 text-sm"><span className="font-medium">{item.categoryName}</span><span>{money(item.spentMinor, currency)}</span></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full" style={{ width: `${Number(item.spentMinor) / max * 100}%`, backgroundColor: item.color }} /></div></div>; })}</div> : <Empty icon={ReceiptText} title="No spending" />}</CardContent></Card>
      <Card><CardHeader><CardTitle>Recent activity</CardTitle></CardHeader><CardContent className="space-y-1">{(dashboard.recentTransactions as RecordValue[]).length ? dashboard.recentTransactions.slice(0, 6).map((transaction: RecordValue) => <TransactionRow key={transaction.id} transaction={transaction} currency={currency} compact />) : <Empty icon={ReceiptText} title="No activity" />}</CardContent></Card>
    </div>
  </>;
}

function TransactionRow({ transaction, currency, onEdit }: { transaction: RecordValue; currency: string; compact?: boolean; onEdit?: (transaction: RecordValue) => void }) {
  const positive = transaction.type === "income";
  const transfer = transaction.type === "transfer" || transaction.type === "debt_payment";
  const Icon = positive ? ArrowDownLeft : transfer ? ArrowRightLeft : ReceiptText;
  const timing = transaction.coverageStartMonth && transaction.coverageEndMonth ? `Covers ${monthLabel(transaction.coverageStartMonth)}–${monthLabel(transaction.coverageEndMonth, true)}` : transaction.source === "recurring" ? "Recurring" : "One-off";
  return <div className="flex min-w-0 items-center gap-3 rounded-xl px-1 py-3 hover:bg-muted/60"><span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", positive ? "bg-emerald-100 text-emerald-700" : transfer ? "bg-blue-100 text-blue-700" : "bg-secondary text-primary")}><Icon className="h-4.5 w-4.5" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{transaction.merchant || transaction.note || transaction.type.replace("_", " ")}</p><p className="truncate text-xs text-muted-foreground">{shortDate(transaction.date)} · {transaction.categoryName || transaction.accountName} · {timing}</p></div><div className="text-right"><p className={cn("whitespace-nowrap text-sm font-semibold", positive && "text-emerald-700")}>{positive ? "+" : transfer ? "" : "−"}{money(transaction.amountMinor, transaction.currency || currency)}</p></div>{onEdit && <Button type="button" variant="ghost" size="icon" className="h-9 min-h-9 w-9 shrink-0" onClick={() => onEdit(transaction)} aria-label={`Edit ${transaction.merchant || transaction.note || "transaction"}`}><Pencil className="h-4 w-4" /></Button>}</div>;
}

function Transactions({ data, currency, onAdd, onEdit, onSaved, onRefresh }: { data: RecordValue; currency: string; onAdd: () => void; onEdit: (transaction: RecordValue) => void; onSaved: () => Promise<void>; onRefresh: () => Promise<void> }) {
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [recurringOpen, setRecurringOpen] = useState(false);
  const [editingRecurring, setEditingRecurring] = useState<RecordValue | null>(null);
  const [recordingId, setRecordingId] = useState("");
  const [recurringError, setRecurringError] = useState("");
  const recurring = data.recurring as RecordValue[];
  const values = (data.transactions as RecordValue[]).filter((transaction) => (!search || `${transaction.merchant} ${transaction.note} ${transaction.categoryName}`.toLowerCase().includes(search.toLowerCase())) && (!type || transaction.type === type));
  async function record(item: RecordValue) { setRecordingId(String(item.id)); setRecurringError(""); try { await api(`/recurring-items/${item.id}/record`, { method: "POST" }); await onSaved(); } catch (value) { setRecurringError(value instanceof Error ? value.message : "Could not record transaction"); } finally { setRecordingId(""); } }
  return <><SectionHeading title="Transactions" action={<div className="flex items-center gap-2"><RefreshButton onRefresh={onRefresh} /><Button onClick={onAdd}><Plus className="h-4 w-4" /> Add</Button></div>} />
    <Card className="mb-4"><CardHeader className="flex-row items-center justify-between"><CardTitle>Recurring</CardTitle><Button variant="outline" size="sm" onClick={() => { setEditingRecurring(null); setRecurringOpen(true); }}><Plus className="h-4 w-4" /> Add</Button></CardHeader><CardContent>{recurringError && <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{recurringError}</p>}{recurring.length ? <div className="divide-y">{recurring.map((item) => <div key={item.id} className="flex min-w-0 items-center gap-2 py-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{item.name}</p><p className="truncate text-xs text-muted-foreground">{item.cadence} · next {shortDate(item.nextDate)} · {money(item.transaction?.amountMinor, item.transaction?.currency || currency)}</p></div><Button variant="outline" size="sm" disabled={Boolean(recordingId)} onClick={() => void record(item)}>{recordingId === item.id && <LoaderCircle className="h-4 w-4 animate-spin" />} Record</Button><Button type="button" variant="ghost" size="icon" className="h-9 min-h-9 w-9" onClick={() => { setEditingRecurring(item); setRecurringOpen(true); }} aria-label={`Edit ${item.name}`}><Pencil className="h-4 w-4" /></Button></div>)}</div> : <Empty icon={CalendarDays} title="Nothing recurring" />}</CardContent></Card>
    <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_180px]"><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search transactions" aria-label="Search transactions" /><Select value={type} onChange={(event) => setType(event.target.value)} aria-label="Filter by type"><option value="">All types</option><option value="expense">Expenses</option><option value="income">Income</option><option value="transfer">Transfers</option><option value="debt_payment">Card or loan payments</option></Select></div><Card><CardContent className="p-3 md:p-5">{values.length ? <div className="divide-y">{values.map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} currency={currency} onEdit={onEdit} />)}</div> : <Empty icon={ReceiptText} title="No matching transactions" />}</CardContent></Card>
    <RecurringDialog open={recurringOpen} item={editingRecurring} accounts={data.accounts as RecordValue[]} categories={data.categories as RecordValue[]} onOpenChange={(open) => { setRecurringOpen(open); if (!open) setEditingRecurring(null); }} onSaved={onSaved} />
  </>;
}

function Spending({ data, currency, month, setMonth, onSaved, onRefresh }: { data: RecordValue; currency: string; month: string; setMonth: (month: string) => void; onSaved: () => Promise<void>; onRefresh: () => Promise<void> }) {
  const pattern = data.spending as RecordValue;
  const forecast = data.forecast as RecordValue;
  const categories = pattern.categories as RecordValue[];
  const trend = pattern.monthlyTrend as RecordValue[];
  const maxTrend = Math.max(...trend.map((item) => Number(item.spentMinor)), 1);
  const changePercentage = pattern.changePercentage == null ? null : Number(pattern.changePercentage);
  const changeValue = Number(pattern.previousSpentMinor) === 0
    ? Number(pattern.totalSpentMinor) > 0 ? "New" : "No change"
    : `${changePercentage! > 0 ? "+" : changePercentage! < 0 ? "−" : ""}${Math.abs(changePercentage!).toFixed(1)}%`;
  const topCategory = pattern.topCategory as RecordValue | null;
  const workCurrent = categories.find((category) => category.categoryName === "Work");
  const workForecast = (forecast.categories as RecordValue[]).find((category) => category.categoryName === "Work");
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<RecordValue | null>(null);
  const missingCommitmentNames = (forecast.missingCommitmentAccounts as RecordValue[] ?? []).map((item) => String(item.name));

  return <>
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3"><h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Spending</h1><div className="flex items-center gap-2"><RefreshButton onRefresh={onRefresh} /><MonthPicker value={month} onChange={setMonth} className="w-[165px]" aria-label="Spending month" required /></div></div>
    <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard label="Spent" value={money(pattern.totalSpentMinor, currency)} note={monthLabel(month, true)} icon={ReceiptText} />
      <StatCard label="Change" value={changeValue} note={`From ${monthLabel(pattern.previousMonth, true)}`} icon={ArrowRightLeft} tone={Number(pattern.changeMinor) > 0 ? "warm" : "default"} />
      <StatCard label="Daily average" value={money(pattern.dailyAverageMinor, currency)} note={`${pattern.observedDays} days`} icon={CalendarDays} />
      <StatCard label="Top category" value={topCategory?.categoryName ?? "None"} note={topCategory ? `${money(topCategory.spentMinor, currency)} · ${topCategory.sharePercentage}%` : undefined} icon={List} />
    </div>

    <Card className="mb-5">
      <CardHeader><CardTitle>{monthLabel(forecast.forecastMonth, true)} outlook</CardTitle><CardDescription>Based on {forecast.dataMonthCount} recorded {Number(forecast.dataMonthCount) === 1 ? "month" : "months"}</CardDescription></CardHeader>
      <CardContent className="grid gap-5 lg:grid-cols-[1fr_.9fr]">
        <div className="grid grid-cols-2 gap-4"><div><p className="text-xs text-muted-foreground">Expected spending</p><p className="mt-1 text-xl font-semibold">{money(forecast.expectedSpentMinor, currency)}</p><p className="mt-1 text-xs text-muted-foreground">Likely {money(forecast.lowerSpentMinor, currency)}–{money(forecast.upperSpentMinor, currency)}</p></div><div><p className="text-xs text-muted-foreground">Current monthly pace</p><p className="mt-1 text-xl font-semibold">{money(forecast.currentMonthProjectedMinor, currency)}</p><p className="mt-1 text-xs text-muted-foreground">Projected full-month total</p></div><div><p className="text-xs text-muted-foreground">Work spending</p><p className="mt-1 font-semibold">{money(workCurrent?.spentMinor, currency)} now</p><p className="mt-1 text-xs text-muted-foreground">{money(workForecast?.expectedMinor, currency)} expected next month</p></div><div><p className="text-xs text-muted-foreground">{forecast.capacityComplete === false ? "Maximum available" : "Available to save"}</p><p className={cn("mt-1 font-semibold", Number(forecast.availableToSaveMinor) < 0 ? "text-red-700" : "text-emerald-700")}>{money(forecast.availableToSaveMinor, currency)}</p><p className={cn("mt-1 text-xs", missingCommitmentNames.length ? "text-amber-700" : "text-muted-foreground")}>{missingCommitmentNames.length ? `Missing ${missingCommitmentNames.join(", ")}` : "After spending, loan EMIs, and card statements"}</p></div></div>
        <div><p className="mb-3 text-sm font-medium">Expected categories</p><div className="space-y-3">{(forecast.categories as RecordValue[]).slice(0, 5).map((category) => <div key={category.categoryName} className="flex items-center justify-between gap-3 text-sm"><span className="flex min-w-0 items-center gap-2"><span className="h-2.5 w-2.5 shrink-0 rounded-full bg-primary/70" />{category.categoryName}</span><span className="font-medium">{money(category.expectedMinor, currency)}</span></div>)}</div></div>
      </CardContent>
    </Card>

    <div className="grid gap-5 lg:grid-cols-[.85fr_1.15fr]">
      <Card>
        <CardHeader><CardTitle>Six-month trend</CardTitle></CardHeader>
        <CardContent>
          <div className="grid h-52 grid-cols-6 items-end gap-2 border-b pb-3">
            {trend.map((item) => {
              const spentMinor = Number(item.spentMinor);
              const height = spentMinor > 0 ? Math.max(8, spentMinor / maxTrend * 132) : 4;
              return <div key={item.month} className="flex min-w-0 flex-col items-center justify-end gap-2" aria-label={`${monthLabel(item.month, true)}: ${money(spentMinor, currency)}`}>
                <span className="text-[10px] font-medium text-muted-foreground">{standardAmount(spentMinor)}</span>
                <div className={cn("w-full max-w-10 rounded-t-lg", item.month === month ? "bg-primary" : "bg-secondary")} style={{ height }} />
                <span className={cn("text-[10px]", item.month === month ? "font-semibold text-foreground" : "text-muted-foreground")}>{monthLabel(item.month)}</span>
              </div>;
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Spending by category</CardTitle></CardHeader>
        <CardContent className="p-4 pt-0 md:p-5 md:pt-0">
          {categories.length ? <div className="divide-y">{categories.map((line) => {
            const changeMinor = Number(line.changeMinor);
            const previousMinor = Number(line.previousSpentMinor);
            const comparison = previousMinor === 0
              ? "New this month"
              : changeMinor === 0
                ? "No change"
                : `${changeMinor > 0 ? "+" : "−"}${money(Math.abs(changeMinor), currency)} from last month`;
            return <div key={line.categoryId} className="py-4 first:pt-0 last:pb-0">
              <div className="flex items-start gap-3"><span className="mt-1.5 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: line.color }} /><div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-3"><div><p className="font-medium">{line.categoryName}</p><p className={cn("mt-1 text-xs", changeMinor > 0 ? "text-amber-700" : changeMinor < 0 ? "text-emerald-700" : "text-muted-foreground")}>{comparison}</p></div><div className="text-right"><p className="font-semibold">{money(line.spentMinor, currency)}</p><p className="mt-1 text-xs text-muted-foreground">{line.sharePercentage}%</p></div></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full" style={{ width: `${line.sharePercentage}%`, backgroundColor: line.color }} /></div></div></div>
            </div>;
          })}</div> : <Empty icon={ReceiptText} title="No spending" />}
        </CardContent>
      </Card>
    </div>
    <Card className="mt-5"><CardHeader className="flex-row items-center justify-between"><CardTitle>Categories</CardTitle><Button variant="outline" size="sm" onClick={() => { setEditingCategory(null); setCategoryOpen(true); }}><Plus className="h-4 w-4" /> Add</Button></CardHeader><CardContent className="divide-y">{(data.categories as RecordValue[]).filter((category) => category.kind === "expense").map((category) => <div key={category.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"><span className="h-3 w-3 rounded-full" style={{ backgroundColor: category.color }} /><p className="min-w-0 flex-1 truncate text-sm font-medium">{category.name}</p><Button type="button" variant="ghost" size="icon" className="h-9 min-h-9 w-9" onClick={() => { setEditingCategory(category); setCategoryOpen(true); }} aria-label={`Edit ${category.name}`}><Pencil className="h-4 w-4" /></Button></div>)}</CardContent></Card>
    <CategoryDialog open={categoryOpen} category={editingCategory} onOpenChange={(open) => { setCategoryOpen(open); if (!open) setEditingCategory(null); }} onSaved={onSaved} />
  </>;
}

function CategoryDialog({ open, category, onOpenChange, onSaved }: { open: boolean; category: RecordValue | null; onOpenChange: (open: boolean) => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<RecordValue>({ name: "", kind: "expense", color: "#5f8f76" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (open) { setForm(category ? { name: category.name, kind: category.kind, color: category.color } : { name: "", kind: "expense", color: "#5f8f76" }); setError(""); } }, [open, category]);
  async function submit(event: React.FormEvent) { event.preventDefault(); setSaving(true); setError(""); try { await api(category ? `/categories/${category.id}` : "/categories", { method: category ? "PATCH" : "POST", body: JSON.stringify({ name: String(form.name).trim(), kind: form.kind, color: form.color, source: "ui" }) }); onOpenChange(false); await onSaved(); } catch (value) { setError(value instanceof Error ? value.message : "Could not save category"); } finally { setSaving(false); } }
  async function archive() { if (!category) return; setSaving(true); setError(""); try { await api(`/categories/${category.id}`, { method: "PATCH", body: JSON.stringify({ archived: true, source: "ui" }) }); onOpenChange(false); await onSaved(); } catch (value) { setError(value instanceof Error ? value.message : "Could not archive category"); } finally { setSaving(false); } }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>{category ? "Edit category" : "Add category"}</DialogTitle><DialogDescription>Category details.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={submit}>{error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}<div><Label htmlFor="category-name">Name</Label><Input id="category-name" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></div><div><Label htmlFor="category-kind">Type</Label><Select id="category-kind" disabled={Boolean(category)} value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}><option value="expense">Expense</option><option value="income">Income</option></Select></div><div><Label htmlFor="category-color">Color</Label><Input id="category-color" type="color" value={form.color} onChange={(event) => setForm({ ...form, color: event.target.value })} /></div><div className={cn("grid gap-2", category && "grid-cols-2")}>{category && <Button type="button" variant="destructive" disabled={saving} onClick={() => void archive()}>Archive</Button>}<Button type="submit" disabled={saving}>{saving && <LoaderCircle className="h-4 w-4 animate-spin" />} Save</Button></div></form></DialogContent></Dialog>;
}

function Cards({ data, currency, onAdd, onEdit, onAddLoan, onEditLoan, onRefresh }: { data: RecordValue; currency: string; onAdd: () => void; onEdit: (card: RecordValue) => void; onAddLoan: (card: RecordValue) => void; onEditLoan: (loan: RecordValue) => void; onRefresh: () => Promise<void> }) {
  const overview = data.cardsOverview as RecordValue;
  const cards = data.cards as RecordValue[];
  const baseNote = Number(overview.excludedCurrencyCount) > 0 ? `${overview.excludedCurrencyCount} non-${currency} ${Number(overview.excludedCurrencyCount) === 1 ? "card" : "cards"} shown separately` : undefined;
  return <>
    <SectionHeading title="Cards" action={<div className="flex items-center gap-2"><RefreshButton onRefresh={onRefresh} /><Button onClick={onAdd}><Plus className="h-4 w-4" /> Add card</Button></div>} />
    <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard label="Outstanding" value={money(overview.currentOutstandingMinor, currency)} note={baseNote} icon={CreditCard} />
      <StatCard label="Statement due" value={overview.statementDueMinor == null ? "Not available" : money(overview.statementDueMinor, currency)} note={overview.statementComplete ? undefined : "Some statements are missing"} icon={CalendarDays} />
      <StatCard label="New spending" value={overview.statementComplete ? money(overview.spendingSinceStatementMinor, currency) : "Not available"} note={overview.statementComplete ? undefined : "Statement dates are missing"} icon={ReceiptText} />
      <StatCard label="Available credit" value={money(overview.availableCreditMinor, currency)} note={overview.creditLimitComplete ? undefined : "Some limits are missing"} icon={WalletCards} />
    </div>
    {cards.length ? <div className="grid gap-4 lg:grid-cols-2">{cards.map((card) => <Card key={card.id}><CardContent className="p-5">
      <div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-start gap-3"><span className="rounded-xl bg-secondary p-2.5 text-primary"><CreditCard className="h-5 w-5" /></span><div className="min-w-0"><h3 className="font-semibold">{card.name}</h3>{card.institution && <p className="mt-1 text-xs text-muted-foreground">{card.institution}</p>}<Badge className="mt-2" tone={card.statementComplete ? "neutral" : "warn"}>{card.statementComplete ? "Statement recorded" : "Statement needed"}</Badge></div></div><Button type="button" variant="ghost" size="icon" className="h-9 min-h-9 w-9 shrink-0" onClick={() => onEdit(card)} aria-label={`Edit ${card.name}`}><Pencil className="h-4 w-4" /></Button></div>
      <div className="mt-5 flex items-end justify-between gap-3"><div><p className="text-xs text-muted-foreground">Current outstanding</p><p className="mt-1 text-2xl font-semibold tracking-tight">{money(card.currentOutstandingMinor, card.currency || currency)}</p></div>{Number(card.creditBalanceMinor) > 0 && <p className="text-sm font-medium text-emerald-700">{money(card.creditBalanceMinor, card.currency || currency)} credit</p>}</div>
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl bg-muted/55 p-3 text-sm">
        <div><p className="text-xs text-muted-foreground">Last statement</p><p className="mt-1 font-semibold">{card.statementComplete ? money(card.lastStatementBalanceMinor, card.currency || currency) : "Not set"}</p>{card.lastStatementDate && <p className="mt-1 text-xs text-muted-foreground">{shortDate(card.lastStatementDate)}</p>}</div>
        <div><p className="text-xs text-muted-foreground">Still due</p><p className="mt-1 font-semibold">{card.statementDueMinor == null ? "Not available" : money(card.statementDueMinor, card.currency || currency)}</p>{card.paymentDueDate && <p className="mt-1 text-xs text-muted-foreground">Due {shortDate(card.paymentDueDate)}</p>}</div>
        <div><p className="text-xs text-muted-foreground">Spent since statement</p><p className="mt-1 font-semibold">{card.statementComplete ? money(card.spendingSinceStatementMinor, card.currency || currency) : "Not available"}</p></div>
        <div><p className="text-xs text-muted-foreground">Paid and credited</p><p className="mt-1 font-semibold">{card.statementComplete ? money(card.statementCreditsMinor, card.currency || currency) : "Not available"}</p></div>
      </div>
      {Number(card.creditLimitMinor) > 0 && <div className="mt-4"><div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>{money(card.availableCreditMinor, card.currency || currency)} available</span><span>{Number(card.utilizationPercentage).toFixed(1)}% used</span></div><Progress value={Number(card.utilizationPercentage)} /></div>}
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm"><div><p className="text-xs text-muted-foreground">Payment due</p><p className="mt-1 font-medium">{shortDate(card.paymentDueDate)}</p></div><div><p className="text-xs text-muted-foreground">Next statement</p><p className="mt-1 font-medium">{shortDate(card.nextStatementDate)}</p></div><div className="col-span-2"><p className="text-xs text-muted-foreground">Recorded card spending</p><p className="mt-1 font-medium">{money(card.totalCardSpendingMinor, card.currency || currency)}</p></div></div>
      <div className="mt-5 border-t pt-4"><div className="mb-3 flex items-center justify-between gap-3"><p className="text-sm font-semibold">Loans on this card</p><Button type="button" variant="outline" size="sm" onClick={() => onAddLoan(card)}><Plus className="h-4 w-4" /> Add</Button></div>{(card.loans as RecordValue[] ?? []).length ? (card.loans as RecordValue[]).map((loan) => <Button key={loan.id} type="button" variant="ghost" className="mt-1 h-auto w-full justify-between rounded-xl px-3 py-3 text-left" onClick={() => onEditLoan({ ...loan, linkedCardId: card.id, linkedCardName: card.name })}><span><span className="block text-sm font-medium">{loan.name}</span><span className="mt-1 block text-xs font-normal text-muted-foreground">{money(loan.emiMinor, loan.currency || currency)} EMI · {loan.remainingPayments ?? "—"} left</span></span><span className="text-sm font-semibold">{money(loan.balanceMinor, loan.currency || currency)}</span></Button>) : <p className="text-sm text-muted-foreground">None</p>}</div>
    </CardContent></Card>)}</div> : <Empty icon={CreditCard} title="No cards added" />}
  </>;
}

function Loans({ data, currency, onAdd, onEdit, onRecord, onRefresh }: { data: RecordValue; currency: string; onAdd: () => void; onEdit: (loan: RecordValue) => void; onRecord: (loan: RecordValue) => void; onRefresh: () => Promise<void> }) {
  const loans = data.loans as RecordValue[];
  const overview = data.loanOverview as RecordValue;
  const missingEmiNames = (overview.missingEmiLoans as RecordValue[] ?? []).map((loan) => String(loan.name));
  const kindLabels: Record<string, string> = { personal_loan: "Personal loan", balance_transfer: "Balance transfer", card_installment: "Card purchase EMI", other: "Other loan" };
  return <>
    <SectionHeading title="Loans" action={<div className="flex items-center gap-2"><RefreshButton onRefresh={onRefresh} /><Button onClick={onAdd}><Plus className="h-4 w-4" /> Add loan</Button></div>} />
    <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard label="Loan balances" value={money(overview.totalBalanceMinor, currency)} note={Number(overview.includedInCardsMinor) > 0 ? `${money(overview.includedInCardsMinor, currency)} included in cards` : undefined} icon={Landmark} />
      <StatCard label="Monthly EMIs" value={money(overview.monthlyCommitmentMinor, currency)} note={missingEmiNames.length ? `Missing ${missingEmiNames.join(", ")}` : undefined} icon={CalendarDays} />
      <StatCard label="All loans finish" value={Number(overview.totalBalanceMinor) <= 0 ? "Paid off" : overview.allLoansFinishMonth ? monthLabel(overview.allLoansFinishMonth, true) : "EMI needed"} icon={TrendingDown} />
      <StatCard label="EMIs remaining" value={String(overview.remainingEmis ?? 0)} icon={List} />
    </div>

    {(overview.institutionGroups as RecordValue[]).length > 0 && <Card className="mb-5"><CardHeader><CardTitle>By bank</CardTitle></CardHeader><CardContent className="divide-y">{(overview.institutionGroups as RecordValue[]).map((group) => <div key={group.institution} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0"><p className="font-medium">{group.institution}</p><p className="text-right font-semibold">{money(group.totalBalanceMinor, currency)}</p><p className="text-xs text-muted-foreground">{group.loanCount} {Number(group.loanCount) === 1 ? "loan" : "loans"}</p><p className="text-right text-xs text-muted-foreground">{money(group.monthlyCommitmentMinor, currency)} monthly</p></div>)}</CardContent></Card>}
    {loans.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{loans.map((loan) => {
      const originalPrincipal = Number(loan.originalPrincipalMinor || 0);
      const paidPercentage = originalPrincipal > 0 ? Math.max(0, Math.min(100, (originalPrincipal - Number(loan.balanceMinor)) / originalPrincipal * 100)) : 0;
      return <Card key={loan.id}><CardContent className="p-5">
        <div className="flex items-start justify-between gap-3"><span className="rounded-xl bg-secondary p-2.5 text-primary"><Landmark className="h-5 w-5" /></span><div className="flex items-center gap-1"><Badge tone={loan.projectionStatus === "missing_payment" ? "warn" : "neutral"}>{loan.projectionStatus === "missing_payment" ? "EMI missing" : kindLabels[String(loan.kind)] ?? "Loan"}</Badge><Button type="button" variant="ghost" size="icon" className="h-9 min-h-9 w-9" onClick={() => onEdit(loan)} aria-label={`Edit ${loan.name}`}><Pencil className="h-4 w-4" /></Button></div></div>
        <h3 className="mt-4 font-semibold">{loan.name}</h3><p className="mt-1 text-xs text-muted-foreground">{loan.linkedCardName ? `${loan.linkedCardName} · ${loan.institution || "Card-linked"}` : loan.institution || "Standalone"}</p>
        <p className="mt-1 text-2xl font-semibold tracking-tight">{money(loan.balanceMinor, loan.currency || currency)}</p>
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl bg-muted/55 p-3 text-sm">
          <div><p className="text-xs text-muted-foreground">Monthly EMI</p><p className="mt-1 font-semibold">{loan.scheduledPaymentMinor ? money(loan.scheduledPaymentMinor, loan.currency || currency) : "Not set"}</p></div>
          <div><p className="text-xs text-muted-foreground">EMIs left</p><p className="mt-1 font-semibold">{loan.remainingPayments ?? "Not set"}</p></div>
          <div><p className="text-xs text-muted-foreground">Final EMI</p><p className="mt-1 font-semibold">{loan.finalEmiMonth ? monthLabel(loan.finalEmiMonth, true) : "Not set"}</p></div>
          <div><p className="text-xs text-muted-foreground">Next due</p><p className="mt-1 font-semibold">{shortDate(loan.nextDueDate)}</p></div>
        </div>
        {originalPrincipal > 0 && <div className="mt-4"><div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>Repaid</span><span>{Math.round(paidPercentage)}%</span></div><Progress value={paidPercentage} /></div>}
        {Number(loan.balanceMinor) > 0 && <Button type="button" variant="outline" className="mt-4 w-full" onClick={() => onRecord(loan)}>Record EMI</Button>}
      </CardContent></Card>;
    })}</div> : <Empty icon={Landmark} title="No loans added" />}

  </>;
}

function objectiveMonthlyRequirement(goal: RecordValue) {
  if (!goal.targetDate) return null;
  const now = localMonth().split("-").map(Number);
  const target = String(goal.targetDate).slice(0, 7).split("-").map(Number);
  const months = Math.max(1, (target[0] - now[0]) * 12 + target[1] - now[1] + 1);
  return Math.ceil(Number(goal.targetMinor) / months);
}

function Savings({ data, currency, month, setMonth, onSaved, onRefresh }: { data: RecordValue; currency: string; month: string; setMonth: (month: string) => void; onSaved: () => Promise<void>; onRefresh: () => Promise<void> }) {
  const goals = data.savings as RecordValue[];
  const monthlyPlans = data.monthlySavings as RecordValue[];
  const position = data.dashboard.savings as RecordValue;
  const savingsAccounts = position.accounts as RecordValue[];
  const savingsTotals = position.totalsByCurrency as RecordValue[];
  const [goalOpen, setGoalOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<RecordValue | null>(null);
  const [monthlyPlanOpen, setMonthlyPlanOpen] = useState(false);
  const [editingMonthlyPlan, setEditingMonthlyPlan] = useState<RecordValue | null>(null);
  const targetMinor = goals.reduce((sum, goal) => sum + Number(goal.targetMinor), 0);
  const monthlyTarget = monthlyPlans.filter((plan) => plan.activeForMonth).reduce((sum, plan) => sum + Number(plan.monthlyTargetMinor), 0);
  const monthlyActual = Math.max(0, Number(position.movementMinor));
  const monthlyRemaining = Math.max(0, monthlyTarget - monthlyActual);
  const bestStreak = monthlyPlans.reduce((value, plan) => Math.max(value, Number(plan.streak)), 0);
  const forecast = data.forecast as RecordValue;
  const missingCommitmentNames = (forecast.missingCommitmentAccounts as RecordValue[] ?? []).map((item) => String(item.name));

  return <>
    <SectionHeading title="Savings" action={<div className="flex items-center gap-2"><RefreshButton onRefresh={onRefresh} /><MonthPicker value={month} onChange={setMonth} className="w-[165px]" aria-label="Savings month" required /></div>} />
    <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard label="Total savings" value={money(position.totalBalanceMinor, currency)} icon={PiggyBank} />
      <StatCard label="Saved this month" value={money(monthlyActual, currency)} note={Number(position.movementMinor) < 0 ? `Net withdrawal ${money(Math.abs(Number(position.movementMinor)), currency)}` : monthLabel(month, true)} icon={ArrowDownLeft} />
      <StatCard label={forecast.capacityComplete === false ? "Maximum next month" : "Can save next month"} value={money(forecast.availableToSaveMinor, currency)} note={missingCommitmentNames.length ? `Missing ${missingCommitmentNames.join(", ")}` : "After spending, loan EMIs, and card statements"} icon={CircleDollarSign} tone={Number(forecast.availableToSaveMinor) < 0 ? "warm" : "default"} />
      <StatCard label="Monthly target" value={money(monthlyTarget, currency)} note={forecast.capacityComplete === false ? "Capacity incomplete" : Number(forecast.savingsTargetGapMinor) >= 0 ? `${money(forecast.savingsTargetGapMinor, currency)} capacity left` : `${money(Math.abs(Number(forecast.savingsTargetGapMinor)), currency)} above capacity`} icon={Target} />
    </div>
    {savingsAccounts.length > 0 ? <Card className="mb-5"><CardHeader><CardTitle>Savings accounts</CardTitle></CardHeader><CardContent>
      <div className="mb-4 grid grid-cols-2 gap-3">{savingsTotals.map((total) => <div key={total.currency} className="rounded-xl bg-muted/55 p-3"><p className="text-xs text-muted-foreground">{total.currency}</p><p className="mt-1 text-xl font-semibold">{money(total.balanceMinor, total.currency)}</p></div>)}</div>
      <div className="divide-y">{savingsAccounts.map((account) => <div key={account.id} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"><div className="min-w-0"><p className="truncate font-medium">{account.name}</p><p className="mt-1 text-xs text-muted-foreground">{account.currency}</p></div><p className="whitespace-nowrap font-semibold">{money(account.balanceMinor, account.currency || currency)}</p></div>)}</div>
    </CardContent></Card> : <Card className="mb-5"><CardContent className="p-5"><Empty icon={PiggyBank} title="No savings accounts" /></CardContent></Card>}
    <SectionHeading title="Monthly savings" action={<Button onClick={() => { setEditingMonthlyPlan(null); setMonthlyPlanOpen(true); }}><Plus className="h-4 w-4" /> Target</Button>} />
    {monthlyPlans.length ? <>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Target" value={money(monthlyTarget, currency)} note={monthLabel(month, true)} icon={CalendarDays} />
        <StatCard label="Account movement" value={money(monthlyActual, currency)} note={monthlyTarget > 0 ? `${Math.min(100, Math.round(monthlyActual / monthlyTarget * 100))}% of target` : "No active target"} icon={PiggyBank} />
        <StatCard label="Remaining" value={money(monthlyRemaining, currency)} note={monthlyActual >= monthlyTarget && monthlyTarget > 0 ? "Target met" : monthLabel(month, true)} icon={Target} />
        <StatCard label="Streak" value={`${bestStreak} ${bestStreak === 1 ? "month" : "months"}`} note="Consecutive targets met" icon={Sparkles} />
      </div>
      <div className="mb-8 grid gap-4 xl:grid-cols-2">{monthlyPlans.map((plan) => <Card key={plan.id} className="overflow-hidden"><div className="h-1.5" style={{ backgroundColor: plan.color }} /><CardContent className="p-5"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{plan.name}</p><p className="mt-1 text-sm text-muted-foreground">{money(plan.monthlyTargetMinor, currency)} every month from {monthLabel(plan.startMonth, true)}</p></div><div className="flex items-center gap-1"><Badge tone={plan.complete ? "good" : plan.activeForMonth ? "warn" : "neutral"}>{plan.complete ? "met" : plan.activeForMonth ? "active" : "not active"}</Badge><Button type="button" variant="ghost" size="icon" className="h-9 min-h-9 w-9" onClick={() => { setEditingMonthlyPlan(plan); setMonthlyPlanOpen(true); }} aria-label={`Edit ${plan.name}`}><Pencil className="h-4 w-4" /></Button></div></div><div className="mt-5 flex items-end justify-between"><div><p className="text-2xl font-semibold">{money(plan.actualMinor, currency)}</p><p className="text-xs text-muted-foreground">net savings-account movement</p></div><p className="text-sm font-semibold text-primary">{plan.percentage}%</p></div><Progress value={plan.percentage} className="mt-3" /><div className="mt-4 rounded-xl bg-muted/55 p-3"><p className="text-xs text-muted-foreground">Still needed</p><p className="mt-1 font-semibold">{money(plan.remainingMinor, currency)}</p></div>{plan.note && <p className="mt-3 text-sm text-muted-foreground">{plan.note}</p>}</CardContent></Card>)}</div>
    </> : <Card className="mb-8"><CardContent className="flex items-center justify-between gap-4 p-5"><p className="font-semibold">No monthly target</p><Button onClick={() => { setEditingMonthlyPlan(null); setMonthlyPlanOpen(true); }}>Set target</Button></CardContent></Card>}
    <SectionHeading title="Savings objectives" action={<Button variant="outline" onClick={() => { setEditingGoal(null); setGoalOpen(true); }}><Plus className="h-4 w-4" /> New objective</Button>} />
    <div className="mb-5 grid grid-cols-2 gap-3"><StatCard label="Objective total" value={money(targetMinor, currency)} note={`${goals.length} active ${goals.length === 1 ? "objective" : "objectives"}`} icon={Target} /><StatCard label="Current savings" value={money(position.totalBalanceMinor, currency)} note="Not allocated to objectives" icon={PiggyBank} /></div>
    {goals.length ? <div className="grid gap-4 xl:grid-cols-2">{goals.map((goal) => {
      const required = objectiveMonthlyRequirement(goal);
      return <Card key={goal.id} className="overflow-hidden"><div className="h-1.5" style={{ backgroundColor: goal.color }} /><CardHeader className="pb-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><CardTitle className="truncate">{goal.name}</CardTitle><CardDescription>{goal.targetDate ? `Target ${shortDate(goal.targetDate)} ${String(goal.targetDate).slice(0, 4)}` : "No deadline"}</CardDescription></div><Button type="button" variant="ghost" size="icon" className="h-9 min-h-9 w-9" onClick={() => { setEditingGoal(goal); setGoalOpen(true); }} aria-label={`Edit ${goal.name}`}><Pencil className="h-4 w-4" /></Button></div></CardHeader><CardContent>
        <p className="text-2xl font-semibold tracking-tight">{money(goal.targetMinor, currency)}</p>
        <div className="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-muted/55 p-3 text-sm"><div><p className="text-xs text-muted-foreground">Needed monthly</p><p className="mt-1 font-semibold">{required ? money(required, currency) : "Set a date"}</p></div><div><p className="text-xs text-muted-foreground">{forecast.capacityComplete === false ? "Maximum available" : "Available monthly"}</p><p className="mt-1 font-semibold">{money(forecast.availableToSaveMinor, currency)}</p>{missingCommitmentNames.length > 0 && <p className="mt-1 text-xs text-amber-700">Details missing</p>}</div></div>
        {goal.note && <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{goal.note}</p>}
      </CardContent></Card>;
    })}</div> : <Empty icon={PiggyBank} title="No savings objectives" />}
    <SavingsGoalDialog open={goalOpen} onOpenChange={(open) => { setGoalOpen(open); if (!open) setEditingGoal(null); }} goal={editingGoal} currency={currency} onSaved={onSaved} />
    <MonthlySavingsPlanDialog open={monthlyPlanOpen} onOpenChange={(open) => { setMonthlyPlanOpen(open); if (!open) setEditingMonthlyPlan(null); }} plan={editingMonthlyPlan} currency={currency} month={month} onSaved={onSaved} />
  </>;
}

function SavingsGoalDialog({ open, onOpenChange, goal, currency, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; goal: RecordValue | null; currency: string; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<RecordValue>({ name: "", target: "", targetDate: "", note: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setForm(goal ? { name: goal.name, target: decimalFromMinor(goal.targetMinor), targetDate: goal.targetDate || "", note: goal.note || "" } : { name: "", target: "", targetDate: "", note: "" });
    setError("");
  }, [open, goal]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      await api(goal ? `/savings-goals/${goal.id}` : "/savings-goals", { method: goal ? "PATCH" : "POST", headers: goal ? undefined : { "Idempotency-Key": idempotencyKey("ui-savings-goal") }, body: JSON.stringify({ name: form.name, targetMinor: Math.round(Number(form.target) * 100), openingSavedMinor: goal ? undefined : 0, targetDate: form.targetDate || null, note: form.note || null, source: "ui" }) });
      onOpenChange(false); setForm({ name: "", target: "", targetDate: "", note: "" }); await onSaved();
    } catch (value) { setError(value instanceof Error ? value.message : `Could not ${goal ? "update" : "create"} objective`); }
    finally { setSaving(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>{goal ? "Edit savings objective" : "New savings objective"}</DialogTitle><DialogDescription>Objective details.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={save}>{error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}<div><Label htmlFor="savings-name">Objective</Label><Input id="savings-name" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Emergency fund" /></div><div><Label htmlFor="savings-target">Target ({currency})</Label><Input id="savings-target" required min="0.01" step="0.01" inputMode="decimal" value={form.target} onChange={(event) => setForm({ ...form, target: event.target.value })} /></div><div><Label htmlFor="savings-date">Target date</Label><DatePicker id="savings-date" value={form.targetDate} onChange={(targetDate) => setForm({ ...form, targetDate })} placeholder="Choose target date" /></div><div><Label htmlFor="savings-note">Note</Label><Input id="savings-note" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="Optional" /></div><Button type="submit" className="w-full" disabled={saving}>{saving && <LoaderCircle className="h-4 w-4 animate-spin" />} {goal ? "Save changes" : "Create objective"}</Button></form></DialogContent></Dialog>;
}

function MonthlySavingsPlanDialog({ open, onOpenChange, plan, currency, month, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; plan: RecordValue | null; currency: string; month: string; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<RecordValue>({ name: "Monthly savings", target: "", startMonth: month, endMonth: "", note: "" });
  const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  useEffect(() => { if (open) { setForm(plan ? { name: plan.name, target: decimalFromMinor(plan.monthlyTargetMinor), startMonth: plan.startMonth, endMonth: plan.endMonth || "", note: plan.note || "" } : { name: "Monthly savings", target: "", startMonth: month, endMonth: "", note: "" }); setError(""); } }, [open, month, plan]);
  async function save(event: React.FormEvent) { event.preventDefault(); setSaving(true); setError(""); try { await api(plan ? `/monthly-savings-plans/${plan.id}` : "/monthly-savings-plans", { method: plan ? "PATCH" : "POST", headers: plan ? undefined : { "Idempotency-Key": idempotencyKey("ui-monthly-savings") }, body: JSON.stringify({ name: form.name, monthlyTargetMinor: Math.round(Number(form.target) * 100), startMonth: form.startMonth, endMonth: form.endMonth || null, note: form.note || null, source: "ui" }) }); onOpenChange(false); setForm({ name: "Monthly savings", target: "", startMonth: month, endMonth: "", note: "" }); await onSaved(); } catch (value) { setError(value instanceof Error ? value.message : `Could not ${plan ? "update" : "create"} monthly target`); } finally { setSaving(false); } }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>{plan ? "Edit monthly savings target" : "Monthly savings target"}</DialogTitle><DialogDescription>Target details.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={save}>{error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}<div><Label htmlFor="monthly-plan-name">Name</Label><Input id="monthly-plan-name" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></div><div><Label htmlFor="monthly-plan-target">Save each month ({currency})</Label><Input id="monthly-plan-target" required min="0.01" step="0.01" inputMode="decimal" value={form.target} onChange={(event) => setForm({ ...form, target: event.target.value })} /></div><div className="grid grid-cols-2 gap-3"><div><Label htmlFor="monthly-plan-start">Start month</Label><MonthPicker id="monthly-plan-start" value={form.startMonth} onChange={(startMonth) => setForm({ ...form, startMonth })} required /></div><div><Label htmlFor="monthly-plan-end">End month</Label><MonthPicker id="monthly-plan-end" value={form.endMonth} min={form.startMonth} onChange={(endMonth) => setForm({ ...form, endMonth })} placeholder="No end month" /></div></div><div><Label htmlFor="monthly-plan-note">Note</Label><Input id="monthly-plan-note" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="Optional" /></div><Button type="submit" className="w-full" disabled={saving}>{saving && <LoaderCircle className="h-4 w-4 animate-spin" />} {plan ? "Save changes" : "Set monthly target"}</Button></form></DialogContent></Dialog>;
}

function wealthTypeLabel(value: string) { return value.split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "); }

function wealthFlowLabel(value: string) { return ({ contribution: "Contribution", withdrawal: "Withdrawal", income: "Income", fee: "Fee" } as Record<string, string>)[value] || wealthTypeLabel(value); }

const wealthCurrencies = ["AED", "INR", "USD"];

function Wealth({ data, currency, onSaved, onRefresh }: { data: RecordValue; currency: string; onSaved: () => Promise<void>; onRefresh: () => Promise<void> }) {
  const wealth = data.wealth as RecordValue; const assets = wealth.assets as RecordValue[]; const drafts = wealth.pendingDrafts as RecordValue[];
  const totals = wealth.totalsByCurrency as RecordValue[];
  const summary = totals.length === 1 ? totals[0] : wealth;
  const summaryCurrency = totals.length === 1 ? String(totals[0].currency) : currency;
  const [assetOpen, setAssetOpen] = useState(false); const [editingAsset, setEditingAsset] = useState<RecordValue | null>(null); const [snapshotAsset, setSnapshotAsset] = useState<RecordValue | null>(null); const [cashFlowAsset, setCashFlowAsset] = useState<RecordValue | null>(null); const [reviewDraft, setReviewDraft] = useState<RecordValue | null>(null);
  return <>
    <SectionHeading title="Wealth" action={<div className="flex items-center gap-2"><RefreshButton onRefresh={onRefresh} /><Button onClick={() => { setEditingAsset(null); setAssetOpen(true); }}><Plus className="h-4 w-4" /> Add holding</Button></div>} />
    <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard label={`Current value (${summaryCurrency})`} value={money(summary.currentValueMinor, summaryCurrency)} note={totals.length > 1 ? `${Number(wealth.excludedCurrencyCount)} holdings outside ${currency}` : undefined} icon={ChartNoAxesCombined} />
      <StatCard label={`Invested (${summaryCurrency})`} value={money(summary.investedMinor, summaryCurrency)} icon={WalletCards} />
      <StatCard label={`Gain / loss (${summaryCurrency})`} value={`${Number(summary.gainLossMinor) >= 0 ? "+" : "−"}${money(Math.abs(Number(summary.gainLossMinor)), summaryCurrency)}`} icon={Number(summary.gainLossMinor) >= 0 ? ArrowUpRight : TrendingDown} tone={Number(summary.gainLossMinor) < 0 ? "warm" : "default"} />
      <StatCard label="Holdings" value={String(wealth.assetCount)} icon={Landmark} />
    </div>
    {totals.length > 1 && <Card className="mb-5"><CardHeader><CardTitle>Totals by currency</CardTitle></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{totals.map((total) => <div key={total.currency} className="rounded-xl bg-muted/55 p-4"><div className="flex items-center justify-between gap-3"><p className="text-sm font-semibold">{total.currency}</p><Badge>{total.currency}</Badge></div><p className="mt-2 text-xl font-semibold">{money(total.currentValueMinor, total.currency)}</p><p className="mt-1 text-xs text-muted-foreground">Invested {money(total.investedMinor, total.currency)}</p></div>)}</CardContent></Card>}
    {drafts.length > 0 && <Card className="mb-5"><CardHeader><CardTitle>Pending imports</CardTitle></CardHeader><CardContent className="space-y-3">{drafts.map((draft) => <div key={draft.id} className="flex items-center gap-3 rounded-xl bg-muted/55 p-3"><span className="rounded-xl bg-secondary p-2.5 text-primary"><FileUp className="h-5 w-5" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{draft.sourceFilename}</p><p className="text-xs text-muted-foreground">{draft.proposals.length} {draft.proposals.length === 1 ? "update" : "updates"}</p></div><Button type="button" variant="outline" size="sm" onClick={() => setReviewDraft(draft)}>Review</Button></div>)}</CardContent></Card>}
    {assets.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{assets.map((asset) => <Card key={asset.id}><CardContent className="p-5">
      <div className="flex items-start justify-between gap-3"><span className="rounded-xl bg-secondary p-2.5 text-primary"><ChartNoAxesCombined className="h-5 w-5" /></span><div className="flex flex-wrap items-center justify-end gap-1"><Badge>{asset.currency || currency}</Badge><Badge>{wealthTypeLabel(asset.type)}</Badge><Button type="button" variant="ghost" size="icon" className="h-9 min-h-9 w-9" onClick={() => { setEditingAsset(asset); setAssetOpen(true); }} aria-label={`Edit ${asset.name}`}><Pencil className="h-4 w-4" /></Button></div></div>
      <h3 className="mt-4 font-semibold">{asset.name}</h3>{asset.institution && <p className="mt-1 text-sm text-muted-foreground">{asset.institution}</p>}
      <p className="mt-4 text-2xl font-semibold tracking-tight">{money(asset.currentValueMinor, asset.currency || currency)}</p><p className="mt-1 text-xs text-muted-foreground">{asset.asOfDate ? `as of ${shortDate(asset.asOfDate)}` : "Opening value"}</p>
      <div className="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-muted/55 p-3"><div><p className="text-xs text-muted-foreground">Invested</p><p className="mt-1 font-semibold">{money(asset.investedMinor, asset.currency || currency)}</p></div><div><p className="text-xs text-muted-foreground">Return</p><p className={cn("mt-1 font-semibold", Number(asset.gainLossMinor) >= 0 ? "text-emerald-700" : "text-amber-700")}>{Number(asset.gainLossMinor) >= 0 ? "+" : "−"}{money(Math.abs(Number(asset.gainLossMinor)), asset.currency || currency)} · {asset.returnPercentage}%</p></div></div>
      {asset.note && <p className="mt-3 text-sm text-muted-foreground">{asset.note}</p>}
      <div className="mt-4 grid grid-cols-2 gap-2"><Button variant="outline" size="sm" onClick={() => setCashFlowAsset(asset)}>Add activity</Button><Button variant="outline" size="sm" onClick={() => setSnapshotAsset(asset)}>Update value</Button></div>
      {(asset.cashFlows as RecordValue[]).length > 0 && <div className="mt-5 border-t pt-4"><p className="mb-2 text-xs font-medium uppercase tracking-[.12em] text-muted-foreground">Recent activity</p><div className="space-y-1">{(asset.cashFlows as RecordValue[]).slice(0, 3).map((flow) => {
        const positive = flow.kind === "contribution" || flow.kind === "income";
        return <div key={flow.id} className="flex min-w-0 items-center gap-3 py-2"><span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", positive ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700")}><CircleDollarSign className="h-4 w-4" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{flow.note || wealthFlowLabel(flow.kind)}</p><p className="text-xs text-muted-foreground">{shortDate(flow.date)} · {wealthFlowLabel(flow.kind)}</p></div><p className={cn("whitespace-nowrap text-sm font-semibold", positive ? "text-emerald-700" : "text-amber-700")}>{positive ? "+" : "−"}{money(flow.amountMinor, asset.currency || currency)}</p></div>;
      })}</div></div>}
    </CardContent></Card>)}</div> : <Empty icon={ChartNoAxesCombined} title="No holdings" message="Add your first holding." />}
    <WealthAssetDialog open={assetOpen} onOpenChange={(open) => { setAssetOpen(open); if (!open) setEditingAsset(null); }} asset={editingAsset} currency={currency} onSaved={onSaved} />
    <WealthSnapshotDialog asset={snapshotAsset} onOpenChange={(open) => !open && setSnapshotAsset(null)} onSaved={onSaved} />
    <WealthCashFlowDialog asset={cashFlowAsset} onOpenChange={(open) => !open && setCashFlowAsset(null)} onSaved={onSaved} />
    <WealthDraftDialog draft={reviewDraft} onOpenChange={(open) => !open && setReviewDraft(null)} onSaved={onSaved} />
  </>;
}

function WealthAssetDialog({ open, onOpenChange, asset, currency, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; asset: RecordValue | null; currency: string; onSaved: () => Promise<void> }) {
  const today = localToday(); const [form, setForm] = useState<RecordValue>({ name: "", type: "mutual_fund", currency, institution: "", invested: "", current: "", asOfDate: today, note: "" }); const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  useEffect(() => { if (open) { setForm(asset ? { name: asset.name, type: asset.type, currency: asset.currency || currency, institution: asset.institution || "", invested: "", current: "", asOfDate: today, note: asset.note || "" } : { name: "", type: "mutual_fund", currency, institution: "", invested: "", current: "", asOfDate: today, note: "" }); setError(""); } }, [open, asset, currency, today]);
  async function save(event: React.FormEvent) { event.preventDefault(); setSaving(true); setError(""); try { await api(asset ? `/wealth/assets/${asset.id}` : "/wealth/assets", { method: asset ? "PATCH" : "POST", headers: asset ? undefined : { "Idempotency-Key": idempotencyKey("ui-wealth-asset") }, body: JSON.stringify(asset ? { name: form.name, type: form.type, institution: form.institution || null, currency: form.currency, note: form.note || null, source: "ui" } : { name: form.name, type: form.type, institution: form.institution || null, currency: form.currency, openingInvestedMinor: Math.round(Number(form.invested || 0) * 100), investedValueMinor: Math.round(Number(form.invested || 0) * 100), currentValueMinor: Math.round(Number(form.current || form.invested || 0) * 100), asOfDate: form.asOfDate, note: form.note || null, source: "ui" }) }); onOpenChange(false); setForm({ name: "", type: "mutual_fund", currency, institution: "", invested: "", current: "", asOfDate: today, note: "" }); await onSaved(); } catch (value) { setError(value instanceof Error ? value.message : `Could not ${asset ? "update" : "add"} holding`); } finally { setSaving(false); } }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>{asset ? "Edit wealth holding" : "Add wealth holding"}</DialogTitle><DialogDescription>{asset ? "Update the holding details. Dated valuations and cash flows remain unchanged." : "Create a fund, deposit, savings account, or other investment. Future values become dated snapshots."}</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={save}>{error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}<div><Label htmlFor="wealth-name">Name</Label><Input id="wealth-name" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Emirates NBD Equity Fund" /></div><div className="grid grid-cols-2 gap-3"><div><Label htmlFor="wealth-type">Type</Label><Select id="wealth-type" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}><option value="mutual_fund">Mutual fund</option><option value="savings_account">Savings account</option><option value="fixed_deposit">Fixed deposit</option><option value="stock">Stock</option><option value="bond">Bond</option><option value="crypto">Crypto</option><option value="real_estate">Real estate</option><option value="other">Other</option></Select></div><div><Label htmlFor="wealth-currency">Currency</Label><Select id="wealth-currency" value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}>{wealthCurrencies.map((value) => <option key={value} value={value}>{value}</option>)}</Select></div></div><div><Label htmlFor="wealth-institution">Institution</Label><Input id="wealth-institution" value={form.institution} onChange={(event) => setForm({ ...form, institution: event.target.value })} /></div>{!asset && <><div className="grid grid-cols-2 gap-3"><div><Label htmlFor="wealth-invested">Invested ({form.currency})</Label><Input id="wealth-invested" required min="0" step="0.01" inputMode="decimal" value={form.invested} onChange={(event) => setForm({ ...form, invested: event.target.value })} /></div><div><Label htmlFor="wealth-current">Current value ({form.currency})</Label><Input id="wealth-current" min="0" step="0.01" inputMode="decimal" value={form.current} onChange={(event) => setForm({ ...form, current: event.target.value })} /></div></div><div><Label htmlFor="wealth-date">Value date</Label><DatePicker id="wealth-date" value={form.asOfDate} onChange={(asOfDate) => setForm({ ...form, asOfDate })} required /></div></>}<div><Label htmlFor="wealth-note">Note</Label><Input id="wealth-note" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></div><Button type="submit" className="w-full" disabled={saving}>{saving && <LoaderCircle className="h-4 w-4 animate-spin" />} {asset ? "Save changes" : "Add holding"}</Button></form></DialogContent></Dialog>;
}

function WealthSnapshotDialog({ asset, onOpenChange, onSaved }: { asset: RecordValue | null; onOpenChange: (open: boolean) => void; onSaved: () => Promise<void> }) {
  const today = localToday(); const [form, setForm] = useState<RecordValue>({ current: "", invested: "", asOfDate: today, note: "" }); const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  useEffect(() => { if (asset) { setForm({ current: decimalFromMinor(asset.currentValueMinor), invested: decimalFromMinor(asset.investedMinor), asOfDate: today, note: "" }); setError(""); } }, [asset, today]);
  async function save(event: React.FormEvent) { event.preventDefault(); if (!asset) return; setSaving(true); setError(""); try { await api(`/wealth/assets/${asset.id}/snapshots`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey("ui-wealth-value") }, body: JSON.stringify({ currentValueMinor: Math.round(Number(form.current) * 100), investedValueMinor: form.invested === "" ? undefined : Math.round(Number(form.invested) * 100), asOfDate: form.asOfDate, note: form.note || undefined, source: "ui" }) }); onOpenChange(false); await onSaved(); } catch (value) { setError(value instanceof Error ? value.message : "Could not update value"); } finally { setSaving(false); } }
  return <Dialog open={Boolean(asset)} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>Update {asset?.name}</DialogTitle><DialogDescription>Add a dated valuation in {asset?.currency}. Previous snapshots stay in the history.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={save}>{error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}<div className="grid grid-cols-2 gap-3"><div><Label htmlFor="snapshot-current">Current value ({asset?.currency})</Label><Input id="snapshot-current" required min="0" step="0.01" inputMode="decimal" value={form.current} onChange={(event) => setForm({ ...form, current: event.target.value })} /></div><div><Label htmlFor="snapshot-invested">Invested value ({asset?.currency})</Label><Input id="snapshot-invested" min="0" step="0.01" inputMode="decimal" value={form.invested} onChange={(event) => setForm({ ...form, invested: event.target.value })} /></div></div><div><Label htmlFor="snapshot-date">As of</Label><DatePicker id="snapshot-date" value={form.asOfDate} onChange={(asOfDate) => setForm({ ...form, asOfDate })} required /></div><div><Label htmlFor="snapshot-note">Note</Label><Input id="snapshot-note" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></div><Button type="submit" className="w-full" disabled={saving}>{saving && <LoaderCircle className="h-4 w-4 animate-spin" />} Save valuation</Button></form></DialogContent></Dialog>;
}

function WealthCashFlowDialog({ asset, onOpenChange, onSaved }: { asset: RecordValue | null; onOpenChange: (open: boolean) => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<RecordValue>({ kind: "contribution", amount: "", date: localToday(), note: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (asset) { setForm({ kind: "contribution", amount: "", date: localToday(), note: "" }); setError(""); } }, [asset]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!asset) return;
    const amountMinor = Math.round(Number(form.amount) * 100);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) { setError("Enter an amount greater than zero."); return; }
    setSaving(true); setError("");
    try {
      await api(`/wealth/assets/${asset.id}/cash-flows`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey("ui-wealth-activity") }, body: JSON.stringify({ kind: form.kind, amountMinor, date: form.date, note: form.note || undefined, source: "ui" }) });
      onOpenChange(false); await onSaved();
    } catch (value) { setError(value instanceof Error ? value.message : "Could not add activity"); }
    finally { setSaving(false); }
  }
  return <Dialog open={Boolean(asset)} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>Add activity to {asset?.name}</DialogTitle><DialogDescription>Investment activity.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={save}>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    <div><Label htmlFor="wealth-activity-kind">Type</Label><Select id="wealth-activity-kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}><option value="contribution">Contribution</option><option value="withdrawal">Withdrawal</option><option value="income">Income</option><option value="fee">Fee</option></Select></div>
    <div className="grid grid-cols-2 gap-3"><div><Label htmlFor="wealth-activity-amount">Amount ({asset?.currency})</Label><Input id="wealth-activity-amount" required min="0.01" step="0.01" inputMode="decimal" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></div><div><Label htmlFor="wealth-activity-date">Date</Label><DatePicker id="wealth-activity-date" value={form.date} onChange={(date) => setForm({ ...form, date })} required /></div></div>
    <div><Label htmlFor="wealth-activity-note">Note</Label><Input id="wealth-activity-note" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></div>
    <Button type="submit" className="w-full" disabled={saving}>{saving && <LoaderCircle className="h-4 w-4 animate-spin" />} Add activity</Button>
  </form></DialogContent></Dialog>;
}

function WealthDraftDialog({ draft, onOpenChange, onSaved }: { draft: RecordValue | null; onOpenChange: (open: boolean) => void; onSaved: () => Promise<void> }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (draft) setError(""); }, [draft]);
  async function finish(action: "apply" | "cancel") {
    if (!draft) return;
    setWorking(true); setError("");
    try {
      await api(`/wealth/import-drafts/${draft.id}${action === "apply" ? "/apply" : "?source=ui"}`, { method: action === "apply" ? "POST" : "DELETE", body: action === "apply" ? JSON.stringify({ source: "ui" }) : undefined });
      onOpenChange(false); await onSaved();
    } catch (value) { setError(value instanceof Error ? value.message : `Could not ${action} import`); }
    finally { setWorking(false); }
  }
  return <Dialog open={Boolean(draft)} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>Review import</DialogTitle><DialogDescription>Review extracted values before applying them.</DialogDescription></DialogHeader>
    {error && <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    <p className="mb-3 truncate text-sm font-medium">{draft?.sourceFilename}</p>
    <div className="space-y-2">{(draft?.proposals as RecordValue[] | undefined)?.map((proposal, index) => <div key={`${proposal.assetId || proposal.name}-${index}`} className="rounded-xl bg-muted/55 p-3"><div className="flex items-start justify-between gap-3"><p className="font-medium">{proposal.name}</p><Badge>{proposal.currency}</Badge></div><p className="mt-1 text-sm">{money(proposal.currentValueMinor, proposal.currency)}</p><p className="mt-1 text-xs text-muted-foreground">{shortDate(proposal.asOfDate)} · {wealthTypeLabel(proposal.type)}</p></div>)}</div>
    <div className="mt-5 grid grid-cols-2 gap-2"><Button type="button" variant="destructive" disabled={working} onClick={() => void finish("cancel")}>Cancel import</Button><Button type="button" disabled={working} onClick={() => void finish("apply")}>{working && <LoaderCircle className="h-4 w-4 animate-spin" />} Apply import</Button></div>
  </DialogContent></Dialog>;
}

function More({ data, currency, onAddAccount, onEditAccount, onSaved, onRefresh }: { data: RecordValue; currency: string; onAddAccount: () => void; onEditAccount: (account: RecordValue) => void; onSaved: () => Promise<void>; onRefresh: () => Promise<void> }) {
  const accounts = (data.accounts as RecordValue[]).filter((account) => account.type !== "personal_loan");
  const recurring = data.recurring as RecordValue[];
  const [editingRecurring, setEditingRecurring] = useState<RecordValue | null>(null);
  const [recurringOpen, setRecurringOpen] = useState(false);
  const [recordingId, setRecordingId] = useState("");
  const [recurringError, setRecurringError] = useState("");
  async function record(item: RecordValue) {
    setRecordingId(String(item.id)); setRecurringError("");
    try { await api(`/recurring-items/${item.id}/record`, { method: "POST" }); await onSaved(); }
    catch (value) { setRecurringError(value instanceof Error ? value.message : "Could not record the recurring item"); }
    finally { setRecordingId(""); }
  }
  return <>
    <SectionHeading title="More" action={<RefreshButton onRefresh={onRefresh} />} />
    <div className="grid gap-5 lg:grid-cols-2">
      <StatementImport accounts={accounts} onSaved={onSaved} />
      <Card className="min-w-0"><CardHeader className="flex-row items-center justify-between"><CardTitle>Accounts</CardTitle><Button variant="outline" size="sm" onClick={onAddAccount}><Plus className="h-4 w-4" /> Add</Button></CardHeader><CardContent className="space-y-1">{accounts.length ? accounts.map((account) => <div key={account.id} className="flex min-w-0 items-center gap-3 rounded-xl py-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-primary">{account.type === "credit_card" ? <CreditCard className="h-4.5 w-4.5" /> : <WalletCards className="h-4.5 w-4.5" />}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{account.name}</p><p className="text-xs capitalize text-muted-foreground">{String(account.type).replace("_", " ")}</p></div><p className="whitespace-nowrap text-sm font-semibold">{money(account.balanceMinor, account.currency || currency)}</p><Button type="button" variant="ghost" size="icon" className="h-9 min-h-9 w-9 shrink-0" onClick={() => onEditAccount(account)} aria-label={`Edit ${account.name}`}><Pencil className="h-4 w-4" /></Button></div>) : <Empty icon={WalletCards} title="No accounts" message="Add your first account." />}</CardContent></Card>
      <Card className="min-w-0"><CardHeader className="flex-row items-center justify-between"><CardTitle>Recurring</CardTitle><Button variant="outline" size="sm" onClick={() => { setEditingRecurring(null); setRecurringOpen(true); }}><Plus className="h-4 w-4" /> Add</Button></CardHeader><CardContent>{recurringError && <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{recurringError}</p>}{recurring.length ? <div className="space-y-1">{recurring.map((item) => <div key={item.id} className="flex min-w-0 items-center gap-2 rounded-xl py-3"><span className="shrink-0 rounded-xl bg-secondary p-2.5 text-primary"><CalendarDays className="h-4.5 w-4.5" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{item.name}</p><p className="truncate text-xs capitalize text-muted-foreground">{item.cadence} · next {shortDate(item.nextDate)}</p></div><Button type="button" variant="outline" size="sm" disabled={Boolean(recordingId)} onClick={() => void record(item)}>{recordingId === item.id && <LoaderCircle className="h-4 w-4 animate-spin" />} Record</Button><Button type="button" variant="ghost" size="icon" className="h-9 min-h-9 w-9 shrink-0" onClick={() => { setEditingRecurring(item); setRecurringOpen(true); }} aria-label={`Edit ${item.name}`}><Pencil className="h-4 w-4" /></Button></div>)}</div> : <Empty icon={CalendarDays} title="Nothing recurring" message="Add rent, salary, subscriptions, or payments." />}</CardContent></Card>
      <Card className="min-w-0"><CardHeader><CardTitle>Exports</CardTitle></CardHeader><CardContent className="space-y-3"><Button variant="outline" className="w-full min-w-0 justify-start" asChild><a href="/api/v1/exports/data.json"><Download className="h-4 w-4 shrink-0" /> <span className="truncate">Export all data as JSON</span></a></Button><Button variant="outline" className="w-full min-w-0 justify-start" asChild><a href="/api/v1/exports/transactions.csv"><Download className="h-4 w-4 shrink-0" /> <span className="truncate">Export transactions as CSV</span></a></Button></CardContent></Card>
    </div>
    <RecurringDialog open={recurringOpen} item={editingRecurring} accounts={accounts} categories={data.categories as RecordValue[]} onOpenChange={(open) => { setRecurringOpen(open); if (!open) setEditingRecurring(null); }} onSaved={onSaved} />
  </>;
}

function RecurringDialog({ open, item, accounts, categories, onOpenChange, onSaved }: { open: boolean; item: RecordValue | null; accounts: RecordValue[]; categories: RecordValue[]; onOpenChange: (open: boolean) => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<RecordValue>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const transaction = form.transaction || {};
  const needsDestination = transaction.type === "transfer" || transaction.type === "debt_payment";
  useEffect(() => {
    if (open) { setForm(item ? { name: item.name, cadence: item.cadence, intervalCount: String(item.intervalCount || 1), nextDate: item.nextDate, transaction: { ...item.transaction, amount: decimalFromMinor(item.transaction?.amountMinor) } } : { name: "", cadence: "monthly", intervalCount: "1", nextDate: localToday(), transaction: { type: "expense", amount: "", accountId: accounts[0]?.id || "", transferAccountId: "", categoryId: "", merchant: "", note: "" } }); setError(""); }
  }, [open, item, accounts]);
  function updateTransaction(patch: RecordValue) { setForm((value: RecordValue) => ({ ...value, transaction: { ...value.transaction, ...patch } })); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      await api(item ? `/recurring-items/${item.id}` : "/recurring-items", { method: item ? "PATCH" : "POST", headers: item ? undefined : { "Idempotency-Key": idempotencyKey("ui-recurring") }, body: JSON.stringify({ name: form.name, cadence: form.cadence, intervalCount: Number(form.intervalCount), nextDate: form.nextDate, transaction: { type: transaction.type, amountMinor: Math.round(Number(transaction.amount) * 100), accountId: transaction.accountId, transferAccountId: needsDestination ? transaction.transferAccountId : undefined, categoryId: transaction.type === "expense" ? transaction.categoryId || undefined : undefined, merchant: transaction.merchant || undefined, note: transaction.note || undefined }, source: "ui" }) });
      onOpenChange(false); await onSaved();
    } catch (value) { setError(value instanceof Error ? value.message : `Could not ${item ? "update" : "create"} recurring item`); }
    finally { setSaving(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>{item ? "Edit recurring item" : "Add recurring item"}</DialogTitle><DialogDescription>Recurring transaction details.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={save}>{error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}<div><Label htmlFor="recurring-name">Name</Label><Input id="recurring-name" required value={form.name || ""} onChange={(event) => setForm({ ...form, name: event.target.value })} /></div><div className="grid grid-cols-2 gap-3"><div><Label htmlFor="recurring-cadence">Cadence</Label><Select id="recurring-cadence" value={form.cadence || "monthly"} onChange={(event) => setForm({ ...form, cadence: event.target.value })}><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></Select></div><div><Label htmlFor="recurring-interval">Every</Label><Input id="recurring-interval" required min="1" max="120" step="1" inputMode="numeric" value={form.intervalCount || "1"} onChange={(event) => setForm({ ...form, intervalCount: event.target.value })} /></div></div><div><Label htmlFor="recurring-next-date">Next date</Label><DatePicker id="recurring-next-date" value={form.nextDate || ""} onChange={(nextDate) => setForm({ ...form, nextDate })} required /></div><div className="grid grid-cols-2 gap-3"><div><Label htmlFor="recurring-type">Transaction type</Label><Select id="recurring-type" value={transaction.type || "expense"} onChange={(event) => updateTransaction({ type: event.target.value })}><option value="expense">Expense</option><option value="income">Income</option><option value="transfer">Transfer</option><option value="debt_payment">Card or loan payment</option></Select></div><div><Label htmlFor="recurring-amount">Amount</Label><Input id="recurring-amount" required min="0.01" step="0.01" inputMode="decimal" value={transaction.amount || ""} onChange={(event) => updateTransaction({ amount: event.target.value })} /></div></div><div><Label htmlFor="recurring-account">{needsDestination ? "From account" : "Account"}</Label><Select id="recurring-account" required value={transaction.accountId || ""} onChange={(event) => updateTransaction({ accountId: event.target.value })}><option value="">Choose account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</Select></div>{needsDestination && <div><Label htmlFor="recurring-destination">To account</Label><Select id="recurring-destination" required value={transaction.transferAccountId || ""} onChange={(event) => updateTransaction({ transferAccountId: event.target.value })}><option value="">Choose destination</option>{accounts.filter((account) => account.id !== transaction.accountId).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</Select></div>}{transaction.type === "expense" && <div><Label htmlFor="recurring-category">Category</Label><Select id="recurring-category" value={transaction.categoryId || ""} onChange={(event) => updateTransaction({ categoryId: event.target.value })}><option value="">Uncategorized</option>{categories.filter((category) => category.kind === "expense").map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</Select></div>}<div><Label htmlFor="recurring-merchant">Merchant or description</Label><Input id="recurring-merchant" value={transaction.merchant || ""} onChange={(event) => updateTransaction({ merchant: event.target.value })} /></div><div><Label htmlFor="recurring-note">Note</Label><Input id="recurring-note" value={transaction.note || ""} onChange={(event) => updateTransaction({ note: event.target.value })} /></div><Button type="submit" className="w-full" disabled={saving || !accounts.length}>{saving && <LoaderCircle className="h-4 w-4 animate-spin" />} {item ? "Save changes" : "Add recurring item"}</Button></form></DialogContent></Dialog>;
}

function StatementImport({ accounts, onSaved }: { accounts: RecordValue[]; onSaved: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [preview, setPreview] = useState<RecordValue | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedAccount = accounts.find((account) => account.id === accountId);
  const statementCurrency = String(selectedAccount?.currency || "AED");
  async function upload() {
    if (!file || !accountId) return;
    setWorking(true); setError(""); setPreview(null);
    try {
      const form = new FormData(); form.append("file", file); form.append("accountId", accountId);
      setPreview(await api("/imports/preview", { method: "POST", body: form }));
    } catch (value) { setError(value instanceof Error ? value.message : "Could not preview statement"); }
    finally { setWorking(false); }
  }
  async function apply() {
    if (!preview) return;
    setWorking(true); setError("");
    try { setPreview(await api(`/imports/${preview.id}/apply`, { method: "POST", headers: { "Idempotency-Key": `ui-import:${preview.id}` } })); await onSaved(); }
    catch (value) { setError(value instanceof Error ? value.message : "Could not import statement"); }
    finally { setWorking(false); }
  }
  return <Card className="min-w-0"><CardHeader><CardTitle className="flex items-center gap-2"><FileUp className="h-5 w-5 text-primary" /> Statement import</CardTitle></CardHeader><CardContent>
    {error && <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    <div className="space-y-3">
      <div><Label htmlFor="statement-account">Account</Label><Select id="statement-account" value={accountId} onChange={(event) => { setAccountId(event.target.value); setPreview(null); }}><option value="">Choose account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</Select></div>
      <Input ref={fileInputRef} type="file" className="sr-only w-px" accept=".csv,.xlsx,.pdf" aria-hidden="true" tabIndex={-1} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setError(""); }} />
      <Button type="button" variant="outline" className="min-h-24 min-w-0 w-full flex-col whitespace-normal text-center leading-tight" onClick={() => fileInputRef.current?.click()}><Upload className="h-5 w-5 shrink-0" /><span className="max-w-full break-words">{file ? file.name : "Choose CSV, XLSX, or text PDF"}</span></Button>
      <Button className="w-full" disabled={!file || !accountId || working} onClick={() => void upload()}>{working && <LoaderCircle className="h-4 w-4 animate-spin" />} Preview statement</Button>
    </div>
    {preview && <div className="mt-4 rounded-xl border bg-white p-4"><div className="flex items-center justify-between"><p className="font-semibold">{preview.status === "applied" ? "Imported" : "Ready to review"}</p><Badge tone={preview.invalidCount ? "warn" : "good"}>{preview.rowCount} rows</Badge></div><div className="mt-3 grid grid-cols-2 gap-3 text-sm"><div><p className="text-xs text-muted-foreground">Money out</p><p className="font-medium">{money(preview.totalOutMinor, statementCurrency)}</p></div><div><p className="text-xs text-muted-foreground">Money in</p><p className="font-medium">{money(preview.totalInMinor, statementCurrency)}</p></div><div><p className="text-xs text-muted-foreground">Duplicates</p><p className="font-medium">{preview.duplicateCount}</p></div><div><p className="text-xs text-muted-foreground">Invalid</p><p className="font-medium">{preview.invalidCount}</p></div></div>{preview.status === "preview" && <Button className="mt-4 w-full" onClick={() => void apply()} disabled={working || preview.invalidCount > 0}>Confirm and import</Button>}{preview.invalidCount > 0 && <p className="mt-3 text-sm text-amber-800">Fix invalid rows before importing.</p>}</div>}
  </CardContent></Card>;
}

function TransactionDialog({ open, onOpenChange, transaction, data, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; transaction: RecordValue | null; data: RecordValue | null; onSaved: () => Promise<void> }) {
  const today = localToday(); const [form, setForm] = useState<RecordValue>({ type: "expense", date: today, amount: "", accountId: "", transferAccountId: "", categoryId: "", merchant: "", note: "", interest: "", fee: "", coverageMode: "one_off", coverageStartMonth: "", coverageEndMonth: "" }); const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const assign = (value: RecordValue) => setForm({ type: value.type || "expense", date: value.date || today, amount: decimalFromMinor(value.amountMinor), accountId: value.accountId || data?.accounts?.[0]?.id || "", transferAccountId: value.transferAccountId || "", categoryId: value.categoryId || "", merchant: value.merchant || "", note: value.note || "", interest: decimalFromMinor(value.splits?.find((split: RecordValue) => split.component === "interest")?.amountMinor, true), fee: decimalFromMinor(value.splits?.find((split: RecordValue) => split.component === "fee")?.amountMinor, true), coverageMode: value.coverageStartMonth ? "covered" : "one_off", coverageStartMonth: value.coverageStartMonth || "", coverageEndMonth: value.coverageEndMonth || "" });
    setError("");
    if (!transaction) { assign({}); return; }
    assign(transaction);
    let active = true;
    void api<RecordValue>(`/transactions/${transaction.id}`).then((value) => { if (active) assign(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [open, transaction, data, today]);
  const needsDestination = form.type === "transfer" || form.type === "debt_payment";
  useEffect(() => { if (form.transferAccountId) setError(""); }, [form.transferAccountId]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const amountMinor = Math.round(Number(form.amount) * 100);
    const interestMinor = Math.round(Number(form.interest || 0) * 100);
    const feeMinor = Math.round(Number(form.fee || 0) * 100);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) { setError("Enter an amount greater than zero."); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(form.date))) { setError("Choose a transaction date."); return; }
    if (!Number.isFinite(interestMinor) || interestMinor < 0 || !Number.isFinite(feeMinor) || feeMinor < 0) { setError("Interest and fees cannot be negative."); return; }
    if (!form.accountId) { setError("Choose the account the payment came from."); return; }
    if (needsDestination && !form.transferAccountId) { setError(form.type === "debt_payment" ? "Choose the debt account receiving this payment." : "Choose the destination account."); return; }
    if (needsDestination && form.accountId === form.transferAccountId) { setError("Choose two different accounts."); return; }
    if (form.type === "debt_payment" && interestMinor + feeMinor > amountMinor) { setError("Interest and fees cannot exceed the payment amount."); return; }
    if (form.type === "expense" && form.coverageMode === "covered" && (!form.coverageStartMonth || !form.coverageEndMonth || form.coverageEndMonth < form.coverageStartMonth)) { setError("Choose a valid coverage period."); return; }
    setSaving(true);
    try {
      await api(transaction ? `/transactions/${transaction.id}` : "/transactions", {
        method: transaction ? "PATCH" : "POST",
        body: JSON.stringify({
          type: form.type,
          date: form.date,
          amountMinor,
          accountId: form.accountId,
          transferAccountId: needsDestination ? form.transferAccountId || null : null,
          categoryId: form.type === "expense" || form.type === "debt_payment" ? form.categoryId || null : null,
          merchant: form.merchant || null,
          note: form.note || null,
          coverageStartMonth: form.type === "expense" && form.coverageMode === "covered" ? form.coverageStartMonth : null,
          coverageEndMonth: form.type === "expense" && form.coverageMode === "covered" ? form.coverageEndMonth : null,
          principalMinor: form.type === "debt_payment" ? amountMinor - interestMinor - feeMinor : undefined,
          interestMinor: form.type === "debt_payment" ? interestMinor : undefined,
          feeMinor: form.type === "debt_payment" ? feeMinor : undefined,
          source: "ui"
        }),
        headers: transaction ? undefined : { "Idempotency-Key": idempotencyKey("ui") }
      });
      onOpenChange(false);
      await onSaved();
    } catch (value) { setError(value instanceof Error ? value.message : "Could not save transaction"); }
    finally { setSaving(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>{transaction ? "Edit transaction" : "Add transaction"}</DialogTitle><DialogDescription>Transaction details.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={save}>{error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}<div><Label htmlFor="transaction-type">Type</Label><Select id="transaction-type" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value, coverageMode: event.target.value === "expense" ? form.coverageMode : "one_off" })}><option value="expense">Expense</option><option value="income">Income</option><option value="transfer">Transfer</option><option value="debt_payment">Card or loan payment</option></Select></div><div className="grid grid-cols-2 gap-3"><div><Label htmlFor="amount">Amount</Label><Input id="amount" required min="0.01" step="0.01" inputMode="decimal" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></div><div><Label htmlFor="transaction-date">Date</Label><DatePicker id="transaction-date" value={form.date} onChange={(date) => setForm({ ...form, date })} required /></div></div><div><Label htmlFor="from-account">{needsDestination ? "From account" : "Account"}</Label><Select id="from-account" required value={form.accountId} onChange={(event) => setForm({ ...form, accountId: event.target.value })}><option value="">Choose account</option>{data?.accounts?.map((account: RecordValue) => <option key={account.id} value={account.id}>{account.name}</option>)}</Select></div>{needsDestination && <div><Label htmlFor="to-account">To account</Label><Select id="to-account" required value={form.transferAccountId} onChange={(event) => setForm({ ...form, transferAccountId: event.target.value })}><option value="">Choose destination</option>{data?.accounts?.filter((account: RecordValue) => account.id !== form.accountId).map((account: RecordValue) => <option key={account.id} value={account.id}>{account.name}</option>)}</Select></div>}{(form.type === "expense" || form.type === "debt_payment") && <div><Label htmlFor="category">{form.type === "debt_payment" ? "Interest & fees category" : "Category"}</Label><Select id="category" value={form.categoryId} onChange={(event) => setForm({ ...form, categoryId: event.target.value })}><option value="">Uncategorized</option>{data?.categories?.filter((category: RecordValue) => category.kind === "expense").map((category: RecordValue) => <option key={category.id} value={category.id}>{category.name}</option>)}</Select></div>}{form.type === "expense" && <><div><Label htmlFor="coverage-mode">Payment timing</Label><Select id="coverage-mode" value={form.coverageMode} onChange={(event) => setForm({ ...form, coverageMode: event.target.value })}><option value="one_off">One-off</option><option value="covered">Covers several months</option></Select></div>{form.coverageMode === "covered" && <div className="grid grid-cols-2 gap-3"><div><Label htmlFor="coverage-start">Covers from</Label><MonthPicker id="coverage-start" value={form.coverageStartMonth} onChange={(coverageStartMonth) => setForm({ ...form, coverageStartMonth })} required /></div><div><Label htmlFor="coverage-end">Covers through</Label><MonthPicker id="coverage-end" value={form.coverageEndMonth} min={form.coverageStartMonth} onChange={(coverageEndMonth) => setForm({ ...form, coverageEndMonth })} required /></div></div>}</>}{form.type === "debt_payment" && <div className="grid grid-cols-2 gap-3"><div><Label htmlFor="interest">Interest</Label><Input id="interest" min="0" step="0.01" inputMode="decimal" value={form.interest} onChange={(event) => setForm({ ...form, interest: event.target.value })} /></div><div><Label htmlFor="fee">Fees</Label><Input id="fee" min="0" step="0.01" inputMode="decimal" value={form.fee} onChange={(event) => setForm({ ...form, fee: event.target.value })} /></div></div>}<div><Label htmlFor="merchant">Merchant or description</Label><Input id="merchant" value={form.merchant} onChange={(event) => setForm({ ...form, merchant: event.target.value })} placeholder="e.g. Carrefour" /></div><div><Label htmlFor="note">Note</Label><Input id="note" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></div><Button type="submit" className="w-full" disabled={saving || !data?.accounts?.length}>{saving && <LoaderCircle className="h-4 w-4 animate-spin" />} {transaction ? "Save changes" : "Save transaction"}</Button>{!data?.accounts?.length && <p className="text-center text-sm text-amber-700">Add an account first.</p>}</form></DialogContent></Dialog>;
}

function AccountDialog({ open, onOpenChange, account, defaultType, currency, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; account: RecordValue | null; defaultType: string; currency: string; onSaved: () => Promise<void> }) {
  const blank = { name: "", type: defaultType, purpose: "spending", institution: "", prepaymentAllowed: "no", openingBalance: "", apr: "", limit: "", installment: "", originalPrincipal: "", remainingMonths: "", statementDay: "", dueDay: "", lastStatementDate: "", lastStatementBalance: "", nextDueDate: "" };
  const [form, setForm] = useState<RecordValue>(blank);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const card = form.type === "credit_card";
  const loan = form.type === "personal_loan";
  const liability = card || loan;
  useEffect(() => {
    if (!open) return;
    setForm(account ? {
      name: account.name, type: account.type, purpose: account.purpose || "spending", institution: account.institution || "", prepaymentAllowed: account.prepaymentAllowed ? "yes" : "no", openingBalance: "",
      apr: account.aprBps ? (Number(account.aprBps) / 100).toFixed(2) : "", limit: decimalFromMinor(account.creditLimitMinor, true),
      installment: decimalFromMinor(account.installmentMinor, true),
      originalPrincipal: decimalFromMinor(account.originalPrincipalMinor, true), remainingMonths: String(account.remainingTermMonths || ""),
      statementDay: String(account.statementDay || ""), dueDay: String(account.dueDay || ""), lastStatementDate: account.lastStatementDate || "", lastStatementBalance: decimalFromMinor(account.lastStatementBalanceMinor), nextDueDate: account.nextDueDate || ""
    } : { ...blank, type: defaultType });
    setError("");
  }, [open, account, defaultType]);
  const amount = (value: unknown) => value === "" ? null : Math.round(Number(value) * 100);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!String(form.name).trim()) { setError("Enter a name."); return; }
    const numericValues = [form.openingBalance, form.apr, form.limit, form.lastStatementBalance, form.installment, form.originalPrincipal, form.remainingMonths, form.statementDay, form.dueDay].filter((value) => value !== "");
    if (numericValues.some((value) => !Number.isFinite(Number(value)) || Number(value) < 0)) { setError("Check the numeric values."); return; }
    setSaving(true); setError("");
    try {
      const body = {
        name: String(form.name).trim(), type: form.type, currency: account?.currency || currency,
        purpose: form.type === "bank" || form.type === "cash" ? form.purpose : "spending",
        institution: liability ? String(form.institution || "").trim() || null : undefined,
        prepaymentAllowed: loan ? form.prepaymentAllowed === "yes" : undefined,
        openingBalanceMinor: account ? undefined : amount(form.openingBalance) ?? 0,
        aprBps: loan ? form.apr === "" ? null : Math.round(Number(form.apr) * 100) : undefined,
        creditLimitMinor: card ? amount(form.limit) : undefined,
        statementDay: card ? form.statementDay === "" ? null : Number(form.statementDay) : undefined,
        dueDay: card ? form.dueDay === "" ? null : Number(form.dueDay) : undefined,
        lastStatementDate: card ? form.lastStatementDate || null : undefined,
        lastStatementBalanceMinor: card ? amount(form.lastStatementBalance) : undefined,
        installmentMinor: loan ? amount(form.installment) : undefined,
        originalPrincipalMinor: loan ? amount(form.originalPrincipal) : undefined,
        remainingTermMonths: loan ? form.remainingMonths === "" ? null : Number(form.remainingMonths) : undefined,
        nextDueDate: liability ? form.nextDueDate || null : undefined,
        source: "ui"
      };
      const endpoint = account ? `${card ? "/cards" : loan ? "/debts" : "/accounts"}/${account.id}` : "/accounts";
      await api(endpoint, { method: account ? "PATCH" : "POST", headers: account ? undefined : { "Idempotency-Key": idempotencyKey("ui-account") }, body: JSON.stringify(body) });
      onOpenChange(false); await onSaved();
    } catch (value) { setError(value instanceof Error ? value.message : `Could not ${account ? "update" : "add"} ${card ? "card" : loan ? "loan" : "account"}`); }
    finally { setSaving(false); }
  }
  const title = account ? `Edit ${card ? "card" : loan ? "loan" : "account"}` : `Add ${card ? "card" : loan ? "loan" : "account"}`;
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>Account details.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={save}>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    <div><Label htmlFor="account-name-v2">Name</Label><Input id="account-name-v2" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></div>
    <div><Label htmlFor="account-type-v2">Type</Label><Select id="account-type-v2" disabled={Boolean(account)} value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}><option value="bank">Bank account</option><option value="cash">Cash</option><option value="credit_card">Credit card</option></Select></div>
    {liability && <div><Label htmlFor="institution-v2">Bank</Label><Input id="institution-v2" value={form.institution} onChange={(event) => setForm({ ...form, institution: event.target.value })} placeholder="e.g. HSBC" /></div>}
    {(form.type === "bank" || form.type === "cash") && <div><Label htmlFor="account-purpose-v2">Use</Label><Select id="account-purpose-v2" value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })}><option value="spending">Everyday</option><option value="savings">Savings</option></Select></div>}
    {!account && <div><Label htmlFor="opening-balance-v2">{liability ? "Current amount owed" : "Opening balance"} ({currency})</Label><Input id="opening-balance-v2" min="0" step="0.01" inputMode="decimal" value={form.openingBalance} onChange={(event) => setForm({ ...form, openingBalance: event.target.value })} /></div>}
    {card && <>
      <div><Label htmlFor="limit-v2">Credit limit</Label><Input id="limit-v2" min="0" step="0.01" inputMode="decimal" value={form.limit} onChange={(event) => setForm({ ...form, limit: event.target.value })} /></div>
      <div className="grid grid-cols-2 gap-3"><div><Label htmlFor="last-statement-balance-v2">Last statement balance</Label><Input id="last-statement-balance-v2" min="0" step="0.01" inputMode="decimal" value={form.lastStatementBalance} onChange={(event) => setForm({ ...form, lastStatementBalance: event.target.value })} /></div><div><Label htmlFor="last-statement-date-v2">Statement date</Label><DatePicker id="last-statement-date-v2" value={form.lastStatementDate} onChange={(lastStatementDate) => setForm({ ...form, lastStatementDate })} placeholder="Choose date" /></div></div>
      <div><Label htmlFor="card-due-v2">Payment due date</Label><DatePicker id="card-due-v2" value={form.nextDueDate} onChange={(nextDueDate) => setForm({ ...form, nextDueDate })} placeholder="Choose due date" /></div>
      <div className="grid grid-cols-2 gap-3"><div><Label htmlFor="statement-day-v2">Usual statement day</Label><Input id="statement-day-v2" min="1" max="31" step="1" inputMode="numeric" value={form.statementDay} onChange={(event) => setForm({ ...form, statementDay: event.target.value })} /></div><div><Label htmlFor="due-day-v2">Usual due day</Label><Input id="due-day-v2" min="1" max="31" step="1" inputMode="numeric" value={form.dueDay} onChange={(event) => setForm({ ...form, dueDay: event.target.value })} /></div></div>
    </>}
    {loan && <>
      <div className="grid grid-cols-2 gap-3"><div><Label htmlFor="apr-v2">APR %</Label><Input id="apr-v2" min="0" step="0.01" inputMode="decimal" value={form.apr} onChange={(event) => setForm({ ...form, apr: event.target.value })} /></div><div><Label htmlFor="next-due-v2">Next due</Label><DatePicker id="next-due-v2" value={form.nextDueDate} onChange={(nextDueDate) => setForm({ ...form, nextDueDate })} placeholder="Choose due date" /></div></div>
      <div><Label htmlFor="installment-v2">Monthly EMI</Label><Input id="installment-v2" min="0" step="0.01" inputMode="decimal" value={form.installment} onChange={(event) => setForm({ ...form, installment: event.target.value })} /></div>
      <div className="grid grid-cols-2 gap-3"><div><Label htmlFor="original-principal-v2">Original principal</Label><Input id="original-principal-v2" min="0" step="0.01" inputMode="decimal" value={form.originalPrincipal} onChange={(event) => setForm({ ...form, originalPrincipal: event.target.value })} /></div><div><Label htmlFor="remaining-months-v2">EMIs remaining</Label><Input id="remaining-months-v2" min="0" step="1" inputMode="numeric" value={form.remainingMonths} onChange={(event) => setForm({ ...form, remainingMonths: event.target.value })} /></div></div>
      <div><Label htmlFor="prepayment-v2">Extra payments</Label><Select id="prepayment-v2" value={form.prepaymentAllowed} onChange={(event) => setForm({ ...form, prepaymentAllowed: event.target.value })}><option value="no">Not allowed or unknown</option><option value="yes">Allowed</option></Select></div>
    </>}
    <Button className="w-full" type="submit" disabled={saving}>{saving && <LoaderCircle className="h-4 w-4 animate-spin" />} {account ? "Save changes" : title}</Button>
  </form></DialogContent></Dialog>;
}

function LoanDialog({ open, onOpenChange, loan, defaultLinkedCardId, cards, currency, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; loan: RecordValue | null; defaultLinkedCardId: string | null; cards: RecordValue[]; currency: string; onSaved: () => Promise<void> }) {
  const blank = { name: "", kind: defaultLinkedCardId ? "balance_transfer" : "personal_loan", institution: "", currency, linkedCardId: defaultLinkedCardId || "standalone", includedInCardBalance: "yes", originalPrincipal: "", currentBalance: "", emi: "", totalInstallments: "", remainingInstallments: "", apr: "", nextDueDate: "", prepaymentAllowed: "no" };
  const [form, setForm] = useState<RecordValue>(blank);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setForm(loan ? {
      name: loan.name || "", kind: loan.kind || "personal_loan", institution: loan.institution || "", currency: loan.currency || currency,
      linkedCardId: loan.linkedCardId || "standalone", includedInCardBalance: loan.includedInCardBalance ? "yes" : "no",
      originalPrincipal: decimalFromMinor(loan.originalPrincipalMinor, true), currentBalance: decimalFromMinor(loan.balanceMinor ?? loan.currentBalanceMinor, true),
      emi: decimalFromMinor(loan.emiMinor, true), totalInstallments: String(loan.totalInstallments || ""), remainingInstallments: String(loan.remainingInstallments ?? loan.remainingPayments ?? ""),
      apr: loan.aprBps == null ? "" : (Number(loan.aprBps) / 100).toFixed(2), nextDueDate: loan.nextDueDate || "", prepaymentAllowed: loan.prepaymentAllowed ? "yes" : "no"
    } : { ...blank, kind: defaultLinkedCardId ? "balance_transfer" : "personal_loan", linkedCardId: defaultLinkedCardId || "standalone" });
    setError("");
  }, [open, loan, defaultLinkedCardId, currency]);
  const minor = (value: unknown) => Math.round(Number(value || 0) * 100);
  const calculatedEmi = form.emi || derivedEmiInput(form.currentBalance, form.remainingInstallments, form.totalInstallments);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const numericValues = [form.originalPrincipal, form.currentBalance, form.emi, form.totalInstallments, form.remainingInstallments, form.apr].filter((value) => value !== "");
    if (!String(form.name).trim()) { setError("Enter a name."); return; }
    if (numericValues.some((value) => !Number.isFinite(Number(value)) || Number(value) < 0)) { setError("Check the numeric values."); return; }
    if (form.totalInstallments !== "" && form.remainingInstallments !== "" && Number(form.remainingInstallments) > Number(form.totalInstallments)) { setError("Remaining EMIs cannot exceed total EMIs."); return; }
    setSaving(true); setError("");
    try {
      const selectedCard = cards.find((card) => card.id === form.linkedCardId);
      const body = {
        name: String(form.name).trim(), kind: form.kind, institution: String(form.institution || "").trim() || null,
        currency: selectedCard?.currency || form.currency || currency,
        linkedCardId: form.linkedCardId === "standalone" ? null : form.linkedCardId,
        includedInCardBalance: form.linkedCardId === "standalone" ? false : form.includedInCardBalance === "yes",
        originalPrincipalMinor: minor(form.originalPrincipal), currentBalanceMinor: minor(form.currentBalance),
        emiMinor: calculatedEmi === "" ? null : minor(calculatedEmi), totalInstallments: form.totalInstallments === "" ? null : Number(form.totalInstallments),
        remainingInstallments: form.remainingInstallments === "" ? null : Number(form.remainingInstallments), aprBps: form.apr === "" ? null : Math.round(Number(form.apr) * 100),
        nextDueDate: form.nextDueDate || null, prepaymentAllowed: form.prepaymentAllowed === "yes", source: "ui"
      };
      await api(loan ? `/loans/${loan.id}` : "/loans", { method: loan ? "PATCH" : "POST", headers: loan ? undefined : { "Idempotency-Key": idempotencyKey("ui-loan") }, body: JSON.stringify(body) });
      onOpenChange(false); await onSaved();
    } catch (value) { setError(value instanceof Error ? value.message : "Could not save loan"); }
    finally { setSaving(false); }
  }
  async function archive() {
    if (!loan) return;
    setSaving(true); setError("");
    try { await api(`/loans/${loan.id}`, { method: "PATCH", body: JSON.stringify({ archived: true, source: "ui" }) }); onOpenChange(false); await onSaved(); }
    catch (value) { setError(value instanceof Error ? value.message : "Could not archive loan"); }
    finally { setSaving(false); }
  }
  const linked = form.linkedCardId !== "standalone";
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>{loan ? "Edit loan" : "Add loan"}</DialogTitle><DialogDescription>Loan details.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={save}>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    <div><Label htmlFor="loan-name">Name</Label><Input id="loan-name" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></div>
    <div><Label htmlFor="loan-kind">Type</Label><Select id="loan-kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}><option value="personal_loan">Personal loan</option><option value="balance_transfer">Balance transfer</option><option value="card_installment">Card purchase EMI</option><option value="other">Other loan</option></Select></div>
    <div><Label htmlFor="loan-card">Held on</Label><Select id="loan-card" disabled={Boolean(loan?.accountId)} value={form.linkedCardId} onChange={(event) => setForm({ ...form, linkedCardId: event.target.value, kind: event.target.value === "standalone" && form.kind !== "personal_loan" ? "personal_loan" : form.kind })}><option value="standalone">Standalone loan</option>{cards.map((card) => <option key={card.id} value={card.id}>{card.name}</option>)}</Select></div>
    <div><Label htmlFor="loan-bank">Bank</Label><Input id="loan-bank" value={form.institution} onChange={(event) => setForm({ ...form, institution: event.target.value })} /></div>
    {linked && <div><Label htmlFor="loan-included">Card outstanding</Label><Select id="loan-included" value={form.includedInCardBalance} onChange={(event) => setForm({ ...form, includedInCardBalance: event.target.value })}><option value="yes">Already includes this loan</option><option value="no">Does not include this loan</option></Select></div>}
    <div className="grid grid-cols-2 gap-3"><div><Label htmlFor="loan-original">Original amount</Label><Input id="loan-original" required min="0" step="0.01" inputMode="decimal" value={form.originalPrincipal} onChange={(event) => setForm({ ...form, originalPrincipal: event.target.value })} /></div><div><Label htmlFor="loan-balance">Current balance</Label><Input id="loan-balance" required min="0" step="0.01" inputMode="decimal" value={form.currentBalance} onChange={(event) => setForm({ ...form, currentBalance: event.target.value })} /></div></div>
    <div><Label htmlFor="loan-emi">Monthly EMI</Label><Input id="loan-emi" min="0" step="0.01" inputMode="decimal" value={calculatedEmi} onChange={(event) => setForm({ ...form, emi: event.target.value })} /></div>
    <div className="grid grid-cols-2 gap-3"><div><Label htmlFor="loan-total-emis">Total EMIs</Label><Input id="loan-total-emis" min="1" step="1" inputMode="numeric" value={form.totalInstallments} onChange={(event) => setForm({ ...form, totalInstallments: event.target.value })} /></div><div><Label htmlFor="loan-remaining-emis">EMIs remaining</Label><Input id="loan-remaining-emis" min="0" step="1" inputMode="numeric" value={form.remainingInstallments} onChange={(event) => setForm({ ...form, remainingInstallments: event.target.value })} /></div></div>
    <div className="grid grid-cols-2 gap-3"><div><Label htmlFor="loan-apr">APR %</Label><Input id="loan-apr" min="0" step="0.01" inputMode="decimal" value={form.apr} onChange={(event) => setForm({ ...form, apr: event.target.value })} /></div><div><Label htmlFor="loan-next-due">Next EMI</Label><DatePicker id="loan-next-due" value={form.nextDueDate} onChange={(nextDueDate) => setForm({ ...form, nextDueDate })} placeholder="Choose date" /></div></div>
    <div><Label htmlFor="loan-prepayment">Extra payments</Label><Select id="loan-prepayment" value={form.prepaymentAllowed} onChange={(event) => setForm({ ...form, prepaymentAllowed: event.target.value })}><option value="no">Not allowed or unknown</option><option value="yes">Allowed</option></Select></div>
    <div className={cn("grid gap-2", loan && "grid-cols-2")}>{loan && <Button type="button" variant="destructive" disabled={saving} onClick={() => void archive()}>Archive</Button>}<Button type="submit" disabled={saving}>{saving && <LoaderCircle className="h-4 w-4 animate-spin" />} Save</Button></div>
  </form></DialogContent></Dialog>;
}

function InstallmentDialog({ open, onOpenChange, loan, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; loan: RecordValue | null; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<RecordValue>({ paidDate: localToday(), amount: "", interest: "", fee: "", note: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (open && loan) { setForm({ paidDate: localToday(), amount: decimalFromMinor(loan.emiMinor, true), interest: "", fee: "", note: "" }); setError(""); } }, [open, loan]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const amountMinor = Math.round(Number(form.amount) * 100);
    const interestMinor = Math.round(Number(form.interest || 0) * 100);
    const feeMinor = Math.round(Number(form.fee || 0) * 100);
    const principalMinor = amountMinor - interestMinor - feeMinor;
    if (!loan || !Number.isFinite(amountMinor) || amountMinor <= 0 || principalMinor < 0) { setError("Check the payment amounts."); return; }
    setSaving(true); setError("");
    try {
      await api(`/loans/${loan.id}/installments`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey("ui-loan-emi") }, body: JSON.stringify({ paidDate: form.paidDate, amountMinor, principalMinor, interestMinor, feeMinor, note: String(form.note || "").trim() || null, source: "ui" }) });
      onOpenChange(false); await onSaved();
    } catch (value) { setError(value instanceof Error ? value.message : "Could not record EMI"); }
    finally { setSaving(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>Record EMI</DialogTitle><DialogDescription>Paid loan installment.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={save}>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    <div><Label htmlFor="emi-paid-date">Paid date</Label><DatePicker id="emi-paid-date" value={form.paidDate} onChange={(paidDate) => setForm({ ...form, paidDate })} required /></div>
    <div><Label htmlFor="emi-amount">Amount</Label><Input id="emi-amount" required min="0.01" step="0.01" inputMode="decimal" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></div>
    <div className="grid grid-cols-2 gap-3"><div><Label htmlFor="emi-interest">Interest</Label><Input id="emi-interest" min="0" step="0.01" inputMode="decimal" value={form.interest} onChange={(event) => setForm({ ...form, interest: event.target.value })} /></div><div><Label htmlFor="emi-fee">Fees</Label><Input id="emi-fee" min="0" step="0.01" inputMode="decimal" value={form.fee} onChange={(event) => setForm({ ...form, fee: event.target.value })} /></div></div>
    <div><Label htmlFor="emi-note">Note</Label><Input id="emi-note" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></div>
    <Button className="w-full" type="submit" disabled={saving}>{saving && <LoaderCircle className="h-4 w-4 animate-spin" />} Record EMI</Button>
  </form></DialogContent></Dialog>;
}
