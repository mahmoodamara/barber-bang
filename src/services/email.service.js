/**
 * Email service — sends transactional emails via SMTP (nodemailer).
 *
 * Supports: order confirmation (preliminary invoice), password reset, email verification.
 *
 * Required env vars:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 *
 * Falls back to console logging when SMTP is not configured,
 * so the app never crashes due to missing email config.
 */
import nodemailer from "nodemailer";
import { Order } from "../models/Order.js";
import { User } from "../models/User.js";
import { log } from "../utils/logger.js";

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@barberbang.com";
const STORE_NAME = process.env.STORE_NAME || "Barber Bang";

const isConfigured = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);

let transporter = null;

if (isConfigured) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  console.log(`📧 Email service configured (${SMTP_HOST}:${SMTP_PORT})`);
} else {
  console.warn("⚠️  Email service NOT configured — emails will be logged to console only.");
}

async function send({ to, subject, html, text }) {
  if (!transporter) {
    console.log(`📧 [email-stub] To: ${to} | Subject: ${subject}`);
    if (text) console.log(`   Body: ${text.substring(0, 200)}...`);
    return { accepted: [to], stub: true };
  }

  return transporter.sendMail({
    from: `"${STORE_NAME}" <${SMTP_FROM}>`,
    to,
    subject,
    html,
    text,
  });
}

export async function sendPasswordResetEmail(to, resetLink, lang = "he") {
  const isAr = lang === "ar";
  const subject = isAr
    ? `${STORE_NAME} — إعادة تعيين كلمة المرور`
    : `${STORE_NAME} — איפוס סיסמה`;

  const html = `
    <div dir="${isAr ? "rtl" : "rtl"}" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <h2 style="color:#1a1a1a;">${isAr ? "إعادة تعيين كلمة المرور" : "איפוס סיסמה"}</h2>
      <p>${isAr ? "اضغط الزر التالي لإعادة تعيين كلمة المرور:" : "לחץ על הכפתור הבא לאיפוס הסיסמה:"}</p>
      <a href="${resetLink}" style="display:inline-block;background:#1a1a1a;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0;">
        ${isAr ? "إعادة تعيين كلمة المرور" : "איפוס סיסמה"}
      </a>
      <p style="color:#666;font-size:13px;margin-top:24px;">
        ${isAr ? "إذا لم تطلب ذلك، يمكنك تجاهل هذا البريد." : "אם לא ביקשת זאת, ניתן להתעלם מהמייל."}
      </p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
      <p style="color:#999;font-size:12px;">${STORE_NAME}</p>
    </div>
  `;

  const text = isAr
    ? `إعادة تعيين كلمة المرور: ${resetLink}`
    : `איפוס סיסמה: ${resetLink}`;

  return send({ to, subject, html, text });
}

export async function sendEmailVerification(to, verifyLink, lang = "he") {
  const isAr = lang === "ar";
  const subject = isAr
    ? `${STORE_NAME} — تأكيد البريد الإلكتروني`
    : `${STORE_NAME} — אימות כתובת מייל`;

  const html = `
    <div dir="${isAr ? "rtl" : "rtl"}" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <h2 style="color:#1a1a1a;">${isAr ? "تأكيد بريدك الإلكتروني" : "אמת את כתובת המייל שלך"}</h2>
      <p>${isAr ? "اضغط الزر التالي لتأكيد حسابك:" : "לחץ על הכפתור הבא לאימות החשבון:"}</p>
      <a href="${verifyLink}" style="display:inline-block;background:#1a1a1a;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0;">
        ${isAr ? "تأكيد البريد" : "אמת מייל"}
      </a>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
      <p style="color:#999;font-size:12px;">${STORE_NAME}</p>
    </div>
  `;

  const text = isAr
    ? `تأكيد البريد: ${verifyLink}`
    : `אימות מייל: ${verifyLink}`;

  return send({ to, subject, html, text });
}

/**
 * Format a monetary value to 2 decimal places with currency symbol.
 */
