import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { audit, getDb, inTransaction } from "@/lib/db";
import { camelize, getSavingsPosition, getSettings } from "@/lib/store";
import { zonedMonthValue } from "@/lib/time";

type Row = Record<string, any>;

const now = () => new Date().toISOString();
const currentMonth = () => zonedMonthValue(String(getSettings().timeZone ?? "Asia/Dubai"));

function monthNumber(month: string) {
  const [year, value] = month.split("-").map(Number);
  return year * 12 + value - 1;
}

function monthValue(index: number) {
  const year = Math.floor(index / 12);
  return `${year}-${String(index % 12 + 1).padStart(2, "0")}`;
}

function monthlyTotals(planId: string) {
  return getDb().prepare(`SELECT month,
      SUM(CASE WHEN kind = 'contribution' THEN amount_minor ELSE -amount_minor END) AS actual_minor
    FROM monthly_savings_checkins
    WHERE plan_id = ? AND deleted_at IS NULL
    GROUP BY month ORDER BY month DESC`).all(planId) as Array<{ month: string; actual_minor: number }>;
}

function decorateMonthlyPlan(row: Row, statusMonth = currentMonth()): Row {
  const target = Number(row.monthly_target_minor);
  const actualMovement = Number(getSavingsPosition(statusMonth).movementMinor);
  const actual = Math.max(0, actualMovement);
  const active = row.start_month <= statusMonth && (!row.end_month || row.end_month >= statusMonth) && !row.archived_at;
  const lastEligible = Math.min(monthNumber(statusMonth), row.end_month ? monthNumber(row.end_month) : monthNumber(statusMonth));
  let cursor = lastEligible;
  if (Number(getSavingsPosition(monthValue(cursor)).movementMinor) < target) cursor -= 1;
  let streak = 0;
  const first = monthNumber(row.start_month);
  while (cursor >= first && streak < 24 && Number(getSavingsPosition(monthValue(cursor)).movementMinor) >= target) {
    streak += 1;
    cursor -= 1;
  }
  const history: Row[] = [];
  for (let index = lastEligible; index >= monthNumber(row.start_month) && history.length < 24; index -= 1) {
    const month = monthValue(index);
    const movement = Number(getSavingsPosition(month).movementMinor);
    history.push({ month, targetMinor: target, actualMinor: Math.max(0, movement), netMovementMinor: movement, differenceMinor: movement - target, complete: movement >= target });
  }
  return {
    ...(camelize(row)! as Row),
    statusMonth,
    activeForMonth: active,
    actualMinor: actual,
    netMovementMinor: actualMovement,
    actualSource: "savings_accounts",
    remainingMinor: Math.max(0, target - actual),
    surplusMinor: Math.max(0, actual - target),
    percentage: Math.min(100, Math.round(actual / target * 100)),
    complete: actual >= target,
    streak,
    history
  };
}

export function listMonthlySavingsPlans(statusMonth = currentMonth(), includeArchived = false) {
  const rows = getDb().prepare(`SELECT * FROM monthly_savings_plans ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY archived_at IS NOT NULL, created_at DESC`).all() as Row[];
  return rows.map((row) => decorateMonthlyPlan(row, statusMonth));
}

export function getMonthlySavingsPlan(id: string, statusMonth = currentMonth()) {
  const row = getDb().prepare("SELECT * FROM monthly_savings_plans WHERE id = ?").get(id) as Row | undefined;
  return row ? decorateMonthlyPlan(row, statusMonth) : null;
}

