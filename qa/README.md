# QA Suite for your Node/Express/Mongoose server

This is a **drop-in QA harness** tailored to your current server code layout (ESM modules).
It focuses on the business-critical flows: checkout, payments/webhooks, coupons, refunds, admin governance, observability.

## Files
- `jest.config.cjs` — Jest config for ESM
- `tests/setup.cjs` — DB bootstrap (MongoMemoryReplSet) + env
- `tests/*.test.cjs` — API/integration tests
- `postman/collection.json` — Manual regression collection
- `stripe/stripe-cli.md` — Stripe CLI webhook replay steps
- `k6/smoke.js` — Load smoke test

## Required dev dependencies
Install (or ensure you already have):
- `jest`
- `supertest`
- `mongodb-memory-server`
- `cross-env` (optional)

If you want local unit tests for Stripe signature header generation:
- `stripe`

## How to run
1) Copy this folder into your repo root as `qa/`.
2) Add scripts to your root `package.json`:

```json
{
  "scripts": {
    "test:qa": "cross-env NODE_ENV=test ENABLE_METRICS=false ENABLE_RANKING_JOB=false ENABLE_RESERVATION_REPAIR_JOB=false ENABLE_INVOICE_RETRY_JOB=false REQUIRE_TRANSACTIONS=true jest -c qa/jest.config.cjs --runInBand",
    "test:qa:watch": "cross-env NODE_ENV=test jest -c qa/jest.config.cjs --watch"
  }
}
```

3) Run:

```bash
npm run test:qa
```

## Notes
- Tests use an in-memory **replica set** so transaction-required paths can be verified.
- Rate limiters remain active; tests avoid hitting the same endpoint in a tight loop unless needed.
- Stripe webhook tests are split:
  - automated “schema-level” checks
  - Stripe CLI “real signature” replay steps (see `stripe/stripe-cli.md`)
