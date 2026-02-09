# توثيق واجهة لوحة تحكم الأدمن (Dashboard API)

## المسار الأساسي

- **أدمن:** `GET /api/v1/admin/dashboard` (أو `GET /api/admin/dashboard`)
- يتطلب مصادقة (Bearer token) وإحدى الصلاحيات: `ORDERS_WRITE`, `PRODUCTS_WRITE`, `SETTINGS_WRITE`
- مصدر الكود: [src/routes/admin.dashboard.routes.js](../src/routes/admin.dashboard.routes.js)

---

## 1. معاملات الاستعلام (Query parameters)

| المعامل | النوع | الافتراضي | الوصف |
|---------|--------|-----------|--------|
| `period` | string | `30d` | الفترة للمقارنة: `7d` أو `30d` أو `90d`. تُستخدم لحساب الإيرادات وعدد الطلبات ونسبة التغيير مقابل الفترة السابقة. |
| `limit` | number | 10 | عدد عناصر قوائم "آخر الطلبات" و"آخر المرتجعات" (من 1 إلى 50). |

**أمثلة:**

- `GET /api/v1/admin/dashboard` — نفس الافتراضي (فترة 30 يوم، 10 عناصر للقوائم).
- `GET /api/v1/admin/dashboard?period=7d` — مقارنة آخر 7 أيام مع الـ 7 أيام السابقة.
- `GET /api/v1/admin/dashboard?period=90d&limit=20` — فترة 90 يوم و 20 عنصر في القوائم.

---

## 2. شكل الاستجابة (Envelope)

**نجاح:**

```json
{
  "ok": true,
  "success": true,
  "data": { ... }
}
```

**الهيدرات (Headers):**

- `Cache-Control: private, max-age=20` — يُسمح للعميل بتخزين الاستجابة 20 ثانية.
- `ETag: "<hash>"` — للتحقق من التحديث؛ إرسال `If-None-Match: "<hash>"` يعيد `304 Not Modified` إذا لم تتغير البيانات.

---

## 3. بنية `data` (محتويات لوحة التحكم)

جميع البيانات محسوبة ضمن نطاق الطلبات ذات البلد إسرائيل (IL) وتوقيت الأعمال `Asia/Jerusalem`، ما لم يُذكر خلاف ذلك.

### 3.1 لقطة اليوم (Today snapshot)

| الحقل | النوع | الوصف |
|-------|--------|--------|
| `revenueToday` | number | إجمالي إيرادات الطلبات المدفوعة اليوم. |
| `revenue7d` | number | إيرادات آخر 7 أيام (ثابتة، للتوافق مع واجهات قديمة). |
| `revenue30d` | number | إيرادات آخر 30 يوم (ثابتة، للتوافق). |
| `ordersToday` | number | عدد الطلبات المُنشأة اليوم. |
| `ordersPending` | number | عدد الطلبات في حالة انتظار (دفع/تنفيذ). |
| `returnsOpen` | number | عدد المرتجعات المفتوحة (طلب/موافقة/مستلمة/بانتظار استرداد). |
| `lowStockCount` | number | عدد المنتجات النشطة غير المحذوفة ذات مخزون ≤ 5. |

### 3.2 مقاييس الفترة والمقارنة (Period comparison — مثل المواقع العالمية)

| الحقل | النوع | الوصف |
|-------|--------|--------|
| `period` | string | الفترة المختارة: `7d`, `30d`, أو `90d`. |
| `periodStart` | string (ISO date) | بداية الفترة الحالية. |
| `periodEnd` | string (ISO date) | نهاية الفترة الحالية (للعرض). |
| `previousPeriodStart` | string (ISO date) | بداية الفترة السابقة. |
| `previousPeriodEnd` | string (ISO date) | نهاية الفترة السابقة. |
| `revenue` | number | إيرادات الفترة الحالية (من `periodStart` حتى الآن، تشمل اليوم). |
| `revenuePrevious` | number | إيرادات الفترة السابقة (نفس المدة). |
| `revenuePercentChange` | number \| null | نسبة تغيّر الإيرادات: `((revenue - revenuePrevious) / revenuePrevious) * 100`. `null` إذا الفترة السابقة = 0. |
| `ordersCount` | number | عدد الطلبات في الفترة الحالية. |
| `ordersCountPrevious` | number | عدد الطلبات في الفترة السابقة. |
| `ordersCountPercentChange` | number \| null | نسبة تغيّر عدد الطلبات. `null` إذا الفترة السابقة = 0. |

### 3.3 نشاط ومحتوى إضافي

| الحقل | النوع | الوصف |
|-------|--------|--------|
| `activeUsers` | number | عدد المستخدمين الذين لديهم طلب واحد على الأقل في الفترة الحالية. |
| `topProducts` | array | أفضل 10 منتجات (وحدات مُباعة وإيرادات) في الفترة الحالية. كل عنصر: `productId`, `title`, `titleAr`, `unitsSold`, `revenue`. |
| `latestOrders` | array | آخر الطلبات (حسب `limit`). كل عنصر: `id`, `orderNumber`, `status`, `paymentMethod`, `total`, `customerName`, `createdAt`. |
| `latestReturns` | array | آخر المرتجعات (حسب `limit`). كل عنصر: `id`, `orderId`, `status`, `reason`, `refundAmount`, `requestedAt`. |

### 3.4 metadata

| الحقل | النوع | الوصف |
|-------|--------|--------|
| `businessTimezone` | string | `Asia/Jerusalem` |
| `countryScope` | string | `IL` |
| `generatedAt` | string (ISO) | وقت توليد التقرير. |

---

## 4. استخدام نسبة التغيير في الواجهة

- عرض `revenuePercentChange` و `ordersCountPercentChange` بجانب الإيرادات وعدد الطلبات (سهم أعلى/أدنى ولون إيجابي/سلبي).
- إذا كانت القيمة `null`، إخفاء النسبة أو عرض "—" أو "لا مقارنة".

---

## 5. التخزين المؤقت (Caching)

- السيرفر يخزّن النتيجة في الذاكرة لمدة 20 ثانية حسب مفتاح يعتمد على `period` و `limit`.
- الطلبات المتكررة بنفس المعاملات خلال 20 ثانية تحصل على نفس الـ payload دون إعادة استعلام قاعدة البيانات.
- للحد من نقل البيانات، يُفضّل أن يرسل الفرونت إند هيدر `If-None-Match` بقيمة `ETag` الأخيرة؛ عند عدم تغيّر البيانات يُرجع السيرفر `304 Not Modified` بدون body.

---

## 6. أخطاء شائعة

| الحالة | الكود | الوصف |
|--------|--------|--------|
| عدم إرسال توكن أو توكن غير صالح | 401 | `UNAUTHORIZED` |
| المستخدم لا يملك الصلاحية | 403 | `INSUFFICIENT_PERMISSIONS` أو `FORBIDDEN` |
| خطأ داخلي | 500 | `INTERNAL_ERROR` مع `requestId` للمتابعة |

جميع استجابات الخطأ تتبع الشكل الموحد: `{ ok: false, success: false, error: { code, message, requestId, path } }`.
