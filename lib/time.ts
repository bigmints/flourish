export function zonedDateParts(timeZone: string, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { year: values.year, month: values.month, day: values.day };
}

export function zonedDateValue(timeZone: string, date = new Date()) {
  const parts = zonedDateParts(timeZone, date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function zonedMonthValue(timeZone: string, date = new Date()) {
  return zonedDateValue(timeZone, date).slice(0, 7);
}