function fmt(amount) {
  return `₪${Number(amount || 0).toFixed(2)}`;
}

/**
 * Resolve the shipping method display string.
 */
function resolveShippingLabel(shipping, isAr) {
  const mode = String(shipping?.mode || "");
  if (mode === "DELIVERY") {
    const area = String(shipping?.deliveryAreaName || "");
    return isAr
      ? `توصيل للمنزل${area ? ` — ${area}` : ""}`
      : `משלוח לבית${area ? ` — ${area}` : ""}`;
  }
  if (mode === "PICKUP_POINT") {
    const name = String(shipping?.pickupPointName || "");
    const addr = String(shipping?.pickupPointAddress || "");
    const detail = name ? (addr ? `${name}, ${addr}` : name) : "";
    return isAr
      ? `نقطة استلام${detail ? ` — ${detail}` : ""}`
      : `נקודת איסוף${detail ? ` — ${detail}` : ""}`;
  }
  if (mode === "STORE_PICKUP") {
    return isAr ? "איסוף עצמי מהחנות" : "איסוף עצמי מהחנות";
  }
  return isAr ? "شحن" : "משלוח";
}

/**
 * Build the items table rows HTML.
 */
function buildItemRows(items, isAr) {
  return (items || [])
    .map((item) => {
      const name = isAr
        ? (item.titleAr || item.titleHe || item.title || "")
        : (item.titleHe || item.titleAr || item.title || "");
      const qty = Number(item.qty || 1);
      const unitPrice = Number(item.unitPrice || item.priceAtOrder || 0);
      const lineTotal = unitPrice * qty;
      return `
        <tr>
          <td style="padding:9px 8px;border-bottom:1px solid #f0f0f0;text-align:start;">${name}</td>
          <td style="padding:9px 8px;border-bottom:1px solid #f0f0f0;text-align:center;">${qty}</td>
          <td style="padding:9px 8px;border-bottom:1px solid #f0f0f0;text-align:end;white-space:nowrap;">${fmt(unitPrice)}</td>
          <td style="padding:9px 8px;border-bottom:1px solid #f0f0f0;text-align:end;white-space:nowrap;font-weight:600;">${fmt(lineTotal)}</td>
        </tr>`;
    })
    .join("");
}

/**
 * Build a pricing summary row for the totals section.
 */
function summaryRow(label, value, isBold = false, color = "") {
  const style = `padding:6px 8px;text-align:end;white-space:nowrap;${isBold ? "font-weight:700;" : ""}${color ? `color:${color};` : ""}`;
  return `
    <tr>
      <td style="padding:6px 8px;text-align:start;${isBold ? "font-weight:700;" : ""}${color ? `color:${color};` : ""}">${label}</td>
      <td style="${style}">${value}</td>
    </tr>`;
}

/**
 * sendOrderConfirmation — sends the preliminary invoice / order confirmation email.
 *
 * Clearly states:
 *  - All prices are VAT-inclusive (18%)
 *  - Official invoice will be sent with shipment / handed over at delivery/pickup
 */
