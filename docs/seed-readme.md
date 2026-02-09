# Seed – Database Seeder

This document describes how to run the database seed, which env vars are required, what data it creates, and how to perform a safe reset.

## How to run

From the project root (where `package.json` is):

```bash
node src/scripts/seed.js
```

Or via npm script if defined:

```bash
npm run seed
```

**Requirements:**

- Node.js (ESM)
- MongoDB reachable via `MONGODB_URI` (or your app’s default)
- All required env vars set (see below)
- **Not** running in `NODE_ENV=production` (seed is disabled in production)

## Required env vars

Set these before running the seed. Passwords are never logged.

| Variable | Description |
|----------|-------------|
| `SEED_ADMIN_EMAIL` | Email for the admin user (e.g. `admin@example.com`) |
| `SEED_ADMIN_PASSWORD` | Password for the admin user |
| `SEED_STAFF_EMAIL` | Email for the staff user |
| `SEED_STAFF_PASSWORD` | Password for the staff user |
| `SEED_TEST_EMAIL` | Email for the test (customer) user |
| `SEED_TEST_PASSWORD` | Password for the test user |

Optional:

- `BCRYPT_ROUNDS` – bcrypt rounds for password hashing (default `10`)
- `MONGODB_URI` – MongoDB connection string (if not set in app config)

Example `.env` snippet:

```env
SEED_ADMIN_EMAIL=admin@shop.local
SEED_ADMIN_PASSWORD=your-secure-password
SEED_STAFF_EMAIL=staff@shop.local
SEED_STAFF_PASSWORD=your-secure-password
SEED_TEST_EMAIL=test@shop.local
SEED_TEST_PASSWORD=your-secure-password
```

## What the seed creates

The seed **wipes** the database (in a safe order to respect references), then inserts the following. All data is aligned with server models (schemas, validators, indexes).

| Domain | What is created |
|--------|------------------|
| **Auth** | 3 users: admin, staff, test user (roles and permissions from server config) |
| **Catalog** | Product attributes (e.g. hold_level, finish_type, scent, volume_ml), 5 categories, 11 products (including 1 with variants: two scent options), bilingual titles/descriptions |
| **Shipping** | 4 delivery areas, 2 pickup points, 1 store-pickup config |
| **Promos** | 1 coupon (WELCOME10), 1 campaign (category-based), PERCENT_OFF offer, FREE_SHIPPING offer, BUY_X_GET_Y offer, 1 gift rule (min order total) |
| **Content** | 1 SiteSettings doc, 1 HomeLayout (hero, categories, banner, featured-products), 6 content pages (about, accessibility, shipping, returns, terms, privacy) |
| **Orders** | Counter for order numbers, 3 sample orders: (1) no discount, delivery, (2) no discount, store pickup, (3) with campaign + coupon, delivery; coupon redemption and per-user usage recorded for order 3 |
| **Reviews** | 2 reviews (approved, linked to products and test user) |
| **Ranking** | ProductSignalDaily records for products, then `recalculateProductRanking` so Product.stats are filled from signals |

After insert, a short **verification** runs: document counts per collection and a check that no order has a dangling `userId` or order-item `productId`.

## Safe reset

The seed is **destructive**: it deletes all data in the collections it knows about, in dependency order, then inserts fresh data. So:

- **Full reset:** Run the seed on the target database. No separate “reset” script is needed; the seed itself wipes then seeds.
- **When to use:** Development or staging only. Do **not** run in production (the script exits with an error if `NODE_ENV=production`).
- **Backup:** If you need to keep existing data, back up MongoDB before running the seed.

Deletion order (to avoid reference errors): AuditLog → AdminApproval → Payment → ProductEngagement → ProductSignalDaily → StockReservation → ReturnRequest → Order → CouponRedemption → CouponReservation → CouponUserUsage → Review → Gift → Offer → Campaign → Coupon → HomeLayout → SiteSettings → ContentPage → StorePickupConfig → PickupPoint → DeliveryArea → MediaAsset → Product → Category → ProductAttribute → Counter → User.

## Helpers and structure

- **`src/scripts/seed.utils.js`** – Shared helpers: env validation, `toMinorSafe`, `nowPlusDays`, `slugFromSku`, `buildOrderPricing`, `buildOrderShipping`, `getNextOrderNumber`. Used by `seed.js` so all generated values match server schemas.
- **`src/scripts/seed.js`** – Single entry: wipe, then create users → attributes → categories → products → shipping → settings → promos → reviews → orders → ranking signals → recalculate ranking → verification → summary.

No changes are made to server logic (models, services, routes); only seed code and this doc are provided.