export function createMonthlySavingsPlan(input: Row) {
  if (input.idempotencyKey) {
    const existing = getDb().prepare("SELECT id FROM monthly_savings_plans WHERE idempotency_key = ?").get(input.idempotencyKey) as { id: string } | undefined;
    if (existing) return getMonthlySavingsPlan(existing.id);
  }
  const id = randomUUID();
  const timestamp = now();
  getDb().prepare(`INSERT INTO monthly_savings_plans(id,name,monthly_target_minor,start_month,end_month,note,color,idempotency_key,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, input.name, input.monthlyTargetMinor, input.startMonth, input.endMonth ?? null, input.note ?? null, input.color ?? "#5f8f76", input.idempotencyKey ?? null, timestamp, timestamp);
  audit("create", "monthly_savings_plan", id, String(input.source ?? "api"), { name: input.name, monthlyTargetMinor: input.monthlyTargetMinor, startMonth: input.startMonth });
  return getMonthlySavingsPlan(id);
}

export function updateMonthlySavingsPlan(id: string, input: Row) {
  const current = getMonthlySavingsPlan(id);
  if (!current) return null;
  const nextStart = String(input.startMonth ?? current.startMonth);
  const nextEnd = input.endMonth !== undefined ? input.endMonth : current.endMonth;
  if (nextEnd && String(nextEnd) < nextStart) throw new Error("End month must be on or after start month");
  const fields: Row = {
    name: input.name,
    monthly_target_minor: input.monthlyTargetMinor,
    start_month: input.startMonth,
    end_month: input.endMonth,
    note: input.note,
    color: input.color,
    archived_at: input.archived === true ? now() : input.archived === false ? null : undefined
  };
  const present = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (present.length) getDb().prepare(`UPDATE monthly_savings_plans SET ${present.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...present.map(([, value]) => value), now(), id);
  audit("update", "monthly_savings_plan", id, String(input.source ?? "api"), { fields: present.map(([key]) => key) });
  return getMonthlySavingsPlan(id);
}

export function addMonthlySavingsCheckin(planId: string, input: Row) {
  if (input.idempotencyKey) {
    const existing = getDb().prepare("SELECT id, plan_id FROM monthly_savings_checkins WHERE idempotency_key = ?").get(input.idempotencyKey) as { id: string; plan_id: string } | undefined;
    if (existing) return { checkin: camelize(getDb().prepare("SELECT * FROM monthly_savings_checkins WHERE id = ?").get(existing.id) as Row), plan: getMonthlySavingsPlan(existing.plan_id, input.month) };
  }
  const plan = getDb().prepare("SELECT * FROM monthly_savings_plans WHERE id = ? AND archived_at IS NULL").get(planId) as Row | undefined;
  if (!plan) throw new Error("Monthly savings plan not found");
  if (input.month < plan.start_month || (plan.end_month && input.month > plan.end_month)) throw new Error("Check-in month is outside this plan");
  const actual = monthlyTotals(planId).find((item) => item.month === input.month)?.actual_minor ?? 0;
  if (input.kind === "withdrawal" && Number(input.amountMinor) > Number(actual)) throw new Error("Withdrawal cannot exceed savings recorded for this month");
  const id = randomUUID();
  getDb().prepare(`INSERT INTO monthly_savings_checkins(id,plan_id,month,kind,amount_minor,note,source,idempotency_key,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(id, planId, input.month, input.kind, input.amountMinor, input.note ?? null, input.source ?? "api", input.idempotencyKey ?? null, now());
  audit("create", "monthly_savings_checkin", id, String(input.source ?? "api"), { planId, month: input.month, kind: input.kind, amountMinor: input.amountMinor });
  return { checkin: camelize(getDb().prepare("SELECT * FROM monthly_savings_checkins WHERE id = ?").get(id) as Row), plan: getMonthlySavingsPlan(planId, input.month) };
}

export function deleteMonthlySavingsCheckin(planId: string, checkinId: string, source = "api") {
  const result = getDb().prepare("UPDATE monthly_savings_checkins SET deleted_at = ? WHERE id = ? AND plan_id = ? AND deleted_at IS NULL").run(now(), checkinId, planId);
  if (!result.changes) return null;
  audit("delete", "monthly_savings_checkin", checkinId, source, { planId });
  return getMonthlySavingsPlan(planId);
}

function latestSnapshot(assetId: string) {
  return getDb().prepare("SELECT * FROM wealth_snapshots WHERE asset_id = ? AND deleted_at IS NULL ORDER BY as_of_date DESC, created_at DESC LIMIT 1").get(assetId) as Row | undefined;
}

function decorateWealthAsset(row: Row): Row {
  const snapshots = (getDb().prepare("SELECT * FROM wealth_snapshots WHERE asset_id = ? AND deleted_at IS NULL ORDER BY as_of_date DESC, created_at DESC LIMIT 24").all(row.id) as Row[]).map((value) => camelize(value)!);
  const cashFlows = (getDb().prepare("SELECT * FROM wealth_cash_flows WHERE asset_id = ? AND deleted_at IS NULL ORDER BY date DESC, created_at DESC LIMIT 50").all(row.id) as Row[]).map((value) => camelize(value)!);
  const latest = snapshots[0] as Row | undefined;
  const netContributed = Number(row.opening_invested_minor) + cashFlows.reduce((sum, flow) => sum + (flow.kind === "contribution" ? Number(flow.amountMinor) : flow.kind === "withdrawal" ? -Number(flow.amountMinor) : 0), 0);
  const flowsAfterLatestSnapshot = latest
    ? cashFlows.filter((flow) => String(flow.date) > String(latest.asOfDate))
    : cashFlows;
  const investedAdjustment = flowsAfterLatestSnapshot.reduce((sum, flow) => sum + (flow.kind === "contribution" ? Number(flow.amountMinor) : flow.kind === "withdrawal" ? -Number(flow.amountMinor) : 0), 0);
  const currentAdjustment = flowsAfterLatestSnapshot.reduce((sum, flow) => sum + (flow.kind === "contribution" ? Number(flow.amountMinor) : flow.kind === "withdrawal" || flow.kind === "fee" ? -Number(flow.amountMinor) : 0), 0);
  const invested = Math.max(0, latest?.investedValueMinor == null ? netContributed : Number(latest.investedValueMinor) + investedAdjustment);
  const current = Math.max(0, (latest ? Number(latest.currentValueMinor) : Number(row.opening_invested_minor)) + currentAdjustment);
  const gain = current - invested;
  return {
    ...(camelize(row)! as Row),
    currentValueMinor: current,
    investedMinor: invested,
    netContributedMinor: Math.max(0, netContributed),
    gainLossMinor: gain,
    returnPercentage: invested > 0 ? Math.round(gain / invested * 10000) / 100 : 0,
    asOfDate: latest?.asOfDate ?? null,
    snapshots,
    cashFlows
  };
}

export function listWealthAssets(includeArchived = false) {
  return (getDb().prepare(`SELECT * FROM wealth_assets ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY archived_at IS NOT NULL, name`).all() as Row[]).map(decorateWealthAsset);
}

export function getWealthAsset(id: string) {
  const row = getDb().prepare("SELECT * FROM wealth_assets WHERE id = ?").get(id) as Row | undefined;
  return row ? decorateWealthAsset(row) : null;
}

export function getWealthOverview() {
  const assets = listWealthAssets() as Row[];
  const groups: Record<string, { currency: string; currentValueMinor: number; investedMinor: number; gainLossMinor: number }> = {};
  for (const asset of assets) {
    const currency = String(asset.currency);
    groups[currency] ??= { currency, currentValueMinor: 0, investedMinor: 0, gainLossMinor: 0 };
    groups[currency].currentValueMinor += Number(asset.currentValueMinor);
    groups[currency].investedMinor += Number(asset.investedMinor);
    groups[currency].gainLossMinor += Number(asset.gainLossMinor);
  }
  const currency = String(getSettings().baseCurrency ?? "AED");
  const base = groups[currency] ?? { currency, currentValueMinor: 0, investedMinor: 0, gainLossMinor: 0 };
  return { ...base, assetCount: assets.length, excludedCurrencyCount: assets.filter((asset) => asset.currency !== currency).length, totalsByCurrency: Object.values(groups), assets, pendingDrafts: listWealthImportDrafts("draft") };
}

function insertWealthSnapshot(db: DatabaseSync, assetId: string, input: Row, sourceDraftId?: string) {
  const id = randomUUID();
  db.prepare(`INSERT INTO wealth_snapshots(id,asset_id,current_value_minor,invested_value_minor,as_of_date,source,source_draft_id,note,idempotency_key,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, assetId, input.currentValueMinor, input.investedValueMinor ?? null, input.asOfDate, input.source ?? "api", sourceDraftId ?? input.sourceDraftId ?? null, input.note ?? null, input.idempotencyKey ?? null, now());
  return id;
}

export function createWealthAsset(input: Row) {
  if (input.idempotencyKey) {
    const existing = getDb().prepare("SELECT id FROM wealth_assets WHERE idempotency_key = ?").get(input.idempotencyKey) as { id: string } | undefined;
    if (existing) return getWealthAsset(existing.id);
  }
  const id = randomUUID();
  const timestamp = now();
  inTransaction((db) => {
    db.prepare(`INSERT INTO wealth_assets(id,name,type,institution,currency,opening_invested_minor,note,idempotency_key,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, input.name, input.type, input.institution ?? null, input.currency ?? getSettings().baseCurrency ?? "AED", input.openingInvestedMinor ?? 0, input.note ?? null, input.idempotencyKey ?? null, timestamp, timestamp);
    if (input.currentValueMinor != null) insertWealthSnapshot(db, id, { currentValueMinor: input.currentValueMinor, investedValueMinor: input.investedValueMinor, asOfDate: input.asOfDate ?? timestamp.slice(0, 10), source: input.source ?? "api", note: "Opening valuation", idempotencyKey: input.snapshotIdempotencyKey ?? null });
  });
  audit("create", "wealth_asset", id, String(input.source ?? "api"), { name: input.name, type: input.type });
  return getWealthAsset(id);
}

export function updateWealthAsset(id: string, input: Row) {
  if (!getWealthAsset(id)) return null;
  const fields: Row = { name: input.name, type: input.type, institution: input.institution, currency: input.currency, opening_invested_minor: input.openingInvestedMinor, note: input.note, archived_at: input.archived === true ? now() : input.archived === false ? null : undefined };
  const present = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (present.length) getDb().prepare(`UPDATE wealth_assets SET ${present.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...present.map(([, value]) => value), now(), id);
  audit("update", "wealth_asset", id, String(input.source ?? "api"), { fields: present.map(([key]) => key) });
  return getWealthAsset(id);
}

export function addWealthSnapshot(assetId: string, input: Row) {
  if (input.idempotencyKey) {
    const existing = getDb().prepare("SELECT id, asset_id FROM wealth_snapshots WHERE idempotency_key = ?").get(input.idempotencyKey) as { id: string; asset_id: string } | undefined;
    if (existing) return { snapshot: camelize(getDb().prepare("SELECT * FROM wealth_snapshots WHERE id = ?").get(existing.id) as Row), asset: getWealthAsset(existing.asset_id) };
  }
  if (!getDb().prepare("SELECT id FROM wealth_assets WHERE id = ? AND archived_at IS NULL").get(assetId)) throw new Error("Wealth asset not found");
  const id = insertWealthSnapshot(getDb(), assetId, input);
  audit("create", "wealth_snapshot", id, String(input.source ?? "api"), { assetId, currentValueMinor: input.currentValueMinor, asOfDate: input.asOfDate });
  return { snapshot: camelize(getDb().prepare("SELECT * FROM wealth_snapshots WHERE id = ?").get(id) as Row), asset: getWealthAsset(assetId) };
}

export function addWealthCashFlow(assetId: string, input: Row) {
  if (input.idempotencyKey) {
    const existing = getDb().prepare("SELECT id, asset_id FROM wealth_cash_flows WHERE idempotency_key = ?").get(input.idempotencyKey) as { id: string; asset_id: string } | undefined;
    if (existing) return { cashFlow: camelize(getDb().prepare("SELECT * FROM wealth_cash_flows WHERE id = ?").get(existing.id) as Row), asset: getWealthAsset(existing.asset_id) };
  }
  if (!getDb().prepare("SELECT id FROM wealth_assets WHERE id = ? AND archived_at IS NULL").get(assetId)) throw new Error("Wealth asset not found");
  const id = randomUUID();
  getDb().prepare(`INSERT INTO wealth_cash_flows(id,asset_id,kind,amount_minor,date,note,source,idempotency_key,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(id, assetId, input.kind, input.amountMinor, input.date, input.note ?? null, input.source ?? "api", input.idempotencyKey ?? null, now());
  audit("create", "wealth_cash_flow", id, String(input.source ?? "api"), { assetId, kind: input.kind, amountMinor: input.amountMinor });
  return { cashFlow: camelize(getDb().prepare("SELECT * FROM wealth_cash_flows WHERE id = ?").get(id) as Row), asset: getWealthAsset(assetId) };
}

export function deleteWealthRecord(assetId: string, kind: "snapshots" | "cash-flows", recordId: string, source = "api") {
  const table = kind === "snapshots" ? "wealth_snapshots" : "wealth_cash_flows";
  const result = getDb().prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ? AND asset_id = ? AND deleted_at IS NULL`).run(now(), recordId, assetId);
  if (!result.changes) return null;
  audit("delete", kind === "snapshots" ? "wealth_snapshot" : "wealth_cash_flow", recordId, source, { assetId });
  return getWealthAsset(assetId);
}

export function listWealthImportDrafts(status?: string) {
  const rows = status
    ? getDb().prepare("SELECT * FROM wealth_import_drafts WHERE status = ? ORDER BY created_at DESC").all(status) as Row[]
    : getDb().prepare("SELECT * FROM wealth_import_drafts ORDER BY created_at DESC").all() as Row[];
  return rows.map((row) => {
    const value = camelize(row)! as Row;
    delete value.proposalsJson;
    return { ...value, proposals: JSON.parse(String(row.proposals_json)) };
  });
}

export function getWealthImportDraft(id: string) {
  const row = getDb().prepare("SELECT * FROM wealth_import_drafts WHERE id = ?").get(id) as Row | undefined;
  if (!row) return null;
  const appliedAssets = row.status === "applied" ? (getDb().prepare(`SELECT DISTINCT a.* FROM wealth_assets a JOIN wealth_snapshots s ON s.asset_id = a.id WHERE s.source_draft_id = ?`).all(id) as Row[]).map(decorateWealthAsset) : [];
  const value = camelize(row)! as Row;
  delete value.proposalsJson;
  return { ...value, proposals: JSON.parse(String(row.proposals_json)), appliedAssets } as Row;
}

export function createWealthImportDraft(input: Row) {
  if (input.idempotencyKey) {
    const existing = getDb().prepare("SELECT id FROM wealth_import_drafts WHERE idempotency_key = ?").get(input.idempotencyKey) as { id: string } | undefined;
    if (existing) return getWealthImportDraft(existing.id);
  }
  const id = randomUUID();
  getDb().prepare(`INSERT INTO wealth_import_drafts(id,source_filename,source_sha256,captured_at,institution,proposals_json,extraction_notes,status,source,idempotency_key,created_at)
    VALUES(?,?,?,?,?,?,?,'draft',?,?,?)`).run(id, input.sourceFilename, input.sourceSha256 ?? null, input.capturedAt ?? null, input.institution ?? null, JSON.stringify(input.proposals), input.extractionNotes ?? null, input.source ?? "hermes", input.idempotencyKey ?? null, now());
  audit("create", "wealth_import_draft", id, String(input.source ?? "hermes"), { sourceFilename: input.sourceFilename, proposalCount: input.proposals.length });
  return getWealthImportDraft(id);
}

export function applyWealthImportDraft(id: string, source = "hermes") {
  const current = getWealthImportDraft(id);
  if (!current) return null;
  if (current.status === "applied") return current;
  if (current.status !== "draft") throw new Error("Wealth import draft is no longer editable");
  const proposals = current.proposals as Row[];
  const timestamp = now();
  inTransaction((db) => {
    proposals.forEach((proposal, index) => {
      let assetId = proposal.assetId as string | undefined;
      if (assetId) {
        if (!db.prepare("SELECT id FROM wealth_assets WHERE id = ? AND archived_at IS NULL").get(assetId)) throw new Error(`Wealth asset not found for proposal ${index + 1}`);
        db.prepare("UPDATE wealth_assets SET name = COALESCE(?, name), institution = COALESCE(?, institution), updated_at = ? WHERE id = ?").run(proposal.name ?? null, proposal.institution ?? null, timestamp, assetId);
      } else {
        assetId = randomUUID();
        db.prepare(`INSERT INTO wealth_assets(id,name,type,institution,currency,opening_invested_minor,note,idempotency_key,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(assetId, proposal.name, proposal.type, proposal.institution ?? current.institution ?? null, proposal.currency ?? getSettings().baseCurrency ?? "AED", proposal.investedValueMinor ?? 0, proposal.note ?? null, `wealth-draft-asset:${id}:${index}`, timestamp, timestamp);
      }
      insertWealthSnapshot(db, assetId, { currentValueMinor: proposal.currentValueMinor, investedValueMinor: proposal.investedValueMinor, asOfDate: proposal.asOfDate, source, note: proposal.note ?? `From ${current.sourceFilename}`, idempotencyKey: `wealth-draft-snapshot:${id}:${index}` }, id);
    });
    db.prepare("UPDATE wealth_import_drafts SET status = 'applied', applied_at = ? WHERE id = ?").run(timestamp, id);
  });
  audit("apply", "wealth_import_draft", id, source, { proposalCount: proposals.length });
  return getWealthImportDraft(id);
}

export function cancelWealthImportDraft(id: string, source = "hermes") {
  const result = getDb().prepare("UPDATE wealth_import_drafts SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'draft'").run(now(), id);
  if (!result.changes) return null;
  audit("cancel", "wealth_import_draft", id, source, {});
  return getWealthImportDraft(id);
}