export async function sendOrderConfirmation(to, order, lang = "he") {
  const isAr = lang === "ar";
  const orderNumber = order.orderNumber || order._id;

  const subject = isAr
    ? `${STORE_NAME} — تأكيد الطلب #${orderNumber}`
    : `${STORE_NAME} — אישור הזמנה #${orderNumber}`;

  const pricing = order.pricing || {};
  const vatRate = Number(pricing.vatRate || 18);
  const subtotal = Number(pricing.subtotal || 0);
  const shippingFee = Number(pricing.shippingFee || 0);
  const total = Number(pricing.total || 0);
  const vatAmount = Number(pricing.vatAmount || 0);
  const discountTotal = Number(pricing.discountTotal || 0);
  const couponCode = String(pricing.discounts?.coupon?.code || pricing.couponCode || "");

  const itemsHtml = buildItemRows(order.items || [], isAr);

  const shippingLabel = resolveShippingLabel(order.shipping, isAr);

  // Pricing summary rows
  let summaryRows = "";
  summaryRows += summaryRow(
    isAr ? "المجموع الجزئي" : "סכום ביניים",
    fmt(subtotal)
  );
  summaryRows += summaryRow(
    isAr ? `شحن (${shippingLabel})` : `משלוח (${shippingLabel})`,
    shippingFee > 0 ? fmt(shippingFee) : (isAr ? "חינם" : "חינם")
  );
  if (discountTotal > 0) {
    const discountLabel = couponCode
      ? (isAr ? `خصم (${couponCode})` : `הנחה (${couponCode})`)
      : (isAr ? "خصم" : "הנחה");
    summaryRows += summaryRow(discountLabel, `-${fmt(discountTotal)}`, false, "#16a34a");
  }
  if (vatAmount > 0) {
    summaryRows += summaryRow(
      isAr ? `ضريبة القيمة المضافة ${vatRate}% (כלול)` : `מע״מ ${vatRate}% (כלול במחיר)`,
      fmt(vatAmount),
      false,
      "#6b7280"
    );
  }
  summaryRows += summaryRow(
    isAr ? "المجموع الكلي" : "סה״כ לתשלום",
    fmt(total),
    true
  );

  // VAT badge text
  const vatBadge = isAr
    ? `جميع الأسعار تشمل ضريبة القيمة المضافة ${vatRate}% (مع"מ)`
    : `כל המחירים כוללים מע״מ ${vatRate}%`;

  // Official invoice note
  const invoiceNote = isAr
    ? "החשבונית הרשמית תישלח עם המשלוח או תימסר בעת האספקה / האיסוף."
    : "החשבונית הרשמית תישלח עם המשלוח או תימסר בעת האספקה / האיסוף.";

  const html = `
<!DOCTYPE html>
<html lang="${isAr ? "ar" : "he"}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#f7f7f7;font-family:Arial,Helvetica,sans-serif;">
  <div dir="rtl" style="max-width:620px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:#1a1a1a;padding:28px 32px;text-align:center;">
      <p style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:1px;">${STORE_NAME}</p>
      <p style="margin:6px 0 0;color:#ccc;font-size:13px;">
        ${isAr ? "تأكيد الطلب / فاتورة مبدئية" : "אישור הזמנה / חשבונית מקדמית"}
      </p>
    </div>

    <!-- Body -->
    <div style="padding:28px 32px;">

      <!-- Thank you + order number -->
      <h2 style="margin:0 0 6px;color:#1a1a1a;font-size:20px;">
        ${isAr ? "شكراً على طلبك!" : "תודה על ההזמנה!"}
      </h2>
      <p style="margin:0 0 20px;color:#555;font-size:14px;">
        ${isAr ? "رقم الطلب:" : "מספר הזמנה:"}
        <strong style="color:#1a1a1a;font-size:16px;">#${orderNumber}</strong>
      </p>

      <!-- VAT badge -->
      <div style="background:#fef9ec;border:1px solid #f0c040;border-radius:6px;padding:10px 14px;margin-bottom:20px;font-size:13px;color:#7a5a00;">
        ⚠️ ${vatBadge}
      </div>

      <!-- Items table -->
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:9px 8px;text-align:start;font-weight:600;color:#333;border-bottom:2px solid #e0e0e0;">
              ${isAr ? "المنتج" : "מוצר"}
            </th>
            <th style="padding:9px 8px;text-align:center;font-weight:600;color:#333;border-bottom:2px solid #e0e0e0;">
              ${isAr ? "الكمية" : "כמות"}
            </th>
            <th style="padding:9px 8px;text-align:end;font-weight:600;color:#333;border-bottom:2px solid #e0e0e0;">
              ${isAr ? "سعر الوحدة" : "מחיר יחידה"}
            </th>
            <th style="padding:9px 8px;text-align:end;font-weight:600;color:#333;border-bottom:2px solid #e0e0e0;">
              ${isAr ? "المجموع" : "סה״כ"}
            </th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml || `<tr><td colspan="4" style="padding:12px 8px;color:#999;text-align:center;">${isAr ? "لا توجد منتجات" : "אין פריטים"}</td></tr>`}
        </tbody>
      </table>

      <!-- Pricing summary -->
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px;border-top:2px solid #e0e0e0;">
        <tbody>
          ${summaryRows}
        </tbody>
      </table>

      <!-- Divider -->
      <hr style="border:none;border-top:2px solid #1a1a1a;margin:24px 0;" />

      <!-- Official invoice note -->
      <div style="background:#f0f7ff;border:1px solid #b3d4f5;border-radius:6px;padding:12px 16px;font-size:13px;color:#1a4a7a;line-height:1.6;">
        <strong>${isAr ? "ملاحظة بشأن الفاتورة:" : "הערה לגבי חשבונית:"}</strong><br />
        ${invoiceNote}
      </div>

    </div>

    <!-- Footer -->
    <div style="background:#f5f5f5;padding:16px 32px;text-align:center;border-top:1px solid #e0e0e0;">
      <p style="margin:0;color:#999;font-size:12px;">${STORE_NAME} &copy; ${new Date().getFullYear()}</p>
      <p style="margin:4px 0 0;color:#bbb;font-size:11px;">
        ${isAr ? `جميع الأسعار تشمل ضريبة القيمة المضافة ${vatRate}%` : `כל המחירים כוללים מע״מ ${vatRate}%`}
      </p>
    </div>

  </div>
</body>
</html>`;

  const text = isAr
    ? `تأكيد الطلب #${orderNumber} — المجموع: ${fmt(total)} (شامل ضريبة القيمة المضافة ${vatRate}%). الفاتورة الرسمية ستُرسل مع الشحنة.`
    : `אישור הזמנה #${orderNumber} — סה״כ: ${fmt(total)} (כולל מע״מ ${vatRate}%). החשבונית הרשמית תישלח עם המשלוח.`;

  return send({ to, subject, html, text });
}

