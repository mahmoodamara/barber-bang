# تقرير نظام Gifts — توثيق للفرونت إند (مطابقة 100% مع السيرفر)

## 1. نظرة عامة

نظام الـ Gifts يسمح بمنح **هدايا مجانية** عند تطابق شروط (قيمة طلب، وجود منتج/تصنيف معيّن، ونافذة زمنية). الهدايا تُحسب في الـ **Quote** وتُضمَّن في **الطلبات** وتُخصم من **الستوك**. الفرونت يجب أن يعرض الهدايا في سلة/الخلاصة ويتعامل مع تحذيرات الستوك قبل إتمام الطلب.

---

## 2. المسارات (Base URL)

جميع مسارات الأدمن تحت:
- **`/api/v1/admin/gifts`**
- تتطلب مصادقة + صلاحية **`PROMOS_WRITE`**

---

## 3. نموذج Gift (للقائمة وجلب واحدة)

كل عنصر Gift من السيرفر يأتي بالشكل التالي (بعد `data` في الاستجابة):

| الحقل | النوع | مطلوب | الوصف |
|-------|--------|--------|--------|
| `_id` | string (ObjectId) | نعم | معرّف الهدية |
| `nameHe` | string | نعم | اسم عبري (2–160 حرف) |
| `nameAr` | string | لا | اسم عربي (حد أقصى 160) |
| `name` | string | لا | اسم legacy |
| `giftProductId` | string (ObjectId) | نعم | معرّف المنتج الممنوح كهدية |
| `giftVariantId` | string (ObjectId) أو null | لا | معرّف الـ variant إن كان المنتج له variants؛ إن غاب أو null = منتج بدون variant |
| `qty` | number | نعم | عدد الوحدات الممنوحة عند تطابق القاعدة (1–50، افتراضي 1) |
| `minOrderTotal` | number أو null | لا | حد أدنى لمجموع الطلب (قبل الشحن) بالشيكل؛ null = لا شرط |
| `requiredProductId` | string (ObjectId) أو null | لا | يشترط وجود هذا المنتج في السلة؛ null = لا شرط |
| `requiredCategoryId` | string (ObjectId) أو null | لا | يشترط وجود منتج من هذا التصنيف في السلة؛ null = لا شرط |
| `startAt` | string (ISO date) أو null | لا | بداية صلاحية القاعدة |
| `endAt` | string (ISO date) أو null | لا | نهاية صلاحية القاعدة |
| `isActive` | boolean | نعم | تفعيل/إلغاء القاعدة (افتراضي true) |
| `createdAt` | string (ISO date) | نعم | تاريخ الإنشاء |
| `updatedAt` | string (ISO date) | نعم | تاريخ آخر تحديث |

**منطق التطابق (كل الشروط معاً):**
- إن وُجد `minOrderTotal`: مجموع الطلب قبل الشحن ≥ القيمة.
- إن وُجد `requiredProductId`: المنتج موجود في عناصر السلة.
- إن وُجد `requiredCategoryId`: أحد عناصر السلة من هذا التصنيف.
- إن وُجدت `startAt`/`endAt`: الوقت الحالي ضمن النافذة.
- `isActive === true`.

---

## 4. واجهات الأدمن

### 4.1 قائمة الهدايا — GET `/api/v1/admin/gifts`

- **مصادقة:** نعم + `PROMOS_WRITE`.
- **استجابة ناجحة (200):**
```json
{
  "ok": true,
  "success": true,
  "data": [
    {
      "_id": "...",
      "nameHe": "...",
      "nameAr": "...",
      "name": "...",
      "giftProductId": "...",
      "giftVariantId": null,
      "qty": 1,
      "minOrderTotal": 199,
      "requiredProductId": null,
      "requiredCategoryId": null,
      "startAt": null,
      "endAt": null,
      "isActive": true,
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```
- الترتيب: الأحدث أولاً (`createdAt` تنازلي).

---

### 4.2 جلب هدية واحدة — GET `/api/v1/admin/gifts/:id`

- **Params:** `id` — ObjectId صالح.
- **استجابة:** 200 مع `data` = كائن Gift واحد، أو 404 مع `error.code === "NOT_FOUND"`.

---

### 4.3 إنشاء هدية — POST `/api/v1/admin/gifts`

