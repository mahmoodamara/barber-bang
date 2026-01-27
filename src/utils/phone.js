// src/utils/phone.js
// Israel phone utilities: normalize + compare
// Supports: 05xxxxxxxx, +9725xxxxxxx, 9725xxxxxxx, spaces/dashes

function onlyDigits(s) {
  return String(s || "").replace(/\D+/g, "");
}

/**
 * Normalize Israeli phone numbers into a stable comparable form.
 * Output format: "972" + national_without_leading_0
 * Examples:
 *  - "054-1234567"       -> "972541234567"
 *  - "+972 54 123 4567"  -> "972541234567"
 *  - "972541234567"      -> "972541234567"
 *
 * Returns null if cannot normalize.
 */
export function normalizeILPhone(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;

  let digits = onlyDigits(raw);
  if (!digits) return null;

  // handle international prefix 00 (e.g., 00972...)
  if (digits.startsWith("00")) digits = digits.slice(2);

  // If starts with country code 972
  if (digits.startsWith("972")) {
    const rest = digits.slice(3);

    // sometimes people write 9720XXXXXXXXX by mistake
    const withoutLeadingZero = rest.startsWith("0") ? rest.slice(1) : rest;

    // Must start with 5 or 2 (mobile or landline) commonly.
    // We'll allow most lengths 8..10 after country (mobile is 9 digits: 5 + 8)
    if (withoutLeadingZero.length < 8 || withoutLeadingZero.length > 10) return null;

    return "972" + withoutLeadingZero;
  }

  // Local Israeli formats: 0XXXXXXXXX
  if (digits.startsWith("0")) {
    const national = digits.slice(1);
    if (national.length < 8 || national.length > 10) return null;
    return "972" + national;
  }

  // If user sent "5XXXXXXXX" without leading 0 (rare)
  // We'll accept if it looks like a mobile number.
  if (digits.startsWith("5") && digits.length >= 9 && digits.length <= 10) {
    return "972" + digits;
  }

  // Fallback: can't normalize
  return null;
}

/**
 * Compares two phone numbers after normalization.
 * Returns true only if both normalize successfully AND match.
 */
export function isSameILPhone(a, b) {
  const na = normalizeILPhone(a);
  const nb = normalizeILPhone(b);
  if (!na || !nb) return false;
  return na === nb;
}

/**
 * Returns a safe masked phone string for UI/logging.
 * Example: 972541234567 -> +97254*****67
 */
export function maskPhone(phone) {
  const n = normalizeILPhone(phone);
  if (!n) return "";
  const cc = "+972";
  const rest = n.slice(3); // national
  if (rest.length <= 4) return cc + rest;
  return cc + rest.slice(0, 2) + "*****" + rest.slice(-2);
}