/**
 * sendOrderConfirmationSafe — best-effort wrapper around sendOrderConfirmation.
 *
 * - Loads the order and its associated user from DB
 * - Guards against duplicate sends via order.confirmationEmailSentAt
 * - Atomically marks the order as email-sent on success
 * - Logs every decision step (for debugging)
 * - Never throws
 *
 * @param {string|import("mongoose").Types.ObjectId} orderId
 * @param {object} [opts]
 * @param {string} [opts.lang] - Language override ("he" | "ar")
 */
export async function sendOrderConfirmationSafe(orderId, opts = {}) {
  const orderIdStr = String(orderId);
  log.info({ orderId: orderIdStr }, "[email] sendOrderConfirmationSafe: start");

  try {
    const order = await Order.findById(orderId).lean();
    if (!order) {
      log.warn({ orderId: orderIdStr }, "[email] sendOrderConfirmationSafe: order not found");
      return;
    }

    log.info(
      { orderId: orderIdStr, orderNumber: order.orderNumber || "", status: order.status },
      "[email] sendOrderConfirmationSafe: order loaded"
    );

    // Duplicate prevention: already sent
    if (order.confirmationEmailSentAt) {
      log.info(
        { orderId: orderIdStr, sentAt: order.confirmationEmailSentAt },
        "[email] sendOrderConfirmationSafe: already sent, skipping"
      );
      return;
    }

    // Resolve customer email from User record
    const user = await User.findById(order.userId).select("email").lean();
    const to = String(user?.email || "").trim().toLowerCase();

    log.info(
      { orderId: orderIdStr, hasEmail: !!to, userId: String(order.userId || "") },
      "[email] sendOrderConfirmationSafe: user lookup complete"
    );

    if (!to) {
      log.warn(
        { orderId: orderIdStr, userId: String(order.userId || "") },
        "[email] sendOrderConfirmationSafe: no customer email on user record, skipping"
      );
      return;
    }

    const lang = opts.lang || "he";

    log.info(
      { orderId: orderIdStr, lang, smtpConfigured: isConfigured },
      "[email] sendOrderConfirmationSafe: calling sendOrderConfirmation"
    );

    const result = await sendOrderConfirmation(to, order, lang);

    log.info(
      { orderId: orderIdStr, accepted: result?.accepted, stub: result?.stub },
      "[email] sendOrderConfirmationSafe: sendOrderConfirmation returned"
    );

    // Mark as sent (atomic — filter on null prevents double-send on concurrent calls)
    await Order.updateOne(
      { _id: orderId, confirmationEmailSentAt: null },
      { $set: { confirmationEmailSentAt: new Date() } }
    );

    log.info(
      { orderId: orderIdStr },
      "[email] sendOrderConfirmationSafe: confirmation email sent and order updated"
    );
  } catch (err) {
    log.error(
      { orderId: orderIdStr, err: String(err?.message || err), stack: String(err?.stack || "") },
      "[email] sendOrderConfirmationSafe: FAILED"
    );
  }
}

