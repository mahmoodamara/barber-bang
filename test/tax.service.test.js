import test from "node:test";
import assert from "node:assert/strict";

function ensureTestEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_1234567890";
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_dummy";
  process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/barber_store_test";

  process.env.TAX_ENABLED = "true";
  process.env.TAX_COUNTRY = "IL";
  process.env.VAT_BPS = "1700";
  process.env.CITY_RATE_OVERRIDES = "tel aviv=1800";
}

test("computeTax: IL address => tax > 0", async () => {
  ensureTestEnv();
  const { computeTax } = await import("../src/services/tax.service.js");

  const out = computeTax({
    itemsSubtotalMinor: 10_000,
    discountMinor: 0,
    shippingMinor: 0,
    shippingAddress: { country: "IL", city: "Jerusalem" },
  });

  assert.equal(out.taxBasisMinor, 10_000);
  assert.equal(out.taxRateBps, 1700);
  assert.equal(out.taxMinor, 1700);
});

test("computeTax: non-IL address => tax = 0", async () => {
  ensureTestEnv();
  const { computeTax } = await import("../src/services/tax.service.js");

  const out = computeTax({
    itemsSubtotalMinor: 10_000,
    discountMinor: 0,
    shippingMinor: 0,
    shippingAddress: { country: "US", city: "New York" },
  });

  assert.equal(out.taxMinor, 0);
  assert.equal(out.taxRateBps, 0);
  assert.equal(out.taxBasisMinor, 0);
});

test("computeTax: shipping is included in taxable basis", async () => {
  ensureTestEnv();
  const { computeTax } = await import("../src/services/tax.service.js");

  const out = computeTax({
    itemsSubtotalMinor: 10_000,
    discountMinor: 0,
    shippingMinor: 1_000,
    shippingAddress: { country: "Israel", city: "Jerusalem" },
  });

  assert.equal(out.taxBasisMinor, 11_000);
  assert.equal(out.taxRateBps, 1700);
  assert.equal(out.taxMinor, 1870);
});

test("computeTax: city override bps is applied", async () => {
  ensureTestEnv();
  const { computeTax } = await import("../src/services/tax.service.js");

  const out = computeTax({
    itemsSubtotalMinor: 10_000,
    discountMinor: 0,
    shippingMinor: 0,
    shippingAddress: { country: "IL", city: "Tel Aviv" },
  });

  assert.equal(out.taxRateBps, 1800);
  assert.equal(out.taxMinor, 1800);
});

