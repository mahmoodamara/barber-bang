# تقرير تكامل الفرونت إند مع نظام السلة الجديد

## نظرة عامة

تم تطوير نظام سلة جديد على السيرفر يتضمن:
- سلة للمستخدم المسجّل (يتطلب JWT)
- سلة للزائر (بدون تسجيل دخول)
- دمج السلة عند تسجيل الدخول
- تحسينات في التحقق من المخزون والحذف

هذا التقرير يوجّه فريق الفرونت إند لتهيئة التطبيق ليكون متوافقاً مع التغييرات.

---

## 1. الهيكل الموحد للاستجابة

### استجابة نجاح السلة (Authenticated و Guest)

```typescript
// GET /api/cart  أو  GET /api/cart/guest
{
  "ok": true,
  "data": CartItem[]
}
```

### هيكل CartItem (عنصر السلة)

```typescript
interface CartItem {
  product: {
    _id: string;
    id: string;
    title: string;           // حسب اللغة
    titleHe: string;
    titleAr: string;
    price: number;
    priceMinor: number;
    imageUrl: string;
    mainImage: string;
    images: ProductImage[];
    stock: number;
    categoryId: string | null;
    slug: string;
    sale: {
      salePrice: number;
      salePriceMinor: number;
      saleStartAt: string | null;
      saleEndAt: string | null;
    } | null;
  };
  qty: number;
  variantId: string;         // "" للمنتجات بدون فاريانت
  variantSnapshot: {
    variantId: string;
    sku: string;
    price: number;
    priceMinor: number;
    attributesList: Array<{key, type, value, valueKey, unit}>;
    attributes: { volumeMl, weightG, packCount, scent, holdLevel, ... };
  } | null;

  // حقول محسوبة من السيرفر - استخدمها للعرض
  currentUnitPrice: number;
  currentUnitPriceMinor: number;
  currentStock: number;
  isAvailable: boolean;
  lineTotal: number;
  lineTotalMinor: number;
}
```

**ملاحظة:** استخدم `currentStock` و `isAvailable` لعرض حالة التوفر، و`currentUnitPrice` و`lineTotal` للتسعير الحالي.

---

## 2. مسارات السلة للمستخدم المسجّل

| الطريقة | المسار | الوصف |
|---------|--------|--------|
| GET | `/api/cart` | جلب السلة |
| POST | `/api/cart/add` | إضافة عنصر |
| POST | `/api/cart/set-qty` | تحديث الكمية |
| POST | `/api/cart/remove` | حذف عنصر |
| POST | `/api/cart/clear` | تفريغ السلة |

**المتطلبات:** جميع المسارات تتطلب header:
```
Authorization: Bearer <JWT>
```

### POST /api/cart/add

**Body:**
```json
{
  "productId": "string",
  "qty": 1,
  "variantId": "string (اختياري، مطلوب للمنتجات ذات الفاريانت)",
  "idempotent": false,
  "validateStock": false
}
```

| الحقل | النوع | مطلوب | الوصف |
|-------|-------|-------|--------|
| productId | string | نعم | معرف المنتج |
| qty | number | نعم | 1–999 |
| variantId | string | للمنتجات ذات الفاريانت | معرف الفاريانت |
| idempotent | boolean | لا | عند true يُحدّث الكمية بدلاً من الإضافة (لتجنب الإضافة المزدوجة بعد إعادة التوجيه) |
| validateStock | boolean | لا | عند true يرفض الإضافة إذا المنتج غير متوفر أو الكمية أكبر من المخزون |

**متى تستخدم idempotent:** عند إعادة توجيه المستخدم من صفحة منتج إلى تسجيل الدخول ثم العودة، قد يُرسل طلب إضافة ثاني. استخدم `idempotent: true` في هذه الحالة لتحديث الكمية فقط.

### POST /api/cart/set-qty

**Body:**
```json
{
  "productId": "string",
  "qty": 1,
  "variantId": "string (اختياري، مطلوب للمنتجات ذات الفاريانت)"
}
```

### POST /api/cart/remove

**Body:**
```json
{
  "productId": "string",
  "variantId": "string (مطلوب للمنتجات ذات الفاريانت)"
}
```

**تغيير مهم:** للمنتجات ذات الفاريانت، إرسال `variantId` أصبح **ضرورياً**. بدون إرساله سيُرجع السيرفر خطأ `VARIANT_REQUIRED`.

---

## 3. مسارات سلة الزائر

| الطريقة | المسار | الوصف |
|---------|--------|--------|
| GET | `/api/cart/guest` | جلب سلة الزائر |
| POST | `/api/cart/guest/add` | إضافة عنصر |
| POST | `/api/cart/guest/set-qty` | تحديث الكمية |
| POST | `/api/cart/guest/remove` | حذف عنصر |
| POST | `/api/cart/guest/clear` | تفريغ السلة |

**لا يتطلب JWT** – يعتمد على معرف السلة.

### تعريف سلة الزائر

- **Cookie:** `guest_cart_id` (يُضبط تلقائياً عند أول إضافة)
- **Header:** `x-guest-cart-id`

**استجابة سلة الزائر:**
```json
{
  "ok": true,
  "data": CartItem[],
  "cartId": "uuid-string"
}
```

يُنصح بتخزين `cartId` في localStorage إذا لم تُستَخدَم الكوكيز (مثلاً في SPA).

### POST /api/cart/guest/add

**Body:**
```json
{
  "productId": "string",
  "qty": 1,
  "variantId": "string (اختياري)",
  "guestCartId": "string (اختياري - إذا لم تستخدم cookie/header)"
}
```

---

## 4. دمج السلة عند تسجيل الدخول

**POST /api/auth/login**

