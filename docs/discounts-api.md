# تقرير نظام التنزيلات — توثيق للفرونت إند (مطابقة 100%)

## 1. نظرة عامة

نظام التنزيلات يضم أربعة مكوّنات تُطبَّق بترتيب **ثابت** لا يتغيّر:

1. **קמפיינים (Campaigns)** — حملة واحدة (خصم نسبة أو مبلغ ثابت على جزء من السلة أو كلها)
2. **קופונים (Coupons)** — كوبون واحد (كود مستخدم يدخله؛ خصم على المبلغ بعد الحملة)
3. **הצעות (Offers)** — عروض (نسبة، مبلغ، شحن مجاني، أو هدية اشترِ X واحصل على Y)؛ يمكن تطبيق عدة عروض حسب `stackable`
4. **מתנות (Gifts)** — هدايا من قواعد (Gift) + هدايا من العروض (BUY_X_GET_Y)

**ترتيب الحساب في السيرفر (لا تغيير دون تحديث الوثائق):**

```
المجموع الفرعي (subtotal) من عناصر السلة
    → خصم الحملة (campaign)
    → خصم الكوبون (coupon) على المبلغ بعد الحملة
    → خصم العروض (offer) على المبلغ بعد الكوبون
    → هدايا (gifts) تُحسب على المجموع قبل الشحن بعد كل الخصومات
    → + رسوم الشحن (أو 0 إن كان عرض شحن مجاني)
    → المجموع النهائي (مع ض.ق.م إن وُجد)
```

الفرونت يعتمد على **استجابة الـ Quote** كمصدر وحيد للحقيقة؛ لا يعيد حساب الخصومات محلياً.

---

## 2. الـ Quote — مصدر الحقيقة للأسعار والتنزيلات

### 2.1 طلب الـ Quote

**POST** `/api/v1/checkout/quote`

- **مصادقة:** مطلوبة (مستخدم مسجّل).
- **Body (JSON):**

| الحقل | النوع | مطلوب | الوصف |
|-------|--------|--------|--------|
| `shippingMode` | string | نعم | `"DELIVERY"` \| `"PICKUP_POINT"` \| `"STORE_PICKUP"` |
| `deliveryAreaId` | string | شرطي | مطلوب عند `shippingMode === "DELIVERY"` |
| `pickupPointId` | string | شرطي | مطلوب عند `shippingMode === "PICKUP_POINT"` |
| `address` | object | شرطي | مطلوب عند `DELIVERY`؛ حقول: `fullName`, `phone`, `city`, `street` (إلزامية)، `building`, `floor`, `apartment`, `entrance`, `notes` (اختيارية) |
| `couponCode` | string | لا | كود الكوبون (حد أقصى 40 حرف) |

- السيرفر يبني السلة من المستخدم الحالي؛ لا يُرسل عناصر السلة في الـ body.

### 2.2 استجابة الـ Quote (الشكل الكامل)

**نجاح (200):** `{ ok: true, success: true, data: quote }`

حيث `data` (الـ quote) بالشكل التالي:

| الحقل | النوع | الوصف |
|-------|--------|--------|
| `subtotal` | number | المجموع الفرعي (شيكل) |
| `shippingFee` | number | رسوم الشحن (شيكل) |
| `discounts` | object | تفصيل الخصومات (شيكل) |
| `discounts.coupon` | object | `{ code: string \| null, amount: number }` |
| `discounts.campaign` | object | `{ amount: number }` |
| `discounts.offer` | object | `{ amount: number }` |
| `gifts` | array | قائمة الهدايا المطبقة (انظر أدناه) |
| `total` | number | المجموع النهائي (شيكل) |
| `vatRate` | number | معدل ض.ق.م (مثلاً 0.18) |
| `vatIncludedInPrices` | boolean | هل الأسعار شاملة ض.ق.م |
| `vatAmount` | number | مبلغ ض.ق.م |
| `totalBeforeVat` / `totalAfterVat` | number | للمعلومات المحاسبية |
| `items` | array | عناصر السلة (مع unitPrice, qty, lineTotal, titleHe, titleAr, productId, variantId, categoryId, إلخ) |
| `meta` | object | بيانات إضافية للعرض والتحذيرات (انظر 2.3) |

**أيضاً:** حقول بصيغة minor (أغوروت) مثل `subtotalMinor`, `shippingFeeMinor`, `discountsMinor.coupon.amount`, `totalMinor`, `vatAmountMinor`, إلخ — للاستخدام الداخلي أو دفع Stripe.

### 2.3 كائن `meta` — التحذيرات والشفافية

