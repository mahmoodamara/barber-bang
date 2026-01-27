# Simple Shop v2 (Minimal Eƒ?'commerce API)

A simple, production-ish but **non-heavy** Node.js + Express + MongoDB e-commerce server.

ƒo. Shipping: DELIVERY / PICKUP_POINT / STORE_PICKUP
ƒo. Coupons
ƒo. Campaigns (automatic promotions)
ƒo. Gifts (free gift rules)
ƒo. Stripe Checkout + Webhook
ƒo. JWT Auth (register/login)

> Intentionally **no idempotency / queues / reservations** to keep it simple.

---

## 1) Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Server health:

```bash
GET http://localhost:4000/health
```

---

## 2) Main Endpoints

### Auth
- `POST /api/auth/register`
- `POST /api/auth/login`

### Products / Categories
- `GET /api/categories`
- `GET /api/products`
- `GET /api/products/:id`

### Cart (JWT)
- `GET /api/cart`
- `POST /api/cart/add`
- `POST /api/cart/set-qty`
- `POST /api/cart/remove`
- `POST /api/cart/clear`

### Shipping
- `GET /api/shipping/options`

### Coupon validate
- `GET /api/coupons/validate?code=SAVE20`

### Checkout (JWT)
- `POST /api/checkout/quote`
- `POST /api/checkout/cod`
- `POST /api/checkout/stripe`

### Orders (JWT)
- `GET /api/orders/me`
- `GET /api/orders/:id`

### Stripe Webhook
- `POST /api/stripe/webhook`

### Admin (JWT role=admin)
- Shipping CRUD: `/api/admin/delivery-areas`, `/api/admin/pickup-points`, `/api/admin/store-pickup`
- Coupons CRUD: `/api/admin/coupons`
- Campaigns CRUD: `/api/admin/campaigns`
- Gifts CRUD: `/api/admin/gifts`
- Orders admin list/update: `/api/admin/orders`

---

## 3) Notes

- Currency: ILS (major units in DB; Stripe uses minor units conversion internally)
- Stripe Webhook requires **raw body** (already handled)
- Stripe stock is decremented only when payment succeeds
- COD stock is decremented immediately on order creation