**Body:**
```json
{
  "email": "string",
  "password": "string",
  "guestCartId": "string (اختياري)"
}
```

**استجابة عند دمج السلة:**
```json
{
  "ok": true,
  "success": true,
  "data": {
    "token": "...",
    "user": { "id", "name", "email", "role" },
    "cartMerged": 3
  }
}
```

**ملاحظة:** احفظ `guestCartId` (من localStorage أو cookie) قبل تسجيل الدخول وأرسله في طلب login للدمج التلقائي.

---

## 5. رموز الأخطاء الجديدة

| الكود | HTTP | الوصف |
|-------|------|--------|
| VARIANT_REQUIRED | 400 | المنتج له فاريانت ولم يُرسل variantId |
| OUT_OF_STOCK | 409 | المنتج غير متوفر (مع validateStock: true) |
| OUT_OF_STOCK_PARTIAL | 409 | الكمية المطلوبة أكبر من المخزون (مع validateStock: true) |
| CART_RATE_LIMITED | 429 | تجاوز حد الطلبات على السلة (80 طلب/دقيقة) |
| CART_ID_REQUIRED | 400 | سلة الزائر: لم يُرسل cartId أو cookie/header |

### هيكل الخطأ

```json
{
  "ok": false,
  "error": {
    "code": "OUT_OF_STOCK",
    "message": "Product is out of stock",
    "requestId": "uuid",
    "path": "/api/cart/add",
    "details": {
      "productId": "...",
      "variantId": "...",
      "available": 0,
      "requested": 2
    }
  }
}
```

---

## 6. تحديد اللغة

الرسائل والتسعير تعتمد على اللغة. أرسل أحد الخيارين:

1. **Query:** `?lang=he` أو `?lang=ar`
2. **Header:** `Accept-Language: he` أو `Accept-Language: ar`

---

## 7. خطة تنفيذ مقترحة للفرونت إند

### المرحلة 1: تحديثات أساسية

1. **تحديث دالة إزالة من السلة:**
   - التحقق من وجود `variantId` في بنود المنتجات ذات الفاريانت.
   - إرسال `variantId` دائماً عند الحذف لهذه المنتجات.

2. **استخدام الحقول المحسوبة:**
   - استبدال حسابات الفرونت بـ `currentStock`, `isAvailable`, `currentUnitPrice`, `lineTotal`.

3. **معالجة الأخطاء الجديدة:**
   - عرض رسائل مناسبة لـ `OUT_OF_STOCK`, `OUT_OF_STOCK_PARTIAL`, `VARIANT_REQUIRED`.
   - التعامل مع `CART_RATE_LIMITED` (429) وعرض رسالة "تم تجاوز الحد، حاول لاحقاً".

### المرحلة 2: سلة الزائر

1. **طبقة API للسلة:**
   ```typescript
   // مثال
   const getCart = () => isAuth
     ? api.get('/api/cart')
     : api.get('/api/cart/guest', { headers: { 'x-guest-cart-id': getGuestCartId() } });
   ```

2. **تخزين guestCartId:**
   - حفظه في localStorage بعد أول إضافة.
   - إرساله في header `x-guest-cart-id` لجميع طلبات سلة الزائر.

3. **التبديل بين السلتين:**
   - إذا كان المستخدم مسجّلاً → استخدام `/api/cart`.
   - إذا لم يكن مسجّلاً → استخدام `/api/cart/guest`.

### المرحلة 3: الدمج عند تسجيل الدخول

1. **قبل طلب تسجيل الدخول:**
   - قراءة `guestCartId` من localStorage.
   - إضافته إلى body طلب login إذا وُجد.

2. **بعد نجاح تسجيل الدخول:**
   - إذا وُجدت `cartMerged` في الاستجابة، عرض رسالة مثل "تم دمج X عناصر في سلتك".
   - إعادة جلب السلة من `/api/cart`.
   - حذف `guestCartId` من localStorage.

### المرحلة 4: تحسينات اختيارية

1. **validateStock:**
   - إرسال `validateStock: true` عند الإضافة من صفحة المنتج لمنع إضافة منتج غير متوفر.

2. **idempotent:**
   - إرسال `idempotent: true` عند الإضافة بعد إعادة التوجيه من صفحة تسجيل الدخول.

---

## 8. ملخص الـ Endpoints

| السياق | Endpoint | Auth |
|--------|----------|------|
| جلب السلة | `GET /api/cart` | JWT |
| جلب سلة الزائر | `GET /api/cart/guest` | لا |
| إضافة للسلة | `POST /api/cart/add` | JWT |
| إضافة لسلة الزائر | `POST /api/cart/guest/add` | لا |
| تحديث الكمية | `POST /api/cart/set-qty` | JWT |
| تحديث كمية الزائر | `POST /api/cart/guest/set-qty` | لا |
| حذف من السلة | `POST /api/cart/remove` | JWT |
| حذف من سلة الزائر | `POST /api/cart/guest/remove` | لا |
| تفريغ السلة | `POST /api/cart/clear` | JWT |
| تفريغ سلة الزائر | `POST /api/cart/guest/clear` | لا |
| تسجيل دخول + دمج | `POST /api/auth/login` + `guestCartId` | لا |

---

## 9. اختبار التكامل

1. **المستخدم المسجّل:** إضافة، تحديث كمية، حذف (مع variantId عند الحاجة).
2. **الزائر:** نفس العمليات عبر مسارات `/api/cart/guest`.
3. **الدمج:** إضافة عناصر كزائر، تسجيل الدخول مع `guestCartId`، التأكد من ظهور العناصر في سلة المستخدم.
4. **الأخطاء:** تجربة إضافة منتج غير متوفر مع `validateStock: true`، وحذف منتج فاريانت بدون `variantId`.
