// src/utils/stripe.js

export function toMinorUnits(major) {
  const n = Number(major || 0);
  return Math.max(0, Math.round((n + Number.EPSILON) * 100));
}

export function fromMinorUnits(minor) {
  const n = Number(minor || 0);
  return Math.round(n + Number.EPSILON) / 100;
}