**Body (JSON):**

| الحقل | مطلوب | النوع | القيود |
|-------|--------|--------|--------|
| `nameHe` | **نعم** | string | 2–160 حرف |
| `nameAr` | لا | string | حد أقصى 160 |
| `name` | لا | string | 2–160 (legacy) |
| `giftProductId` | **نعم** | string | ObjectId صالح |
| `giftVariantId` | لا | string أو null | ObjectId صالح إن وُجد |
| `qty` | لا | number | 1–50، افتراضي 1 |
| `minOrderTotal` | لا | number أو null | ≥ 0 |
| `requiredProductId` | لا | string أو null | ObjectId صالح |
| `requiredCategoryId` | لا | string أو null | ObjectId صالح |
| `startAt` | لا | string أو null | ISO 8601 datetime |
| `endAt` | لا | string أو null | ISO 8601 datetime |
| `isActive` | لا | boolean | افتراضي true |

- الـ schema **strict**: ممنوع إرسال حقول غير المذكورة.
- إذا `startAt` و `endAt` معاً: يجب أن يكون `startAt` قبل `endAt` (وإلا 400 `INVALID_DATE_RANGE`).
- **استجابة ناجحة:** 201 مع `data` = الهدية المُنشأة.

---

### 4.4 تحديث هدية — PUT أو PATCH `/api/v1/admin/gifts/:id`

- **Params:** `id` — ObjectId.
- **Body (JSON):** كل الحقول **اختيارية** (تحديث جزئي). نفس القيود والأنواع كما في الإنشاء.
- استجابة: 200 مع `data` = الهدية بعد التحديث، أو 404.

---

### 4.5 حذف هدية — DELETE `/api/v1/admin/gifts/:id`

- **Params:** `id` — ObjectId.
- استجابة ناجحة (200): `data: { deleted: true }`. عند عدم الوجود: 404.

---

## 5. الـ Quote والهدايا (للخلاصة/السلة)

الـ Quote يُستدعى عبر **POST `/api/v1/checkout/quote`** (مع مصادقة). الاستجابة تحتوي على:

- **`data.gifts`** (أو حسب هيكل الـ quote الذي يعيده السيرفر): مصفوفة الهدايا المطبقة.
- **`data.meta.giftWarnings`**: مصفوفة تحذيرات (ستوك، منتج غير موجود، إلخ).

### 5.1 شكل عنصر هدية في الـ Quote

كل عنصر في `quote.gifts`:

| الحقل | النوع | الوصف |
|-------|--------|--------|
| `productId` | string | ObjectId المنتج |
| `variantId` | string أو null | ObjectId الـ variant إن وُجد |
| `qty` | number | الكمية الممنوحة (بعد حد الستوك) |
| `titleHe` | string | عنوان عبري |
| `titleAr` | string | عنوان عربي |
| `source` | string | `"rule"` أو `"offer"` |

- الهدايا من قواعد Gift تأتي بـ `source: "rule"`؛ من العروض (مثل اشترِ X واحصل على Y) بـ `source: "offer"`.
- نفس المنتج+نفس الـ variant يُدمَج في عنصر واحد مع جمع الـ `qty`.

### 5.2 تحذيرات الهدايا — `meta.giftWarnings`

كل تحذير فيه على الأقل:

| الحقل | النوع | الوصف |
|-------|--------|--------|
| `type` | string | نوع التحذير (انظر الجدول أدناه) |
| `message` | string | رسالة للعرض |
| `productId` | string | معرّف المنتج (إن وُجد) |
| `variantId` | string | معرّف الـ variant (إن وُجد) |
| `titleHe` | string | عنوان المنتج (إن وُجد) |
| `requestedQty` | number | الكمية المطلوبة (إن وُجد) |
| `grantedQty` | number | الكمية الممنوحة (إن وُجد) |
| `availableStock` | number | الستوك المتاح (إن وُجد) |

**أنواع التحذيرات:**

