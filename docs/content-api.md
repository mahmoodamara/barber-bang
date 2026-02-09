# توثيق واجهات Content في السيرفر (للمطابقة مع الفرونت)

## المسارات الأساسية (Base paths)

- **عام (Public):** `GET /api/v1/content` و `GET /api/v1/content/pages` و `GET /api/v1/content/pages/:slug`
- **أدمن:** تحت `/api/v1/admin/content` — يتطلب مصادقة وصلاحية `SETTINGS_WRITE`

---

## 1. نموذج البيانات (Content Page)

المصدر: [src/models/ContentPage.js](src/models/ContentPage.js)

| الحقل | النوع | مطلوب | القيود | ملاحظات |
|-------|--------|--------|--------|---------|
| `slug` | string | نعم | فريد، lowercase، trim، max 80 | حروف إنجليزية، أرقام، شرطات، وعربي/عبراني |
| `titleHe` | string | نعم | trim، max 160 | عنوان عبري |
| `titleAr` | string | لا | trim، max 160 | عنوان عربي |
| `contentHe` | string | نعم | trim، max 20000 | محتوى عبري (Rich text) |
| `contentAr` | string | لا | trim، max 20000 | محتوى عربي |
| `isActive` | boolean | لا | default: true | يتحكم في الظهور للعامة |
| `sortOrder` | number | لا | 0–9999، default: 100 | ترتيب العرض (أصغر = أولاً) |
| `createdAt` / `updatedAt` | date | تلقائي | — | من timestamps |

**تنظيف المحتوى (Rich text):** السيرفر يمرر المحتوى عبر [src/utils/sanitize.js](src/utils/sanitize.js): يسمح بالوسوم `p, br, b, strong, i, em, u, ul, ol, li, a` مع `href, title, target, rel` للروابط؛ يسمح بـ `http`, `https`, `mailto` فقط. أي وسوم أخرى تُزال.

**Slug:** السيرفر يطبّق `normalizeSlug`: تحويل لحروف صغيرة، استبدال المسافات والأحرف غير المسموحة بشرطة، إزالة الشرطات الزائدة، حد أقصى 80 حرفاً. العبرية والعربية مسموحة (`\u0590-\u05ff`, `\u0600-\u06ff`).

---

## 2. شكل الاستجابة الموحد (Envelope)

**نجاح (Admin و Public content):**

```json
{
  "ok": true,
  "success": true,
  "data": { ... },
  "meta": { ... }
}
```

- `meta` اختياري (يُستخدم في القوائم للـ pagination).

**خطأ:**

```json
{
  "ok": false,
  "success": false,
  "error": {
    "code": "STRING",
    "message": "STRING",
    "requestId": "STRING",
    "path": "STRING",
    "details": [ { "path": "", "message": "" } ]
  }
}
```

- `details` يظهر عند أخطاء الـ validation (Zod).

**ملاحظة:** الـ Public content في [src/routes/content.routes.js](src/routes/content.routes.js) يستخدم نفس الفكرة مع `okPayload` / `errorPayload`: `{ ok, success, data }` أو `{ ok, success: false, error: { code, message, requestId, path } }`.

---

## 3. شكل صفحة محتوى واحدة في الاستجابة (Admin و Public)

المصدر: دالة `mapPage` في [src/routes/admin.content.routes.js](src/routes/admin.content.routes.js) (وما يعادلها في [src/routes/content.routes.js](src/routes/content.routes.js) للعامة).

```json
{
  "id": "ObjectId",
  "_id": "ObjectId",
  "slug": "string",
  "titleHe": "string",
  "titleAr": "string",
  "title": "string",
  "contentHe": "string",
  "contentAr": "string",
  "content": "string",
  "isActive": true,
  "sortOrder": 100,
  "createdAt": "ISO date",
  "updatedAt": "ISO date"
}
```

- `title` و `content`: القيمة حسب لغة الطلب (`req.lang`: من هيدر أو `?lang=he|ar`). الاختيار: `titleHe`/`titleAr` و `contentHe`/`contentAr` عبر [src/utils/i18n.js](src/utils/i18n.js) مع fallback للغة الأخرى ثم فارغ.
- في الـ Public لا يُرجع `createdAt` في الـ map الحالي (يُرجع `updatedAt` فقط).

---

## 4. واجهات الأدمن (تحت `/api/v1/admin/content`)

جميعها تتطلب: **مصادقة + صلاحية SETTINGS_WRITE**. الـ Body لا يُرفق فيه `query` — الـ validation يتوقع فقط `body` و `params` لغير GET.

### 4.1 قائمة الصفحات — GET `/api/v1/admin/content/pages`

**Query (كلها اختيارية، كـ strings في الـ URL):**

| المعامل | النوع | الوصف |
|---------|--------|--------|
| `isActive` | `"true"` \| `"false"` | فلتر حسب الحالة |
| `q` | string، max 120 | بحث في slug, titleHe, titleAr |
| `page` | string (أرقام) | رقم الصفحة، default 1 |
| `limit` | string (أرقام) | عدد لكل صفحة، 1–100، default 50 |

**استجابة ناجحة (200):**

- `data`: مصفوفة عناصر بنفس شكل الصفحة أعلاه.
- `meta`: `{ page, limit, total, pages }`.

---

### 4.2 صفحة واحدة — GET `/api/v1/admin/content/pages/:id`