| الحقل | النوع | الوصف |
|-------|--------|--------|
| `meta.shippingFeeBase` | number | رسوم الشحن الأساسية قبل أي خصم |
| `meta.freeShipping` | boolean | هل طُبّق عرض شحن مجاني |
| `meta.campaignId` | string \| null | معرّف الحملة المطبقة |
| `meta.campaignName` | string \| null | اسم الحملة (للعرض) |
| `meta.appliedOffers` | array | العروض المطبقة (انظر 2.4) |
| `meta.giftWarnings` | array | تحذيرات الهدايا (نفاد ستوك، جزئي، منتج غير موجود — انظر 2.5) |
| `meta.couponAvailability` | object | **يظهر فقط عند إرسال `couponCode`** (انظر 2.6) |

### 2.4 شكل عنصر في `meta.appliedOffers`

كل عنصر:

| الحقل | النوع | الوصف |
|-------|--------|--------|
| `offerId` | string | معرّف العرض |
| `type` | string | `"PERCENT_OFF"` \| `"FIXED_OFF"` \| `"FREE_SHIPPING"` \| `"BUY_X_GET_Y"` |
| `nameHe` / `nameAr` | string | اسم العرض |
| `discount` | number | مبلغ الخصم (شيكل)؛ 0 للشحن المجاني و BUY_X_GET_Y |
| `value` | number | اختياري؛ نسبة أو مبلغ حسب النوع |
| `giftProductId` / `giftVariantId` / `giftQty` | — | موجودة لـ BUY_X_GET_Y |

### 2.5 تحذيرات الهدايا — `meta.giftWarnings`

مصفوفة تحذيرات؛ كل عنصر فيه على الأقل:

- `type`: `"GIFT_OUT_OF_STOCK"` \| `"GIFT_PARTIAL_STOCK"` \| `"GIFT_PRODUCT_NOT_FOUND"` \| `"GIFT_VARIANT_NOT_FOUND"`
- `message`: رسالة للعرض
- `productId`, `variantId`, `titleHe`, `requestedQty`, `grantedQty`, `availableStock` (حسب النوع)

**إجراء الفرونت إلزامي:**

- إذا وُجد أي تحذير من نوع **`GIFT_OUT_OF_STOCK`** → **منع إتمام الطلب** (تعطيل زر الدفع أو عرض رسالة واضحة). السيرفر سيرفض بدوره **POST /checkout/cod** و **POST /checkout/stripe** ويعيد **400** مع `error.code === "GIFT_OUT_OF_STOCK"`.
- `GIFT_PARTIAL_STOCK`: عرض تحذير فقط؛ الطلب مسموح.
- `GIFT_PRODUCT_NOT_FOUND` / `GIFT_VARIANT_NOT_FOUND`: اعتبار الهدية ملغاة في الواجهة.

### 2.6 توفر الكوبون — `meta.couponAvailability`

يظهر **فقط عندما يُرسل المستخدم `couponCode`** في طلب الـ Quote.

| الشكل | المعنى |
|-------|--------|
| `{ available: true }` | الكوبون يمكن حجزه عند الدفع (حد الاستخدام العام ولم يبلغ المستخدم حد الاستخدام الشخصي) |
| `{ available: false, reason: "limit_reached" }` | بلغ الاستخدام العام للكوبون (أو الحجوزات) الحد الأقصى |
| `{ available: false, reason: "user_limit_reached" }` | المستخدم الحالي استخدم الكوبون بعدد مرات يبلغ الحد المسموح له |

**توصية الفرونت:** عند `available === false` عرض تحذير (مثلاً: "قد لا يكون الكوبون متاحاً عند إتمام الطلب") وعدم منع الدفع؛ الحجز الفعلي يحدث عند بدء الدفع وقد يتغيّر الوضع.

### 2.7 شكل عنصر هدية في `data.gifts`

| الحقل | النوع | الوصف |
|-------|--------|--------|
| `productId` | string | معرّف المنتج |
| `variantId` | string \| null | معرّف الـ variant أو null |
| `qty` | number | الكمية الممنوحة |
| `titleHe` / `titleAr` | string | عنوان المنتج |
| `source` | string | `"rule"` (قاعدة هدية) أو `"offer"` (عرض BUY_X_GET_Y) |

---

## 3. الطلب (Checkout) واستخدام الـ Quote

- **POST /api/v1/checkout/cod** و **POST /api/v1/checkout/stripe** يستخدمان **نفس الـ body** مثل الـ Quote (shippingMode, deliveryAreaId/pickupPointId/address, couponCode).
- يجب إرسال **نفس القيم** التي حصل عليها المستخدم من آخر Quote (أو إعادة استدعاء Quote قبل الدفع) حتى لا يختلف المجموع أو الهدايا.
- إذا وُجد `GIFT_OUT_OF_STOCK` في الـ Quote الذي يُبنى عليه الطلب، السيرفر يعيد **400** مع:
  - `error.code === "GIFT_OUT_OF_STOCK"`
  - `error.message`: "One or more gift items are out of stock"
  - `error.details`: مصفوفة تحذيرات من نفس النوع

