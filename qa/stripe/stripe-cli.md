# Stripe Webhook QA (real signature replay)

These steps validate **signature verification (raw body)** + **idempotency** using real Stripe-signed events.

## 1) Start server locally
Set env:
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET` (will be shown by Stripe CLI)
- `NODE_ENV=development` or `production` (test both)

Start:
```bash
npm run dev
# or
node server.js
```

## 2) Stripe CLI login and listen
```bash
stripe login
stripe listen --forward-to localhost:4000/api/stripe/webhook
```
Copy the printed `whsec_...` into `STRIPE_WEBHOOK_SECRET`.

## 3) Trigger events
### Checkout session completed
If you create sessions from your API, run a real test checkout.
If you just want to replay a fixture event:
```bash
stripe trigger checkout.session.completed
```

### Async payment succeeded/failed
```bash
stripe trigger checkout.session.async_payment_succeeded
stripe trigger checkout.session.async_payment_failed
```

## 4) Idempotency checks
Re-send the same event payload multiple times (Stripe CLI will do this if you replay from logs).
Your expectations:
- stock confirmations happen once
- coupon redemption happens once
- invoice issuance happens once (invoice status should become issuing -> issued)
- payment ledger has **unique** row per eventId/transactionId

## 5) Crash-window regression
Manually simulate:
1) Create order + Stripe session
2) Kill the server before it persists `stripe.sessionId`
3) Complete payment
4) Start server and replay webhook
Expected: server finds order via `session.metadata.orderId` fallback and completes flow.
