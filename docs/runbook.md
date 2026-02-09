# Runbook

On-call operational guide for this service. Keep this document updated when failure modes or metrics change.

## Monitoring & Dashboards

Dashboards should include these panels. Metrics are Prometheus counters/histograms as implemented in the service.

### HTTP latency
- http_request_duration_p95 (derived from http_request_duration_seconds)
  - Query: histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))
  - Why: user-visible responsiveness and upstream timeouts.
  - Baseline: p95 < 300ms steady; p99 < 800ms.
- http_request_duration_p99 (derived from http_request_duration_seconds)
  - Query: histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))
  - Why: tail latency and saturation signal.

### Stripe & checkout
- webhook_failures_total (derive from webhook_events_total{status="error"})
  - Why: payment completion and order finalization health.
  - Baseline: near zero; occasional single failures are acceptable if retries succeed.
- webhook_retries_total (derive from webhook_events_total{status="retry"})
  - Why: detect unstable webhook processing or slow handlers.
  - Baseline: low and stable; spikes indicate timeouts or crashes.
- checkout_failures_total
  - Why: user checkout stability and payment funnel health.
  - Baseline: < 1% of checkout attempts.

### Billing & finance
- refund_operations_total
  - Why: fraud/stock issues and refund volume monitoring.
  - Baseline: stable, low variance; spikes indicate a bug or operational issue.
- invoice_issue_total
  - Why: billing reliability and provider issues.
  - Baseline: failures should be rare; retries should converge to success.

### Order health
- Paid but unconfirmed orders count
  - Query (Mongo): db.orders.countDocuments({ status: "paid", "webhook.processedAt": null })
  - Why: crash-window or webhook processing gaps.
- Invoice failed orders count
  - Query (Mongo): db.orders.countDocuments({ "invoice.status": "failed" })
  - Why: customer invoice delivery gaps.
- Coupon reservation leaks
  - Query (Mongo): db.couponreservations.countDocuments({ status: "reserved", expiresAt: { $lt: new Date() } })
  - Why: drift in Coupon.reservedCount and blocked redemptions.

## Alerting Thresholds

Tune with real traffic after first week of production.

- Webhook failures: webhook_events_total{status="error"} / webhook_events_total{status="received"} > 2% for 10m.
- Webhook retries: increase(webhook_events_total{status="retry"}[10m]) > 20.
- Checkout failures: rate(checkout_failures_total[10m]) > 5/min for 10m OR > 2% of checkout requests.
- Invoice issue failures: increase(invoice_issue_total{status="failure"}[15m]) > 5.
- Stuck paid orders: count of paid but unconfirmed orders > 0 for 10m.
- Coupon reservation leaks: reserved-and-expired reservations count increasing for > 30m.
- Refund spike: refund_operations_total{status="success"} > 3x baseline for 15m.

## Reconciliation & Recovery Queries

Use these queries to find broken states quickly.

- Stuck paid orders:
  - db.orders.find({ status: "paid", "webhook.processedAt": null, updatedAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) } })
- Failed invoices:
  - db.orders.find({ "invoice.status": "failed" })
- Coupon reservations stuck:
  - db.couponreservations.find({ status: "reserved", expiresAt: { $lt: new Date() } })
- Webhook events received but not finalized:
  - db.stripewebhookevents.find({ status: { $ne: "processed" }, createdAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) } })

## Failure Scenarios & Recovery Procedures

### 1) Stuck orders (status = paid but not confirmed)
Detection:
- Metric: paid-but-unconfirmed count > 0.
- Logs: [stripe.webhook] errors around the payment time.
Immediate mitigation:
- Ensure Stripe webhooks are arriving (Stripe dashboard).
- Check service health, DB connectivity, and error logs.
Recovery:
1) Re-send the Stripe event from Stripe dashboard.
2) If replay not possible, re-trigger webhook handler using the exact sessionId.
3) Verify order has webhook.processedAt set and status moved to confirmed.
Verification:
- Order status is confirmed (or later), webhook.processedAt is non-null, no duplicate payments.

### 2) Invoice failures (invoice.status = failed)
Detection:
- Metric: invoice_issue_total{status="failure"} increasing.
- Query: db.orders.find({ "invoice.status": "failed" }).limit(20)
Immediate mitigation:
- Check provider status and credentials.
- If provider outage, switch to manual or none temporarily.
Recovery:
1) Fix provider availability/credentials.
2) Re-run invoice retry job.
3) Spot-check new invoices on affected orders.
Verification:
- invoice.status becomes issued, invoice_issue_total{status="success"} increases.