/**
 * sendRefundNotification — informs the customer that a refund has been processed.
 *
 * @param {string} to           Customer email
 * @param {object} order        Order document (lean or mongoose)
 * @param {number} refundAmount Refund amount in ILS major units
 * @param {string} lang         "he" | "ar"
 */
export async function sendRefundNotification(to, order, refundAmount, lang = "he") {
  const isAr = lang === "ar";
  const orderNumber = order.orderNumber || order._id;

  const subject = isAr
    ? `${STORE_NAME} — تم استرداد المبلغ — طلب #${orderNumber}`
    : `${STORE_NAME} — החזר כספי בוצע — הזמנה #${orderNumber}`;

  const html = `
<!DOCTYPE html>
<html lang="${isAr ? "ar" : "he"}">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:#f7f7f7;font-family:Arial,Helvetica,sans-serif;">
  <div dir="rtl" style="max-width:620px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:#1a1a1a;padding:28px 32px;text-align:center;">
      <p style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:1px;">${STORE_NAME}</p>
      <p style="margin:6px 0 0;color:#ccc;font-size:13px;">
        ${isAr ? "إشعار استرداد المبلغ" : "אישור החזר כספי"}
      </p>
    </div>
    <div style="padding:28px 32px;">
      <h2 style="margin:0 0 10px;color:#1a1a1a;font-size:20px;">
        ${isAr ? "تم استرداد المبلغ بنجاح" : "החזר כספי בוצע בהצלחה"}
      </h2>
      <p style="margin:0 0 20px;color:#555;font-size:14px;">
        ${isAr ? "رقم الطلب:" : "מספר הזמנה:"}
        <strong style="color:#1a1a1a;font-size:16px;">#${orderNumber}</strong>
      </p>
      <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:16px 20px;margin-bottom:20px;text-align:center;">
        <p style="margin:0 0 4px;font-size:13px;color:#166534;">
          ${isAr ? "المبلغ المسترد" : "סכום ההחזר"}
        </p>
        <p style="margin:0;font-size:28px;font-weight:700;color:#166534;">${fmt(refundAmount)}</p>
      </div>
      <p style="margin:0 0 16px;color:#555;font-size:14px;line-height:1.6;">
        ${isAr
          ? "تم إرسال المبلغ إلى وسيلة الدفع الأصلية. قد يستغرق ظهور المبلغ في حسابك حتى 10 أيام عمل حسب البنك."
          : "הסכום הוחזר לאמצעי התשלום המקורי. ייתכן שייקח עד 10 ימי עסקים עד שהסכום יופיע בחשבונך, בהתאם לבנק."}
      </p>
      <p style="margin:0;color:#999;font-size:13px;">
        ${isAr ? "إذا كان لديك أي سؤال، لا تتردد في الاتصال بنا." : "אם יש לך שאלות, אל תהסס ליצור קשר."}
      </p>
    </div>
    <div style="background:#f5f5f5;padding:16px 32px;text-align:center;border-top:1px solid #e0e0e0;">
      <p style="margin:0;color:#999;font-size:12px;">${STORE_NAME} &copy; ${new Date().getFullYear()}</p>
    </div>
  </div>
</body>
</html>`;

  const text = isAr
    ? `تم استرداد مبلغ ${fmt(refundAmount)} للطلب #${orderNumber}. سيظهر المبلغ في حسابك خلال 10 أيام عمل.`
    : `בוצע החזר כספי בסך ${fmt(refundAmount)} להזמנה #${orderNumber}. הסכום יופיע בחשבונך תוך 10 ימי עסקים.`;

  return send({ to, subject, html, text });
}