الفرونت يجب أن يتحقق من `meta.giftWarnings` قبل إرسال الطلب ويُبطل الدفع عند وجود `GIFT_OUT_OF_STOCK`.

---

## 4. الطلب (Order) بعد الإتمام

- الطلب المُعاد أو المُجلب يحتوي على:
  - **`pricing`**: نفس هيكل الخصومات (subtotal, shippingFee, discounts.coupon/campaign/offer, total, vatRate, إلخ).
  - **`items`**: عناصر السلة المدفوعة.
  - **`gifts`**: الهدايا الممنوحة مع الطلب (شكل كل عنصر: productId, variantId, titleHe, titleAr, title, qty).

الهدايا لا تُسترد قيمتها في المرتجعات (مجانية). للتفاصيل انظر [docs/gifts-api.md](gifts-api.md).

---

## 5. مسارات الأدمن (مرجع سريع)

جميعها تحت **`/api/v1/admin`** مع مصادقة وصلاحية **`PROMOS_WRITE`**.

| المورد | المسارات | ملاحظة |
|--------|----------|--------|
| **Campaigns** | GET/POST `/campaigns`, GET/PUT/PATCH/DELETE `/campaigns/:id` | حملة واحدة تُطبَّق لكل طلب؛ نوع percent/fixed؛ استهداف all/products/categories؛ priority |
| **Coupons** | GET/POST `/coupons`, GET/PUT/PATCH/DELETE `/coupons/:id` | كود فريد؛ نوع percent/fixed؛ minOrderTotal؛ usageLimit؛ usagePerUser |
| **Offers** | GET/POST `/offers`, GET/PUT/PATCH/DELETE `/offers/:id` | أنواع: PERCENT_OFF, FIXED_OFF, FREE_SHIPPING, BUY_X_GET_Y؛ stackable؛ priority؛ استهداف productIds/categoryIds |
| **Gifts** | GET/POST `/gifts`, GET `/gifts/:id`, PUT/PATCH/DELETE `/gifts/:id` | قواعد هدايا (minOrderTotal، منتج/تصنيف مطلوب، giftProductId، giftVariantId، qty) — تفاصيل كاملة في [docs/gifts-api.md](gifts-api.md) |

استجابة الأدمن الموحدة: `{ ok: true, success: true, data: ... }` أو عند الخطأ `{ ok: false, error: { code, message, requestId, path, details? } }`.

---

## 6. رموز الأخطاء ذات الصلة بالتنزيلات والـ Checkout

| HTTP | code | متى |
|------|------|-----|
| 400 | `VALIDATION_ERROR` | body الـ quote/checkout لا يطابق الـ schema (تفاصيل في `error.details`) |
| 400 | `GIFT_OUT_OF_STOCK` | محاولة إتمام طلب والهدايا فيها منتج نفد ستوكه |
| 400 | `COUPON_LIMIT_REACHED` | حجز كوبون عند الدفع وبلغ الحد العام |
| 400 | `COUPON_USER_LIMIT_REACHED` | حجز كوبون وبلغ المستخدم حد الاستخدام الشخصي |
| 400 | `COUPON_NOT_FOUND` / `COUPON_INACTIVE` / `COUPON_EXPIRED` | عند حجز الكوبون |
| 404 | `NOT_FOUND` | مورد أدمن غير موجود |
| 401/403 | — | مصادقة أو صلاحية ناقصة |

---

## 7. ملخص للمطابقة 100% مع السيرفر

1. **مصدر الحقيقة:** استخدام **استجابة POST /checkout/quote** فقط لعرض الأسعار والخصومات والهدايا؛ عدم إعادة الحساب في الفرونت.
2. **ترتيب العرض:** عرض الخصومات والهدايا كما يرد في `discounts` و `meta.appliedOffers` و `gifts`؛ الترتيب الثابت في السيرفر: حملة → كوبون → عروض → هدايا.
3. **منع الدفع:** عند وجود أي عنصر في `meta.giftWarnings` من نوع `GIFT_OUT_OF_STOCK` → منع إتمام الطلب وعرض رسالة واضحة.
4. **تحذير الكوبون:** عند وجود `meta.couponAvailability` و `available === false` → عرض تحذير (بدون منع الدفع إن رغبت).
5. **إرسال الطلب:** استخدام نفس الـ body (shippingMode, عنوان/نقطة استلام، couponCode) المطابق لآخر Quote.
6. **الطلب المُنجز:** عرض `order.pricing` و `order.items` و `order.gifts` كما يُعاد من الـ API؛ الهدايا غير مشمولة في مبلغ الاسترداد.

بهذا يكون الفرونت متوافقاً مع نظام التنزيلات (קופונים, הצעות, קמפיינים, מתנות) في السيرفر بنسبة 100%.