- **Params:** `id` — MongoDB ObjectId صالح.
- **استجابة:** 200 مع `data` = كائن صفحة واحدة، أو 404 مع `error.code === "NOT_FOUND"`.

---

### 4.3 إنشاء صفحة — POST `/api/v1/admin/content/pages`

**Body (JSON):**

| الحقل | مطلوب | القيود |
|-------|--------|--------|
| `slug` | نعم | string، 2–80 |
| `titleHe` | نعم | string، 2–160 |
| `titleAr` | لا | string، max 160 |
| `contentHe` | نعم | string، 1–20000 |
| `contentAr` | لا | string، max 20000 |
| `isActive` | لا | boolean، default false عند الإنشاء |
| `sortOrder` | لا | number 0–9999، default 100 |

- الـ schema **strict**: ممنوع إرسال حقول إضافية.
- السيرفر يطبّق `normalizeSlug` على `slug`؛ إذا الناتج فارغ → 400 `INVALID_SLUG`.
- إذا الـ slug مكرر → 409 `SLUG_EXISTS`.
- استجابة ناجحة: **201** مع `data` = الصفحة المُنشأة.

---

### 4.4 تحديث صفحة (جزئي) — PUT `/api/v1/admin/content/pages/:id`

**Params:** `id` — ObjectId.

**Body (JSON):** كل الحقول **اختيارية** (تحديث جزئي). القيود نفس الإنشاء:

| الحقل | القيود |
|-------|--------|
| `slug` | string، 2–80 |
| `titleHe` | string، 2–160 |
| `titleAr` | string، max 160 |
| `contentHe` | string، 1–20000 |
| `contentAr` | string، max 20000 |
| `isActive` | boolean |
| `sortOrder` | number 0–9999 |

- الـ schema **strict**: إرسال أي حقل غير المذكورة (مثل `query`) يسبب 400 مع `VALIDATION_ERROR` و `"Unrecognized key(s) in object: 'query'"` إن وُجد. الفرونت يجب أن يرسل **فقط** الحقول المسموحة في الـ body.
- إذا لم يُرسل أي حقل للتحديث → 200 مع الصفحة الحالية (بدون تعديل).
- أخطاء: 404 `NOT_FOUND`، 400 `INVALID_SLUG`، 409 `SLUG_EXISTS`.

---

### 4.5 نشر/إلغاء نشر — PATCH `/api/v1/admin/content/pages/:id/publish`

**Body:**

```json
{ "isActive": true | false }
```

- استجابة: 200 مع `data` = الصفحة بعد التحديث، أو 404.

---

### 4.6 حذف — DELETE `/api/v1/admin/content/pages/:id`

- **Params:** `id` — ObjectId.
- استجابة ناجحة (200): `data: { deleted: true, id: ObjectId }`. عند عدم الوجود: 404.

---

## 5. واجهات عامة (Public) — بدون مصادقة

المصدر: [src/routes/content.routes.js](src/routes/content.routes.js).

### 5.1 قائمة الصفحات النشطة — GET `/api/v1/content` أو GET `/api/v1/content/pages`

- **Query:** `lang` اختياري (`he` | `ar`) للـ `title` و `content` في الاستجابة.
- **استجابة:** `{ ok: true, success: true, data: [ ... ] }` — فقط الصفحات التي `isActive === true`، مرتبة حسب `sortOrder` ثم `createdAt`.

### 5.2 صفحة بالـ slug — GET `/api/v1/content/pages/:slug`

- **Params:** `slug` — string 2–80، يطابق النمط `^[a-z0-9-]+$` (مع case-insensitive في الاستعلام).
- **استجابة:** 200 مع صفحة واحدة، أو 404 `NOT_FOUND` إذا غير موجودة أو غير نشطة.

---

## 6. رموز الأخطاء الشائعة

| HTTP | code | متى |
|------|------|-----|
| 400 | `VALIDATION_ERROR` | جسم الطلب لا يطابق الـ schema (حقول ناقصة/زائدة/نوع خاطئ). تفاصيل في `error.details`. |
| 400 | `INVALID_SLUG` | قيمة slug بعد التطبيع فارغة أو غير مقبولة. |
| 404 | `NOT_FOUND` | الصفحة غير موجودة أو (في العام) غير نشطة. |
| 409 | `SLUG_EXISTS` | slug مستخدم من صفحة أخرى (عند إنشاء أو تحديث). |
| 401/403 | — | أدمن: مصادقة أو صلاحية ناقصة. |

---

## 7. ملخص للمطابقة مع الفرونت

1. **Base URL:** أدمن = `/api/v1/admin/content`، عام = `/api/v1/content`.
2. **Envelope:** دائماً `ok`, `success`، والبيانات في `data`؛ الأخطاء في `error` مع `code`, `message`, `path`, `requestId` واختيارياً `details`.
3. **PUT تحديث:** إرسال **فقط** الحقول المسموحة في الـ body (بدون `query` أو أي مفتاح آخر).
4. **اللغة:** إرسال `Accept-Language` أو `?lang=he|ar` للحصول على `title` و `content` بالمطلوب؛ السيرفر يعيد أيضاً `titleHe`, `titleAr`, `contentHe`, `contentAr`.
5. **الحدود:** عنوان حتى 160 حرف، محتوى حتى 20000، slug حتى 80؛ ترتيب 0–9999.
6. **Rich text:** إدخال يُنظّف حسب القائمة المسموحة أعلاه؛ الفرونت يمكنه تقييد التحرير لنفس المجموعة لتجنب فقدان تنسيق.
