# Render Environment Variables — 100% Server Compatibility

This document lists all environment variables needed on [Render](https://render.com) so the server runs with full compatibility. Use it as a checklist when configuring your Web Service.

Reference: [.env.example](../.env.example) in the project root.

---

## Required for run and health

| Key | Description | Example |
|-----|-------------|---------|
| `NODE_ENV` | Environment | `production` |
| `PORT` | Server port (Render sets this automatically) | (set by Render) |
| `HOST` | Bind address | `0.0.0.0` |
| `MONGO_URI` | MongoDB connection string | `mongodb+srv://...` |
| `TRUST_PROXY` | Trust reverse proxy (required behind Render) | `true` |
| `JWT_SECRET` | Secret for JWT signing | (strong random string) |
| `JWT_ISSUER` | JWT issuer (e.g. your Render API URL) | `https://barber-bang.onrender.com` |
| `JWT_AUDIENCE` | JWT audience | e.g. `barber-bang` |
| `JWT_ACCESS_EXPIRES_IN` | Access token TTL | `15m` |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token TTL | `30d` |
| `CORS_ORIGIN` | Allowed frontend origin(s), comma-separated | `https://barber-bang.netlify.app` |
| `FRONTEND_URL` | Frontend base URL | `https://barber-bang.netlify.app` |
| `CLIENT_URL` | Client/base URL (same as frontend if SPA) | `https://barber-bang.netlify.app` |
| `STRIPE_SECRET_KEY` | Stripe secret key (health check requires it) | `sk_live_...` or `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (health check requires it) | `whsec_...` |
| `STRIPE_CURRENCY` | Stripe currency | `ils` |
| `STRIPE_SUCCESS_PATH` | Redirect path after successful checkout | `/checkout/success` |
| `STRIPE_CANCEL_PATH` | Redirect path after cancelled checkout | `/checkout/cancel` |

---

## VAT and pricing

| Key | Description | Example |
|-----|-------------|---------|
| `ENABLE_VAT` | Enable VAT in pricing | `true` |
| `VAT_RATE` | VAT rate (e.g. 18%) | `0.18` |

---

## Returns and refunds

| Key | Description | Example |
|-----|-------------|---------|
| `RETURN_WINDOW_DAYS` | Days allowed for returns | `14` |
| `RETURN_ALLOW_STATUS` | Order status(es) that allow return | `delivered` |
| `RETURN_INCLUDE_SHIPPING` | Include shipping in refund | `false` |
| `REFUND_WINDOW_DAYS` | Window for refunds (used by admin orders) | `14` |
| `CANCEL_FEE_PERCENT` | Cancellation fee percentage | `0` |
| `CANCEL_FEE_FIXED` | Fixed cancellation fee | `0` |

---

## SEO and store display

| Key | Description | Example |
|-----|-------------|---------|
| `STORE_BASE_URL` | Store base URL (for links and SEO) | `https://barber-bang.netlify.app` |
| `STORE_OG_IMAGE_URL` | Default Open Graph image URL | `https://barber-bang.netlify.app/og.jpg` |
| `STORE_NAME_HE` | Store name (Hebrew) | Your store name |
| `STORE_NAME_AR` | Store name (Arabic) | Your store name |

---

## Auth and security

| Key | Description | Example |
|-----|-------------|---------|
| `REGISTER_MIN_DELAY_MS` | Min delay between registrations (anti-spam) | `650` |
| `BCRYPT_ROUNDS` | bcrypt cost factor | `12` |
| `LOGIN_MAX_ATTEMPTS` | Failed logins before lockout | `5` |
| `LOGIN_LOCKOUT_MINUTES` | Lockout duration (minutes) | `15` |
| `PASSWORD_RESET_EXPIRY_MINUTES` | Password reset link TTL | `60` |
| `EMAIL_VERIFICATION_EXPIRY_MINUTES` | Email verification link TTL | `1440` |

---

## Allocation (B2B / Israel)

| Key | Description | Example |
|-----|-------------|---------|
| `ALLOCATION_ENABLED` | Enable allocation logic | `true` or `false` |
| `ALLOCATION_FORCE` | Force B2B allocation | `false` |
| `ALLOCATION_THRESHOLD_BEFORE_VAT_ILS` | Threshold in ILS | `0` |

---

## Stripe and reservations

| Key | Description | Example |
|-----|-------------|---------|
| `AUTO_REFUND_OUT_OF_STOCK` | Auto-refund when out of stock | `true` |
| `COUPON_RESERVATION_TTL_MINUTES` | Coupon reservation TTL | `15` |
| `STRIPE_CHECKOUT_STALE_MINUTES` | Consider checkout stale after (minutes) | `15` |
| `STRIPE_WEBHOOK_LOCK_STALE_MINUTES` | Webhook idempotency lock TTL | `10` |

---

## Background jobs

| Key | Description | Example |
|-----|-------------|---------|
| `ENABLE_RESERVATION_REPAIR_JOB` | Run reservation repair job | `true` |
| `RESERVATION_REPAIR_INTERVAL_MS` | Interval (ms) | `180000` |
| `ENABLE_RANKING_JOB` | Run product ranking job | `true` |
| `PRODUCT_RANKING_INTERVAL_MS` | Interval (ms) | `600000` |
| `PRODUCT_RANKING_BATCH_SIZE` | Batch size | `500` |

---

## Invoice provider (optional)

| Key | Description | Example |
|-----|-------------|---------|
| `INVOICE_PROVIDER` | `icount` \| `greeninvoice` \| `manual` \| `stripe` \| `disabled` | `disabled` |
| `INVOICE_BASE_URL` | Base URL for invoice links | (empty if disabled) |

If using **icount**: add `ICOUNT_API_URL`, `ICOUNT_API_KEY`.  
If using **greeninvoice**: add `GREENINVOICE_API_URL`, `GREENINVOICE_API_KEY`.

---

## Cloudinary (optional, for admin media)

| Key | Description | Example |
|-----|-------------|---------|
| `CLOUDINARY_CLOUD_NAME` | Cloud name | From Cloudinary dashboard |
| `CLOUDINARY_API_KEY` | API key | From Cloudinary dashboard |
| `CLOUDINARY_API_SECRET` | API secret (must match Dashboard exactly) | From Cloudinary dashboard |
| `CLOUDINARY_FOLDER` | Default folder (optional) | e.g. `barber-bang` |
| `CLOUDINARY_MAX_FILE_SIZE` | Max upload size in bytes (optional) | `5242880` (5MB) |

**Invalid Signature:** If uploads fail with `CLOUDINARY_ERROR` and "Invalid Signature", the API secret on Render does not match Cloudinary. See [Cloudinary Invalid Signature](cloudinary-invalid-signature.md) for the fix checklist.

---

## Redis (optional)

If you use Redis for cache or rate limiting:

| Key | Description |
|-----|-------------|
| `REDIS_URL` | Redis connection URL |
| `CACHE_REDIS_URL` | Cache Redis URL (falls back to `REDIS_URL`) |
| `RATE_LIMIT_REDIS_URL` | Rate-limit Redis URL (falls back to `REDIS_URL`) |

---

## Server timeouts and behaviour (optional)

| Key | Description | Example |
|-----|-------------|---------|
| `SHUTDOWN_TIMEOUT_MS` | Graceful shutdown timeout | `10000` |
| `HTTP_REQUEST_TIMEOUT_MS` | HTTP request timeout | `30000` |
| `HTTP_HEADERS_TIMEOUT_MS` | HTTP headers timeout | `30000` |
| `HTTP_KEEP_ALIVE_TIMEOUT_MS` | Keep-alive timeout | `61000` |
| `REQUIRE_TRANSACTIONS` | Enforce Mongo transactions in production | `true` |
| `LOG_LEVEL` | Log level | `info` |

---

## Observability (optional)

| Key | Description |
|-----|-------------|
| `ENABLE_METRICS` | Enable Prometheus metrics | `false` |
| `ENABLE_TRACING` | Enable OpenTelemetry | `false` |
| `SENTRY_DSN` | Sentry DSN for error tracking |
| `OTEL_SERVICE_NAME` | OpenTelemetry service name |

---

## Seed (only if running seed on Render)

| Key | Description |
|-----|-------------|
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Admin user |
| `SEED_STAFF_EMAIL`, `SEED_STAFF_PASSWORD` | Staff user |
| `SEED_TEST_EMAIL`, `SEED_TEST_PASSWORD` | Test user |
| `SEED_CLEANUP` | Cleanup before seed | `false` |
| `ALLOW_SEED_PROD` | Allow seed in production (dangerous) | `false` |
| `SEED_CONFIRM` | Must set e.g. `WIPE_DB` with `ALLOW_SEED_PROD` | (only when seeding prod) |

---

## Quick checklist (minimum for 100% compatibility)

Ensure at least these are set on Render:

- [ ] `NODE_ENV`, `PORT`, `HOST`, `MONGO_URI`, `TRUST_PROXY`
- [ ] `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`
- [ ] `CORS_ORIGIN`, `FRONTEND_URL`, `CLIENT_URL`
- [ ] `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CURRENCY`, `STRIPE_SUCCESS_PATH`, `STRIPE_CANCEL_PATH`
- [ ] `ENABLE_VAT`, `VAT_RATE`
- [ ] `RETURN_WINDOW_DAYS`, `REFUND_WINDOW_DAYS`, `RETURN_ALLOW_STATUS`, `RETURN_INCLUDE_SHIPPING`, `CANCEL_FEE_PERCENT`, `CANCEL_FEE_FIXED`
- [ ] `STORE_BASE_URL`, `STORE_OG_IMAGE_URL`, `STORE_NAME_HE`, `STORE_NAME_AR`
- [ ] `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MINUTES`, `PASSWORD_RESET_EXPIRY_MINUTES`, `EMAIL_VERIFICATION_EXPIRY_MINUTES`
- [ ] Optional but recommended: `REQUIRE_TRANSACTIONS=true`, `LOG_LEVEL=info`, `STRIPE_CHECKOUT_STALE_MINUTES=15`

After setting these, your Render env is aligned with the server for full compatibility.