### 3) Coupon reservation leaks
Detection:
- Query: reserved reservations with expiresAt < now.
- Compare Coupon.reservedCount vs active reservations count.
Immediate mitigation:
- Run reservation repair job if enabled.
Recovery:
1) Let expiry job transition reserved -> expired.
2) Verify Coupon.reservedCount decremented.
Verification:
- No reserved entries past expiresAt; reservedCount aligns with active reservations.

### 4) Stripe webhook retries / partial processing
Detection:
- webhook_events_total{status="error"} spikes.
- Webhook event records with status != processed.
Immediate mitigation:
- Confirm STRIPE_WEBHOOK_SECRET.
- Inspect error logs with stripeEventId and orderId.
Recovery:
1) Re-send Stripe events for failed deliveries.
2) Verify order webhook.processedAt is set after successful processing.
Verification:
- webhook failures drop; paid orders finalize.

### 5) Manual reconciliation scenarios
Detection:
- Customer reports missing confirmation or invoice.
- Payment ledger exists but order not confirmed.
Recovery:
1) Identify order by paymentIntentId or sessionId.
2) Validate payment amount and stock reservation state.
3) Re-send Stripe event if order is not finalized.
Verification:
- Order is confirmed, invoice issued (or manual), and customer notified.

### 6) Admin media upload: 401 Unauthorized
Detection:
- Frontend reports 401 on `POST /api/v1/admin/media/upload`.
- Browser console or network tab shows 401 before request body is sent.
Recovery:
1) Ensure the upload request sends the same auth as other admin calls: `Authorization: Bearer <access_token>`.
2) If using a separate upload client (e.g. axios instance), attach the token from auth context.
3) Confirm token is not expired; refresh and retry if needed.
Verification:
- Upload request returns 201 with asset data, or a non-401 error (e.g. 413, 503).

### 7) Admin media upload: Cloudinary "Invalid Signature"
Detection:
- API returns `CLOUDINARY_ERROR` with message like "Invalid Signature ... String to sign - 'folder=...&timestamp=...'".
- Upload works locally but fails on deployment (e.g. Render).
Recovery:
1) Get the **exact** API Secret from Cloudinary Dashboard: **Settings** → **API Keys** → copy "API Secret" (not Cloud Name or API Key).
2) In the **deployment** environment (e.g. Render → Environment), set `CLOUDINARY_API_SECRET` to that value. Ensure no leading/trailing spaces or line breaks.
3) If the secret was rotated in Cloudinary, update it in the deployment env and redeploy.
4) Save changes so the service redeploys and loads the new secret.
Verification:
- Ensure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` on Render all match the Cloudinary Dashboard. Upload an image via admin media; response is 201 and the asset appears in Cloudinary.

Full checklist: [docs/cloudinary-invalid-signature.md](cloudinary-invalid-signature.md).

### 8) Bootstrap failed: Invalid scheme (MONGO_URI)
Detection:
- Deploy fails on Render with "Bootstrap failed" and error: `Invalid scheme, expected connection string to start with "mongodb://" or "mongodb+srv://"`.
- Or app throws: `MONGO_URI must start with "mongodb://" or "mongodb+srv://"...`
Recovery:
1) In Render Dashboard → your service → **Environment**, check `MONGO_URI`.
2) Ensure it is set to a full connection string that **starts with** `mongodb+srv://` (Atlas) or `mongodb://` (self-hosted). No placeholder (e.g. `CHANGE_ME_MONGO_URI`), no extra quotes, no leading/trailing spaces.
3) For MongoDB Atlas: copy the connection string from Atlas → Cluster → Connect → "Connect your application" (Node.js driver, 5.5 or later). It should look like `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/<db>?retryWrites=true&w=majority`.
4) Save environment and let Render redeploy.
Verification:
- Deploy completes; logs show "[db] connected" and the service stays up.

## Operational Principles

- Retries are safe only when webhook.processedAt is null.
- Never retry on amount verification failure; treat as potential fraud.
- Do not mark paid as finalized; confirmed is the finalization state.
- Prefer Stripe event replay over manual DB edits.
- Manual edits must preserve idempotency keys and be recorded in internal notes.
- Avoid bulk updates; operate on single orders with clear audit trail.

