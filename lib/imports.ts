import { createHash, randomUUID } from "node:crypto";
import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import pdf from "pdf-parse";
import { audit, getDb, inTransaction } from "@/lib/db";
import { camelize, createTransaction, getAccount, listCategories } from "@/lib/store";
import { inferExpenseCategoryName } from "@/lib/categorization";

type AnyRow = Record<string, any>;

export type ImportMapping = {
  dateColumn?: string;
  descriptionColumn?: string;
  amountColumn?: string;
  debitColumn?: string;
  creditColumn?: string;
  amountDirection?: "negative-is-out" | "positive-is-out";
  dateFormat?: "auto" | "dd/mm/yyyy" | "mm/dd/yyyy" | "yyyy-mm-dd";
};

type NormalizedRow = {
  date: string;
  description: string;
  amountMinor: number;
  direction: "in" | "out";
  categoryId: string | null;
};

const now = () => new Date().toISOString();
const clean = (value: unknown) => String(value ?? "").trim();

function parseAmount(value: unknown) {
  const text = clean(value).replace(/[A-Z]{3}|[,$\s]/gi, "").replace(/^\((.*)\)$/, "-$1");
  const number = Number(text);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function parseDate(value: unknown, format: ImportMapping["dateFormat"] = "auto") {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = clean(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const match = text.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (match) {
    const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    const first = Number(match[1]);
    const second = Number(match[2]);
    const dayFirst = format === "dd/mm/yyyy" || (format === "auto" && (first > 12 || second <= 12));
    const month = dayFirst ? second : first;
    const day = dayFirst ? first : second;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function matchColumn(headers: string[], requested: string | undefined, candidates: string[]) {
  if (requested && headers.includes(requested)) return requested;
  const lowered = new Map(headers.map((header) => [header.toLowerCase().replace(/[^a-z]/g, ""), header]));
  for (const candidate of candidates) {
    const found = lowered.get(candidate.replace(/[^a-z]/g, ""));
    if (found) return found;
  }
  return undefined;
}

function inferCategory(description: string) {
  const categories = listCategories() as Array<Record<string, unknown>>;
  const name = inferExpenseCategoryName(description);
  return String(categories.find((category) => category.name === name)?.id ?? "") || null;
}

function normalizeTabular(rows: AnyRow[], mapping: ImportMapping = {}) {
  if (!rows.length) return [];
  const headers = Object.keys(rows[0]);
  const dateColumn = matchColumn(headers, mapping.dateColumn, ["date", "transactiondate", "postingdate", "valuedate"]);
  const descriptionColumn = matchColumn(headers, mapping.descriptionColumn, ["description", "details", "merchant", "narration", "transactiondetails", "memo"]);
  const amountColumn = matchColumn(headers, mapping.amountColumn, ["amount", "transactionamount"]);
  const debitColumn = matchColumn(headers, mapping.debitColumn, ["debit", "withdrawal", "debitamount", "moneyout"]);
  const creditColumn = matchColumn(headers, mapping.creditColumn, ["credit", "deposit", "creditamount", "moneyin"]);
  if (!dateColumn || (!amountColumn && !debitColumn && !creditColumn)) {
    throw new Error(`Could not detect statement columns. Found: ${headers.join(", ")}`);
  }
  return rows.map((row) => {
    const debit = debitColumn ? Math.abs(parseAmount(row[debitColumn])) : 0;
    const credit = creditColumn ? Math.abs(parseAmount(row[creditColumn])) : 0;
    const signedAmount = amountColumn ? parseAmount(row[amountColumn]) : credit - debit;
    const out = amountColumn
      ? mapping.amountDirection === "positive-is-out" ? signedAmount > 0 : signedAmount < 0
      : debit > 0;
    const amountMinor = Math.abs(amountColumn ? signedAmount : debit || credit);
    const description = clean(descriptionColumn ? row[descriptionColumn] : "Statement transaction");
    return {
      date: parseDate(row[dateColumn], mapping.dateFormat),
      description,
      amountMinor,
      direction: out ? "out" as const : "in" as const,
      categoryId: out ? inferCategory(description) : null
    };
  });
}

async function parseFile(buffer: Buffer, filename: string, mapping: ImportMapping) {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (extension === "csv") {
    const rows = parseCsv(buffer, { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true, trim: true }) as AnyRow[];
    return normalizeTabular(rows, mapping);
  }
  if (extension === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error("The XLSX workbook has no worksheets");
    const headers: string[] = [];
    sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, column) => { headers[column] = cell.text.trim() || `Column ${column}`; });
    const rows: AnyRow[] = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const value: AnyRow = {};
      headers.forEach((header, column) => {
        if (!header) return;
        const cell = row.getCell(column);
        value[header] = cell.value instanceof Date ? cell.value : cell.text;
      });
      if (Object.values(value).some((cell) => clean(cell))) rows.push(value);
    });
    return normalizeTabular(rows, mapping);
  }
  if (extension === "pdf") {
    const parsed = await pdf(buffer);
    const lines = parsed.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const rows: AnyRow[] = [];
    for (const line of lines) {
      const dateMatch = line.match(/^(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{2}-\d{2})\s+(.+?)\s+(-?[\d,]+\.\d{2})(?:\s|$)/);
      if (dateMatch) rows.push({ Date: dateMatch[1], Description: dateMatch[2], Amount: dateMatch[3] });
    }
    if (!rows.length) throw new Error("No text transactions were detected in this PDF; it may be scanned or require a bank-specific parser");
    return normalizeTabular(rows, { dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", ...mapping });
  }
  throw new Error("Supported statement formats are CSV, XLSX, and text-based PDF");
}

function fingerprint(accountId: string, row: NormalizedRow) {
  return createHash("sha256").update([accountId, row.date, row.direction, row.amountMinor, row.description.toLowerCase().replace(/\s+/g, " ")].join("|")).digest("hex");
}

export async function previewImport(args: { accountId: string; filename: string; buffer: Buffer; profileId?: string; mapping?: ImportMapping }) {
  if (!getAccount(args.accountId)) throw new Error("Account not found");
  const fileHash = createHash("sha256").update(args.buffer).digest("hex");
  let mapping = args.mapping ?? {};
  if (args.profileId) {
    const profile = getDb().prepare("SELECT mapping_json FROM import_profiles WHERE id = ?").get(args.profileId) as { mapping_json: string } | undefined;
    if (!profile) throw new Error("Import profile not found");
    mapping = JSON.parse(profile.mapping_json) as ImportMapping;
  }
  const normalized = await parseFile(args.buffer, args.filename, mapping);
  const batchId = randomUUID();
  const timestamp = now();
  let duplicateCount = 0;
  let invalidCount = 0;
  let totalIn = 0;
  let totalOut = 0;
  inTransaction((db) => {
    db.prepare(`INSERT INTO import_batches(id,account_id,profile_id,filename,file_type,file_hash,parser_version,status,row_count,duplicate_count,invalid_count,total_in_minor,total_out_minor,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(batchId, args.accountId, args.profileId ?? null, args.filename, args.filename.split(".").pop()?.toLowerCase() ?? "unknown", fileHash, "1", "preview", normalized.length, 0, 0, 0, 0, timestamp);
    const insertRow = db.prepare("INSERT INTO import_rows(id,batch_id,row_number,fingerprint,normalized_json,status,error) VALUES(?,?,?,?,?,?,?)");
    normalized.forEach((row, index) => {
      const rowFingerprint = fingerprint(args.accountId, row);
      const duplicate = db.prepare(`SELECT 1 FROM import_rows ir JOIN import_batches ib ON ib.id=ir.batch_id WHERE ir.fingerprint=? AND (ir.status='applied' OR ib.status='applied') LIMIT 1`).get(rowFingerprint)
        || db.prepare(`SELECT 1 FROM transactions WHERE account_id=? AND date=? AND amount_minor=? AND LOWER(COALESCE(merchant,''))=LOWER(?) AND deleted_at IS NULL LIMIT 1`).get(args.accountId, row.date, row.amountMinor, row.description);
      const invalid = !row.date || row.amountMinor <= 0;
      const status = invalid ? "invalid" : duplicate ? "duplicate" : "ready";
      if (invalid) invalidCount += 1;
      else if (duplicate) duplicateCount += 1;
      else if (row.direction === "in") totalIn += row.amountMinor;
      else totalOut += row.amountMinor;
      insertRow.run(randomUUID(), batchId, index + 1, rowFingerprint, JSON.stringify(row), status, invalid ? "Missing valid date or amount" : null);
    });
    db.prepare("UPDATE import_batches SET duplicate_count=?, invalid_count=?, total_in_minor=?, total_out_minor=? WHERE id=?")
      .run(duplicateCount, invalidCount, totalIn, totalOut, batchId);
  });
  audit("preview", "import_batch", batchId, "hermes", { filename: args.filename, rowCount: normalized.length, duplicateCount, invalidCount });
  return getImport(batchId);
}

export function getImport(id: string) {
  const batch = getDb().prepare(`SELECT ib.*, a.name AS account_name, ip.name AS profile_name FROM import_batches ib JOIN accounts a ON a.id=ib.account_id LEFT JOIN import_profiles ip ON ip.id=ib.profile_id WHERE ib.id=?`).get(id) as AnyRow | undefined;
  if (!batch) return null;
  const rows = getDb().prepare("SELECT * FROM import_rows WHERE batch_id=? ORDER BY row_number").all(id) as AnyRow[];
  return { ...camelize(batch), rows: rows.map((row) => ({ ...camelize(row), normalized: JSON.parse(String(row.normalized_json)) })) };
}

export function updateImport(id: string, input: { rows?: Array<{ id: string; status?: string; categoryId?: string | null }>; profileName?: string; mapping?: ImportMapping }) {
  const batch = getImport(id) as Record<string, any> | null;
  if (!batch || batch.status !== "preview") return null;
  if (input.rows) {
    inTransaction((db) => {
      const statement = db.prepare("UPDATE import_rows SET status=?, normalized_json=? WHERE id=? AND batch_id=?");
      for (const patch of input.rows!) {
        const row = db.prepare("SELECT * FROM import_rows WHERE id=? AND batch_id=?").get(patch.id, id) as AnyRow | undefined;
        if (!row) continue;
        const normalized = JSON.parse(String(row.normalized_json));
        if (patch.categoryId !== undefined) normalized.categoryId = patch.categoryId;
        statement.run(patch.status ?? row.status, JSON.stringify(normalized), patch.id, id);
      }
    });
  }
  if (input.profileName && input.mapping) {
    const profile = createImportProfile({ name: input.profileName, accountId: String(batch.accountId), fileType: String(batch.fileType), mapping: input.mapping });
    getDb().prepare("UPDATE import_batches SET profile_id=? WHERE id=?").run(profile.id, id);
  }
  audit("update", "import_batch", id, "hermes", { rowPatches: input.rows?.length ?? 0, savedProfile: Boolean(input.profileName) });
  return getImport(id);
}

export function applyImport(id: string, idempotencyKey: string) {
  const batch = getImport(id) as Record<string, any> | null;
  if (!batch) return null;
  if (batch.status === "applied") return batch;
  const rows = (batch.rows as Array<Record<string, any>>).filter((row) => row.status === "ready");
  for (const row of rows) {
    const normalized = row.normalized as NormalizedRow;
    createTransaction({
      type: normalized.direction === "out" ? "expense" : "income",
      date: normalized.date,
      amountMinor: normalized.amountMinor,
      accountId: String(batch.accountId),
      categoryId: normalized.categoryId,
      merchant: normalized.description,
      source: "import",
      idempotencyKey: `${idempotencyKey}:${String(row.id)}`,
      importRowId: String(row.id)
    });
    getDb().prepare("UPDATE import_rows SET status='applied' WHERE id=?").run(row.id);
  }
  getDb().prepare("UPDATE import_batches SET status='applied', applied_at=? WHERE id=?").run(now(), id);
  audit("apply", "import_batch", id, "hermes", { appliedRows: rows.length });
  return getImport(id);
}

export function listImportProfiles(): AnyRow[] {
  return (getDb().prepare(`SELECT ip.*, a.name AS account_name FROM import_profiles ip LEFT JOIN accounts a ON a.id=ip.account_id ORDER BY ip.name`).all() as AnyRow[]).map((row) => ({ ...camelize(row)!, mapping: JSON.parse(String(row.mapping_json)) }));
}

export function createImportProfile(input: { name: string; accountId?: string; fileType: string; mapping: ImportMapping }) {
  const id = randomUUID();
  const timestamp = now();
  getDb().prepare("INSERT INTO import_profiles(id,name,account_id,file_type,mapping_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run(id, input.name, input.accountId ?? null, input.fileType, JSON.stringify(input.mapping), timestamp, timestamp);
  audit("create", "import_profile", id, "hermes", { name: input.name });
  return listImportProfiles().find((profile) => profile.id === id)!;
}

export function updateImportProfile(id: string, input: Partial<{ name: string; accountId: string | null; fileType: string; mapping: ImportMapping }>) {
  const current = getDb().prepare("SELECT * FROM import_profiles WHERE id=?").get(id) as AnyRow | undefined;
  if (!current) return null;
  getDb().prepare("UPDATE import_profiles SET name=?,account_id=?,file_type=?,mapping_json=?,updated_at=? WHERE id=?")
    .run(input.name ?? current.name, input.accountId === undefined ? current.account_id : input.accountId, input.fileType ?? current.file_type, input.mapping ? JSON.stringify(input.mapping) : current.mapping_json, now(), id);
  return listImportProfiles().find((profile) => profile.id === id) ?? null;
}

export function deleteImportProfile(id: string) {
  return Number(getDb().prepare("DELETE FROM import_profiles WHERE id=?").run(id).changes) > 0;
}
