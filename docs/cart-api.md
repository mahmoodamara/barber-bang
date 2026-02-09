# Cart API

## Overview

The cart system supports both authenticated users and guests. Authenticated carts are stored in the user document; guest carts are stored in a separate collection with a TTL of 30 days.

## Authenticated Cart (requires JWT)

- `GET /api/cart` - Get cart
- `POST /api/cart/add` - Add item
- `POST /api/cart/set-qty` - Update quantity
- `POST /api/cart/remove` - Remove item
- `POST /api/cart/clear` - Clear cart

### Add to Cart

**Body:**
- `productId` (required)
- `qty` (required, 1-999)
- `variantId` (optional, required for products with variants)
- `idempotent` (optional): If true, sets qty instead of adding (prevents double-add on auth redirect)
- `validateStock` (optional): If true, rejects add when product is out of stock or qty exceeds available stock

### Remove from Cart

For products with variants, `variantId` is **required** when removing a specific variant. Omitting it returns `VARIANT_REQUIRED`.

---

## Guest Cart (no auth required)

**Identification:** Use cookie `guest_cart_id` (set automatically on first add) or header `x-guest-cart-id`.

- `GET /api/cart/guest` - Get guest cart
- `POST /api/cart/guest/add` - Add item (creates cart if needed)
- `POST /api/cart/guest/set-qty` - Update quantity
- `POST /api/cart/guest/remove` - Remove item
- `POST /api/cart/guest/clear` - Clear cart

**Add body:** `productId`, `qty`, `variantId` (optional), `guestCartId` (optional, if not using cookie/header)

**Response:** All guest endpoints return `{ ok, data, cartId }`. Store `cartId` for subsequent requests if not using cookies.

---

## Merge on Login

When logging in, send `guestCartId` in the login body to merge the guest cart into the user cart:

```json
POST /api/auth/login
{
  "email": "...",
  "password": "...",
  "guestCartId": "uuid-from-guest-cart"
}
```

On success, the response includes `cartMerged` (number of items merged) when applicable.
