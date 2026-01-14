# barber-store-server

Production-grade backend for an e-commerce store (barber/grooming supplies) built with **Node.js (ESM) + Express + MongoDB (Mongoose)**, including a separate **worker** for background jobs and scheduled maintenance.

## Prerequisites

- Node.js >= 20
- MongoDB >= 6
- Stripe account (test mode OK)
- For invoice PDFs: Chrome/Chromium executable (`CHROME_EXECUTABLE_PATH`)

## Install

```bash
npm install
```

Create `.env`:

- Windows PowerShell:
```powershell
Copy-Item .env.example .env
```

- macOS/Linux:
```bash
cp .env.example .env
```

Edit `.env` and set at least:
- `MONGO_URI`
- `JWT_SECRET`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

## Run

Development:
```bash
npm run dev
npm run dev:worker
```

Production:
```bash
npm run start
npm run start:worker
```

## Verification (smoke test)

Health/ready:
```bash
curl http://localhost:4000/health
curl http://localhost:4000/ready
```

Ensure indexes:
```bash
npm run ensure:indexes
```

Stripe webhook (local dev):
```bash
stripe listen --forward-to http://localhost:4000/api/v1/webhooks/stripe
```
Copy `whsec_...` into `.env` (`STRIPE_WEBHOOK_SECRET`).

## Production checklist

Set explicit production env overrides:
- `RATE_LIMIT_BACKEND=mongo`
- `MONGO_AUTO_INDEX=false`
- `MONGO_MAX_POOL_SIZE=<tuned value>`
- `PDF_MAX_CONCURRENCY`, `PDF_BROWSER_RECYCLE_JOBS`, `PDF_BROWSER_MAX_AGE_MS` (if generating PDFs)

Verify production env:
```bash
npm run verify:prod-env
```

Run on each deploy (index sync):
```bash
npm run ensure:indexes
```
Optional: `DRY_RUN=true npm run ensure:indexes` to list indexes and confirm Product text + review stats indexes.

One-time backfill after deploying review stats:
```bash
npm run backfill:review-stats
```

One-time soft-delete migration (adds isDeleted/deletedAt defaults):
```bash
npm run migrate:soft-delete
npm run ensure:indexes
```

## Performance/security knobs

- `AUTH_CACHE_TTL_MS` (30s-120s): short TTL cache for auth role/tokenVersion checks.
- `DB_SLOW_QUERY_MS`: slow query log threshold (defaults to `SLOW_REQUEST_MS`).

## Load testing (targeted)

Run a focused sweep (search, popular, home, auth bursts, orders list):
```bash
BASE_URL=http://localhost:4000 DURATION_MS=15000 CONCURRENCY=10 npm run load:test
```

For auth/orders scenarios, provide credentials or a token:
```bash
AUTH_EMAIL=you@example.com AUTH_PASSWORD=secret npm run load:test
AUTH_TOKEN=eyJ... npm run load:test
```

Monitoring during the run:
- `/metrics` exposes `db_query_duration_ms`, `db_query_timeouts_total`, and `db_slow_queries_total`.
- For DB CPU and connections, use MongoDB Atlas metrics or `db.serverStatus().connections` on the primary.

## Notes on compatibility

- Order status uses `cancelled` internally (double-L). Admin ops summary preserves the response key `canceled` for backward compatibility.
- Order creation validates input while accepting legacy coupon shapes (`coupon`, `{coupon:{code}}`, `couponCode`).

## Tax / VAT (backend-owned)

- Client must NOT send tax; backend computes and stores it on draft creation.
- Minimal policy: if `shippingAddress.country` (normalized) != `TAX_COUNTRY` => tax is `0`.
- Tax basis (taxable): `subtotal - discount + shipping` (all minor units), tax = `round(basis * VAT_BPS / 10000)`.
- Snapshots are stored under `order.pricing` (`taxMinor`, `taxRateBps`, `taxBasisMinor`, `taxCountrySnapshot`, `taxCitySnapshot`); legacy `pricing.tax` stays aligned to `taxMinor`.

## Transactions safety

- Set `REQUIRE_TRANSACTIONS=true` to block sensitive operations when MongoDB transactions aren’t supported (standalone server / non-replica).
- Affected areas: stock reserve/confirm/release, coupon redemption, payment finalization.


## Home Page Endpoints (Arabic/Hebrew)

These endpoints were added to support a modern Home page (categories with counts/images, brands strip, ratings stats, and featured reviews).

> `lang` is inferred from `?lang=he|ar` (and/or request headers), consistent with the rest of the API.

### Catalog

- `GET /api/v1/catalog/categories?topLevel=1`
  - Returns top-level categories with `image` and `productsCount`.

- `GET /api/v1/catalog/brands`
  - Returns distinct active product brands.

- `GET /api/v1/catalog/stats`
  - Returns `ratingAvg`, `reviewsCount`, `customersCount`, `ordersCount`, `shippingLabel`.

- `GET /api/v1/catalog/products?sort=popular&limit=6`
  - Added `sort=popular` (uses approved reviews) and includes `ratingAvg` + `reviewsCount` on each item.

- `GET /api/v1/catalog/home?productsLimit=6&reviewsLimit=3`
  - Convenience endpoint bundling home payload (categories, brands, stats, featured reviews, popular products).

### Reviews

- `GET /api/v1/reviews/featured?limit=3`
  - Returns featured reviews for home. If no `isFeatured` reviews exist, it falls back to best recent approved reviews.
