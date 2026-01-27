# AUDIT_REPORT

## Checks

1. ✅ PASS: checkout/quote has no reservation cleanup

- `src/routes/checkout.routes.js:269`

```js
269:    const b = req.validated.body;
271:    const quote = await quotePricing({
```

2. ✅ PASS: quotePricing is used by COD + Stripe

- `src/routes/checkout.routes.js:310`

```js
310:    const shipping = toShippingInput(b);
312:    const quote = await quotePricing({
```

- `src/routes/checkout.routes.js:485`

```js
485:    const shipping = toShippingInput(b);
487:    const quote = await quotePricing({
```

3. ✅ PASS: VAT fields return major units (fromMinor)

- `src/services/pricing.service.js:442`

```js
442:    vatAmount: fromMinor(vatAmountMinor),
443:    totalBeforeVat: fromMinor(totalBeforeVatMinor),
444:    totalAfterVat: fromMinor(totalAfterVatMinor),
```

4. ✅ PASS: webhook has pending_payment gate + lock transition + cart $pull ObjectId/string safe

- `src/routes/stripe.webhook.routes.js:208`

```js
208:     * Only process when the order is still pending_payment.
209:     */
210:    if (order.status !== "pending_payment") return safe200(res);
```

- `src/routes/stripe.webhook.routes.js:247`

```js
247:        _id: order._id,
248:        status: "pending_payment",
249:        paymentMethod: "stripe",
```

- `src/routes/stripe.webhook.routes.js:157`

```js
157:  const objIds = ids
158:    .filter((id) => mongoose.Types.ObjectId.isValid(id))
159:    .map((id) => new mongoose.Types.ObjectId(id));
```

- `src/routes/stripe.webhook.routes.js:165`

```js
165:  await User.updateOne(
166:    { _id: userId },
167:    { $pull: { cart: { productId: { $in: inList } } } }
```

5. ✅ PASS: Order status enum matches admin Zod enum

- `src/models/Order.js:313`

```js
313:    status: {
314:      type: String,
315:      enum: [
```

- `src/routes/admin.routes.js:871`

```js
871:      params: z.object({ id: z.string().min(1) }),
872:      body: z.object({
873:        status: z.enum([
```

6. ✅ PASS: .env.example contains all env vars referenced in code (missing: none)

- `./.env.example:3`

```env
3:MONGO_URI=mongodb://127.0.0.1:27017/simple_shop_v2
5:JWT_SECRET=super_secret_change_me
```

7. ✅ PASS: /api/v1 is documented as canonical (legacy /api deprecated)

- `README.md:32`

```md
32:## 2) Main Endpoints
34:Use `/api/v1/*` for all client calls. Legacy `/api/*` routes remain for backward compatibility and are deprecated.
```

8. ✅ PASS: Stripe webhook does not finalize order without valid reservation

- `src/routes/stripe.webhook.routes.js:235`

```js
235:    const reservation = await confirmStockReservation({ orderId: order._id, now });
236:    if (!reservation) {
237:      await markReservationInvalidAndRefund(order, paymentIntentId);
```

9. ✅ PASS: COD confirms reservation before completing order

- `src/routes/checkout.routes.js:386`

```js
386:    const confirmed = await confirmStockReservation({ orderId, session });
387:    if (!confirmed) {
388:      throw makeErr(409, "RESERVATION_INVALID", "Stock reservation expired or invalid");
```

10. ✅ PASS: Returns routes mounted for customer + admin

- `src/app.js:223`

```js
223:app.use("/api/v1/orders", ordersRoutes);
224:app.use("/api/v1/returns", returnsRoutes);
232:app.use("/api/v1/admin/returns", adminReturnsRoutes);
```

11. ✅ PASS: Success envelope normalizes array payloads to object

- `src/app.js:60`

```js
60:  res.json = (payload) => {
61:    if (payload && payload.ok === true && Array.isArray(payload.data)) {
62:      return originalJson({ ...payload, data: { items: payload.data } });
```

12. ✅ PASS: Text search uses MongoDB $text

- `src/routes/products.routes.js:143`

```js
143:    // Text search (uses text index)
144:    if (q) {
145:      filter.$text = { $search: q };
```

13. ✅ PASS: Audit logging includes actorId/requestId/entity/action/IP

- `src/middleware/audit.js:60`

```js
60:        actorId,
67:        requestId: getRequestId(req),
68:        ip: req.ip || "",
```
