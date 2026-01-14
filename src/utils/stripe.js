export function ensureMinorUnitsInt(v) {
  if (!Number.isInteger(v) || v < 0) {
    const err = new Error("INVALID_MONEY_UNIT");
    err.statusCode = 400;
    throw err;
  }
}

export function toMinorUnits(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) {
    const err = new Error("INVALID_MONEY_UNIT");
    err.statusCode = 400;
    throw err;
  }
  const c = normalizeCurrency(currency) || "ILS";
  const zeroDecimal = new Set(["JPY", "KRW"]);
  const factor = zeroDecimal.has(c) ? 1 : 100;
  return Math.round(n * factor);
}

export function normalizeCurrency(code) {
  const raw = String(code || "").trim();
  if (!raw) return undefined;
  const upper = raw.toUpperCase();
  if (upper === "\u20AA" || upper === "NIS") return "ILS";
  return upper;
}