/**
 * sendRefundNotificationSafe — best-effort wrapper around sendRefundNotification.
 * Loads user email from order.userId, never throws.
 */
export async function sendRefundNotificationSafe(orderId, refundAmount, opts = {}) {
  const orderIdStr = String(orderId);
  try {
    const order = await Order.findById(orderId).lean();
    if (!order) return;

    const user = await User.findById(order.userId).select("email lang").lean();
    const to = String(user?.email || "").trim().toLowerCase();
    if (!to) return;

    const lang = opts.lang || String(user?.lang || "he");
    await sendRefundNotification(to, order, refundAmount, lang);

    log.info(
      { orderId: orderIdStr, refundAmount },
      "[email] sendRefundNotificationSafe: sent"
    );
  } catch (err) {
    log.error(
      { orderId: orderIdStr, err: String(err?.message || err) },
      "[email] sendRefundNotificationSafe: FAILED"
    );
  }
}

/**
 * sendB2BApprovalEmail — notifies user their B2B application was approved.
 */
export async function sendB2BApprovalEmail(to, { businessName, wholesaleTier }, lang = "he") {
  const isAr = lang === "ar";
  const tierLabels = {
    bronze: isAr ? "برونزي" : "ברונזה",
    silver: isAr ? "فضي" : "כסף",
    gold: isAr ? "ذهبي" : "זהב",
  };
  const tierLabel = tierLabels[wholesaleTier] || wholesaleTier;

  const subject = isAr
    ? `${STORE_NAME} — تمت الموافقة على حسابك التجاري!`
    : `${STORE_NAME} — חשבון העסק שלך אושר!`;

  const html = `
<!DOCTYPE html>
<html lang="${isAr ? "ar" : "he"}">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:#f7f7f7;font-family:Arial,Helvetica,sans-serif;">
  <div dir="rtl" style="max-width:620px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:#1a1a1a;padding:28px 32px;text-align:center;">
      <p style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:1px;">${STORE_NAME}</p>
    </div>
    <div style="padding:28px 32px;">
      <div style="text-align:center;margin-bottom:20px;">
        <span style="display:inline-block;background:#f0fdf4;border-radius:50%;width:64px;height:64px;line-height:64px;font-size:32px;">✅</span>
      </div>
      <h2 style="margin:0 0 10px;color:#1a1a1a;font-size:20px;text-align:center;">
        ${isAr ? "تمت الموافقة على حسابك التجاري!" : "חשבון העסק שלך אושר!"}
      </h2>
      <p style="margin:0 0 20px;color:#555;font-size:14px;text-align:center;">
        ${isAr ? `مرحباً ${businessName}` : `שלום ${businessName}`}
      </p>
      <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
        <p style="margin:0 0 8px;font-size:14px;color:#166534;font-weight:600;">
          ${isAr ? "تفاصيل الحساب:" : "פרטי החשבון:"}
        </p>
        <p style="margin:0;font-size:14px;color:#166534;">
          ${isAr ? "مستوى الجملة:" : "רמת סיטונאות:"} <strong>${tierLabel}</strong>
        </p>
      </div>
      <p style="margin:0 0 20px;color:#555;font-size:14px;line-height:1.6;">
        ${isAr
          ? "يمكنك الآن الاستفادة من أسعار الجملة الخاصة عند التسوق. أسعار الجملة ستظهر تلقائياً على المنتجات."
          : "כעת תוכל ליהנות ממחירי סיטונאות מיוחדים בעת הקנייה. מחירי הסיטונאות יופיעו אוטומטית על המוצרים."}
      </p>
      <div style="text-align:center;">
        <a href="${process.env.FRONTEND_URL || "https://barberbang.com"}/shop" style="display:inline-block;background:#1a1a1a;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;">
          ${isAr ? "تسوق الآن" : "לקנייה"}
        </a>
      </div>
    </div>
    <div style="background:#f5f5f5;padding:16px 32px;text-align:center;border-top:1px solid #e0e0e0;">
      <p style="margin:0;color:#999;font-size:12px;">${STORE_NAME} &copy; ${new Date().getFullYear()}</p>
    </div>
  </div>
</body>
</html>`;

  const text = isAr
    ? `تمت الموافقة على حسابك التجاري (${businessName}). مستوى الجملة: ${tierLabel}. يمكنك الآن التسوق بأسعار الجملة.`
    : `חשבון העסק שלך (${businessName}) אושר. רמת סיטונאות: ${tierLabel}. כעת תוכל לקנות במחירי סיטונאות.`;

  return send({ to, subject, html, text });
}