| type | المعنى | إجراء الفرونت |
|------|--------|-----------------|
| `GIFT_OUT_OF_STOCK` | المنتج/الـ variant نفد من الستوك | **منع إتمام الطلب**؛ عرض الرسالة ومنع زر الدفع أو إظهار خطأ عند المحاولة |
| `GIFT_PARTIAL_STOCK` | الستوك أقل من المطلوب؛ تم منح جزء فقط | عرض تحذير (مثلاً: "الهدية محدودة إلى X وحدة")؛ الطلب مسموح |
| `GIFT_PRODUCT_NOT_FOUND` | منتج الهدية غير موجود أو غير نشط | اعتبار الهدية ملغاة في الواجهة |
| `GIFT_VARIANT_NOT_FOUND` | الـ variant المحدد غير موجود في المنتج | اعتبار الهدية ملغاة |

**مهم:** عند وجود أي تحذير من نوع **`GIFT_OUT_OF_STOCK`**، السيرفر يرفض **POST checkout/cod** و **إنشاء جلسة Stripe** ويعيد **400** مع:
```json
{
  "ok": false,
  "error": {
    "code": "GIFT_OUT_OF_STOCK",
    "message": "One or more gift items are out of stock",
    "details": [ /* مصفوفة تحذيرات GIFT_OUT_OF_STOCK */ ],
    "requestId": "...",
    "path": "..."
  }
}
```
الفرونت يجب أن يتحقق من `meta.giftWarnings` قبل إرسال الطلب، ويعرض رسالة واضحة ويُبطل الدفع عند وجود `GIFT_OUT_OF_STOCK`.

---

## 6. الطلب (Order) والهدايا

بعد إتمام الطلب (COD أو Stripe)، الطلب يُعاد أو يُجلب عبر واجهات الطلبات. كل طلب يحتوي على:

- **`items`**: عناصر السلة المدفوعة.
- **`gifts`**: عناصر الهدايا الممنوحة مع الطلب.

### 6.1 شكل عنصر هدية في الطلب

كل عنصر في `order.gifts`:

| الحقل | النوع | الوصف |
|-------|--------|--------|
| `productId` | string (ObjectId) | معرّف المنتج |
| `variantId` | string | معرّف الـ variant أو "" |
| `titleHe` | string | عنوان عبري |
| `titleAr` | string | عنوان عربي |
| `title` | string | عنوان حسب لغة الطلب |
| `qty` | number | الكمية (1–50) |

- الهدايا **لا تُسترد** قيمتها في المرتجعات (مجانية).

---

## 7. رموز الأخطاء (الأدمن والـ Checkout)

| HTTP | code | متى |
|------|------|-----|
| 400 | `VALIDATION_ERROR` | Body لا يطابق الـ schema (تفاصيل في `error.details`) |
| 400 | `INVALID_ID` | معرّف غير صالح (ObjectId) |
| 400 | `INVALID_DATE_RANGE` | startAt بعد endAt |
| 400 | `GIFT_OUT_OF_STOCK` | محاولة checkout مع هدية نفد ستوكها (مع `error.details`) |
| 404 | `NOT_FOUND` | هدية أو مورد غير موجود |
| 401/403 | — | مصادقة أو صلاحية ناقصة |

---

## 8. ملخص للمطابقة مع السيرفر

1. **Base:** أدمن الهدايا تحت `/api/v1/admin/gifts` مع صلاحية `PROMOS_WRITE`.
2. **إنشاء:** إرسال `nameHe` (مطلوب) و `giftProductId` (ObjectId صالح)؛ باقي الحقول حسب الحاجة مع الالتزام بالـ strict schema.
3. **ObjectIds:** `giftProductId`, `giftVariantId`, `requiredProductId`, `requiredCategoryId` يجب أن تكون قيم ObjectId صالحة (24 حرف hex).
4. **الـ Quote:** الاعتماد على `gifts` و `meta.giftWarnings`؛ منع إتمام الطلب عند وجود `GIFT_OUT_OF_STOCK` وعرض رسالة من `error.details` أو `meta.giftWarnings`.
5. **الطلب:** عرض `order.gifts` مع `items`؛ عدم احتساب الهدايا في مبلغ الاسترداد عند المرتجعات.
6. **التواريخ:** `startAt`/`endAt` بصيغة ISO 8601؛ التحقق من أن start قبل end عند الإرسال لتجنب 400.

بهذا يكون الفرونت متوافقاً مع نظام الـ Gifts في السيرفر بنسبة 100%.
