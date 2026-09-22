export function toMinor(value: number | string): number {
  const numeric = typeof value === "string" ? Number(value.replace(/,/g, "")) : value;
  if (!Number.isFinite(numeric)) throw new Error("Amount must be a valid number");
  return Math.round(numeric * 100);
}

export function fromMinor(value: number): number {
  return Number((value / 100).toFixed(2));
}

export function formatMoney(valueMinor: number, currency = "AED", locale = "en-AE") {
  return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(fromMinor(valueMinor));
}

export function monthBounds(month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Month must use YYYY-MM");
  const [year, monthNumber] = month.split("-").map(Number);
  const start = `${month}-01`;
  const endDate = new Date(Date.UTC(year, monthNumber, 0));
  const end = endDate.toISOString().slice(0, 10);
  return { start, end };
}