/**
 * sendB2BRejectionEmail — notifies user their B2B application was rejected.
 */
export async function sendB2BRejectionEmail(to, { businessName }, lang = "he") {
  const isAr = lang === "ar";

  const subject = isAr
    ? `${STORE_NAME} — بخصوص طلب الحساب التجاري`
    : `${STORE_NAME} — לגבי בקשת חשבון העסק`;

  const html = `
<!DOCTYPE html>
<html lang="${isAr ? "ar" : "he"}">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:#f7f7f7;font-family:Arial,Helvetica,sans-serif;">
  <div dir="rtl" style="max-width:620px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:#1a1a1a;padding:28px 32px;text-align:center;">
      <p style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:1px;">${STORE_NAME}</p>
    </div>
    <div style="padding:28px 32px;">
      <h2 style="margin:0 0 10px;color:#1a1a1a;font-size:20px;">
        ${isAr ? `مرحباً ${businessName}` : `שלום ${businessName}`}
      </h2>
      <p style="margin:0 0 20px;color:#555;font-size:14px;line-height:1.6;">
        ${isAr
          ? "نأسف لإبلاغك أن طلب فتح حساب تجاري لم تتم الموافقة عليه في الوقت الحالي. إذا كانت لديك أي أسئلة أو ترغب في إعادة التقديم، لا تتردد في التواصل معنا."
          : "לצערנו, הבקשה לפתיחת חשבון עסקי לא אושרה כרגע. אם יש לך שאלות או שברצונך להגיש בקשה מחדש, אל תהסס ליצור איתנו קשר."}
      </p>
      <div style="text-align:center;">
        <a href="${process.env.FRONTEND_URL || "https://barberbang.com"}/b2b" style="display:inline-block;background:#1a1a1a;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;">
          ${isAr ? "تواصل معنا" : "צור קשר"}
        </a>
      </div>
    </div>
    <div style="background:#f5f5f5;padding:16px 32px;text-align:center;border-top:1px solid #e0e0e0;">
      <p style="margin:0;color:#999;font-size:12px;">${STORE_NAME} &copy; ${new Date().getFullYear()}</p>
    </div>
  </div>
</body>
</html>`;

  const text = isAr
    ? `بخصوص طلب حساب تجاري (${businessName}): لم تتم الموافقة حالياً. تواصل معنا لمزيد من المعلومات.`
    : `לגבי בקשת חשבון עסקי (${businessName}): הבקשה לא אושרה כרגע. צור קשר לפרטים נוספים.`;

  return send({ to, subject, html, text });
}

export const emailService = {
  isConfigured,
  send,
  sendPasswordResetEmail,
  sendEmailVerification,
  sendOrderConfirmation,
  sendOrderConfirmationSafe,
  sendRefundNotification,
  sendRefundNotificationSafe,
  sendB2BApprovalEmail,
  sendB2BRejectionEmail,
};
