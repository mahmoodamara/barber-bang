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
 *
 * IMPORTANT:
 * - Ensure this file is saved as UTF-8 (no BOM) so Hebrew/Arabic text is not corrupted.
 */
import nodemailer from "nodemailer";
import { Order } from "../models/Order.js";
import { User } from "../models/User.js";
import { log } from "../utils/logger.js";

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM =
  process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@barberbang.com";
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
  console.warn(
    "⚠️  Email service NOT configured — emails will be logged to console only.",
  );
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
    <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
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
    <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
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
  return `\u20AA${Number(amount || 0).toFixed(2)}`;
}

/**
 * Basic HTML escaping for dynamic content in email templates.
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Format date/time for transactional email output.
 */
function fmtDateTime(value, lang = "he") {
  if (!value) return "-";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString(lang === "ar" ? "ar-IL" : "he-IL");
  } catch {
    return String(value);
  }
}

/**
 * Resolve payment method label for user/admin mails.
 */
function resolvePaymentMethodLabel(method, isAr) {
  const key = String(method || "").toLowerCase();
  const labels = {
    cod: isAr ? "الدفع عند الاستلام" : "מזומן במסירה",
    bank_transfer: isAr ? "تحويل بنكي" : "העברה בנקאית",
    net_terms: isAr ? "دفع آجل (ائتمان)" : "אשראי (תשלום דחוי)",
    stripe: isAr ? "بطاقة" : "כרטיס אשראי",
  };
  return labels[key] || (isAr ? "غير محدد" : "לא צוין");
}

/**
 * Build full address line from structured shipping address.
 */
function buildAddressLine(address = {}) {
  return [
    String(address.city || "").trim(),
    String(address.street || "").trim(),
    String(address.building || "").trim(),
    String(address.floor || "").trim(),
    String(address.apartment || "").trim(),
  ]
    .filter(Boolean)
    .join(", ");
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
    return isAr ? "استلام من المتجر" : "איסוף מהחנות";
  }
  return isAr ? "شحن" : "משלוח";
}

/**
 * Build the items table rows HTML.
 */
function buildItemRows(items, isAr) {
  return (items || [])
    .map((item) => {
      const rawName = isAr
        ? item.titleAr || item.titleHe || item.title || ""
        : item.titleHe || item.titleAr || item.title || "";
      const name = escapeHtml(rawName);
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
  const orderId = String(order._id || "");

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
  const couponCode = String(
    pricing.discounts?.coupon?.code || pricing.couponCode || "",
  );

  const shipping = order.shipping || {};
  const address = shipping.address || {};
  const customerName = String(address.fullName || "").trim();
  const customerPhone = String(address.phone || shipping.phone || "").trim();
  const paymentLabel = resolvePaymentMethodLabel(order.paymentMethod, isAr);
  const shippingLabel = resolveShippingLabel(shipping, isAr);
  const addressLine = buildAddressLine(address);
  const createdAtLabel = fmtDateTime(order.createdAt, lang);

  const itemsHtml = buildItemRows(order.items || [], isAr);

  let summaryRows = "";
  summaryRows += summaryRow(
    isAr ? "المجموع الجزئي" : "סכום ביניים",
    fmt(subtotal),
  );
  summaryRows += summaryRow(
    isAr ? `الشحن (${shippingLabel})` : `משלוח (${shippingLabel})`,
    shippingFee > 0 ? fmt(shippingFee) : isAr ? "مجاني" : "חינם",
  );
  if (discountTotal > 0) {
    const discountLabel = couponCode
      ? isAr
        ? `خصم (${couponCode})`
        : `הנחה (${couponCode})`
      : isAr
        ? "خصم"
        : "הנחה";
    summaryRows += summaryRow(
      discountLabel,
      `-${fmt(discountTotal)}`,
      false,
      "#16a34a",
    );
  }
  if (vatAmount > 0) {
    summaryRows += summaryRow(
      isAr ? `ضريبة القيمة المضافة ${vatRate}%` : `מע״מ ${vatRate}%`,
      fmt(vatAmount),
      false,
      "#6b7280",
    );
  }
  summaryRows += summaryRow(
    isAr ? "المجموع الكلي" : "סה״כ לתשלום",
    fmt(total),
    true,
  );

  const detailsRows = [
    [isAr ? "رقم الطلب" : "מספר הזמנה", `#${orderNumber}`],
    [isAr ? "تاريخ الطلب" : "תאריך הזמנה", createdAtLabel],
    [isAr ? "طريقة الدفع" : "אמצעי תשלום", paymentLabel],
    [isAr ? "طريقة الشحن/الاستلام" : "שיטת משלוח/איסוף", shippingLabel],
    [isAr ? "الاسم" : "שם", customerName || "-"],
    [isAr ? "الهاتف" : "טלפון", customerPhone || "-"],
    [isAr ? "العنوان" : "כתובת", addressLine || "-"],
  ]
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;color:#666;width:38%;">${escapeHtml(label)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-weight:500;">${escapeHtml(value)}</td>
      </tr>`,
    )
    .join("");

  const vatBadge = isAr
    ? `جميع الأسعار تشمل ضريبة القيمة المضافة ${vatRate}%`
    : `כל המחירים כוללים מע״מ ${vatRate}%`;

  const invoiceNote = isAr
    ? "الفاتورة الرسمية ستُرسل مع الشحنة أو تُسلَّم عند الاستلام."
    : "החשבונית הרשמית תישלח עם המשלוח או תימסר בעת האיסוף.";

  const html = `
<!DOCTYPE html>
<html lang="${isAr ? "ar" : "he"}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#f7f7f7;font-family:Arial,Helvetica,sans-serif;">
  <div dir="rtl" style="max-width:640px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

    <div style="background:#111827;padding:28px 32px;text-align:center;">
      <p style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:1px;">${STORE_NAME}</p>
      <p style="margin:6px 0 0;color:#d1d5db;font-size:13px;">
        ${isAr ? "تأكيد الطلب" : "אישור הזמנה"}
      </p>
    </div>

    <div style="padding:28px 32px;">
      <h2 style="margin:0 0 8px;color:#111827;font-size:20px;">
        ${isAr ? "شكراً على طلبك" : "תודה על ההזמנה"}
      </h2>
      <p style="margin:0 0 16px;color:#555;font-size:14px;line-height:1.6;">
        ${isAr ? "تم استلام طلبك بنجاح. فيما يلي التفاصيل الكاملة:" : "ההזמנה התקבלה בהצלחה. להלן פרטי ההזמנה:"}
      </p>

      <div style="background:#fef9ec;border:1px solid #f0c040;border-radius:6px;padding:10px 14px;margin-bottom:20px;font-size:13px;color:#7a5a00;">
        ⚠️ ${vatBadge}
      </div>

      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px;border:1px solid #ececec;border-radius:8px;overflow:hidden;">
        <tbody>${detailsRows}</tbody>
      </table>

      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:9px 8px;text-align:start;font-weight:600;color:#333;border-bottom:2px solid #e0e0e0;">${isAr ? "المنتج" : "מוצר"}</th>
            <th style="padding:9px 8px;text-align:center;font-weight:600;color:#333;border-bottom:2px solid #e0e0e0;">${isAr ? "الكمية" : "כמות"}</th>
            <th style="padding:9px 8px;text-align:end;font-weight:600;color:#333;border-bottom:2px solid #e0e0e0;">${isAr ? "سعر الوحدة" : "מחיר יחידה"}</th>
            <th style="padding:9px 8px;text-align:end;font-weight:600;color:#333;border-bottom:2px solid #e0e0e0;">${isAr ? "الإجمالي" : "סה״כ"}</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml || `<tr><td colspan="4" style="padding:12px 8px;color:#999;text-align:center;">${isAr ? "لا توجد منتجات" : "אין פריטים"}</td></tr>`}
        </tbody>
      </table>

      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px;border-top:2px solid #e0e0e0;">
        <tbody>
          ${summaryRows}
        </tbody>
      </table>

      <div style="background:#f0f7ff;border:1px solid #b3d4f5;border-radius:6px;padding:12px 16px;font-size:13px;color:#1a4a7a;line-height:1.6;">
        <strong>${isAr ? "ملاحظة بشأن الفاتورة:" : "הערה לגבי חשבונית:"}</strong><br />
        ${invoiceNote}
      </div>
    </div>

    <div style="background:#f5f5f5;padding:16px 32px;text-align:center;border-top:1px solid #e0e0e0;">
      <p style="margin:0;color:#999;font-size:12px;">${STORE_NAME} &copy; ${new Date().getFullYear()}</p>
      <p style="margin:6px 0 0;color:#bbb;font-size:11px;">${isAr ? `مرجع الطلب: ${escapeHtml(orderId)}` : `מזהה הזמנה: ${escapeHtml(orderId)}`}</p>
    </div>

  </div>
</body>
</html>`;

  const text = isAr
    ? `تأكيد الطلب #${orderNumber}\nتاريخ الطلب: ${createdAtLabel}\nطريقة الدفع: ${paymentLabel}\nطريقة الشحن/الاستلام: ${shippingLabel}\nالاسم: ${customerName || "-"}\nالهاتف: ${customerPhone || "-"}\nالعنوان: ${addressLine || "-"}\nالمجموع الجزئي: ${fmt(subtotal)}\nالشحن: ${shippingFee > 0 ? fmt(shippingFee) : "مجاني"}\nالخصم: ${discountTotal > 0 ? `-${fmt(discountTotal)}` : fmt(0)}\nالمجموع الكلي: ${fmt(total)}\nالأسعار تشمل ضريبة القيمة المضافة ${vatRate}%.`
    : `אישור הזמנה #${orderNumber}\nתאריך הזמנה: ${createdAtLabel}\nאמצעי תשלום: ${paymentLabel}\nשיטת משלוח/איסוף: ${shippingLabel}\nשם: ${customerName || "-"}\nטלפון: ${customerPhone || "-"}\nכתובת: ${addressLine || "-"}\nסכום ביניים: ${fmt(subtotal)}\nמשלוח: ${shippingFee > 0 ? fmt(shippingFee) : "חינם"}\nהנחה: ${discountTotal > 0 ? `-${fmt(discountTotal)}` : fmt(0)}\nסה״כ לתשלום: ${fmt(total)}\nהמחירים כוללים מע״מ ${vatRate}%.`;

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
      log.warn(
        { orderId: orderIdStr },
        "[email] sendOrderConfirmationSafe: order not found",
      );
      return;
    }

    log.info(
      {
        orderId: orderIdStr,
        orderNumber: order.orderNumber || "",
        status: order.status,
      },
      "[email] sendOrderConfirmationSafe: order loaded",
    );

    // Duplicate prevention: already sent
    if (order.confirmationEmailSentAt) {
      log.info(
        { orderId: orderIdStr, sentAt: order.confirmationEmailSentAt },
        "[email] sendOrderConfirmationSafe: already sent, skipping",
      );
      return;
    }

    // Resolve customer email from User record
    const user = await User.findById(order.userId).select("email").lean();
    const to = String(user?.email || "")
      .trim()
      .toLowerCase();

    log.info(
      {
        orderId: orderIdStr,
        hasEmail: !!to,
        userId: String(order.userId || ""),
      },
      "[email] sendOrderConfirmationSafe: user lookup complete",
    );

    if (!to) {
      log.warn(
        { orderId: orderIdStr, userId: String(order.userId || "") },
        "[email] sendOrderConfirmationSafe: no customer email on user record, skipping",
      );
      return;
    }

    const lang = opts.lang || "he";

    log.info(
      { orderId: orderIdStr, lang, smtpConfigured: isConfigured },
      "[email] sendOrderConfirmationSafe: calling sendOrderConfirmation",
    );

    const result = await sendOrderConfirmation(to, order, lang);

    log.info(
      { orderId: orderIdStr, accepted: result?.accepted, stub: result?.stub },
      "[email] sendOrderConfirmationSafe: sendOrderConfirmation returned",
    );

    // Mark as sent (atomic — filter on null prevents double-send on concurrent calls)
    await Order.updateOne(
      { _id: orderId, confirmationEmailSentAt: null },
      { $set: { confirmationEmailSentAt: new Date() } },
    );

    log.info(
      { orderId: orderIdStr },
      "[email] sendOrderConfirmationSafe: confirmation email sent and order updated",
    );
  } catch (err) {
    log.error(
      {
        orderId: orderIdStr,
        err: String(err?.message || err),
        stack: String(err?.stack || ""),
      },
      "[email] sendOrderConfirmationSafe: FAILED",
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
export async function sendRefundNotification(
  to,
  order,
  refundAmount,
  lang = "he",
) {
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
        ${isAr ? "رقم الطلب:" : "מספר ההזמנה:"}
        <strong style="color:#1a1a1a;font-size:16px;">#${orderNumber}</strong>
      </p>
      <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:16px 20px;margin-bottom:20px;text-align:center;">
        <p style="margin:0 0 4px;font-size:13px;color:#166534;">
          ${isAr ? "المبلغ المسترد" : "סכום ההחזר"}
        </p>
        <p style="margin:0;font-size:28px;font-weight:700;color:#166534;">${fmt(refundAmount)}</p>
      </div>
      <p style="margin:0 0 16px;color:#555;font-size:14px;line-height:1.6;">
        ${
          isAr
            ? "تم إرسال المبلغ إلى وسيلة الدفع الأصلية. قد يستغرق ظهور المبلغ في حسابك حتى 10 أيام عمل حسب البنك."
            : "הסכום הוחזר לאמצעי התשלום המקורי. ייתכן שייקח עד 10 ימי עסקים עד שהסכום יופיע בחשבונך, בהתאם לבנק."
        }
      </p>
      <p style="margin:0;color:#999;font-size:13px;">
        ${
          isAr
            ? "إذا كان لديك أسئلة، لا تتردد في الاتصال بنا."
            : "אם יש לך שאלות, אל תהסס ליצור איתנו קשר."
        }
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
export async function sendRefundNotificationSafe(
  orderId,
  refundAmount,
  opts = {},
) {
  const orderIdStr = String(orderId);
  try {
    const order = await Order.findById(orderId).lean();
    if (!order) return;

    const user = await User.findById(order.userId).select("email lang").lean();
    const to = String(user?.email || "")
      .trim()
      .toLowerCase();
    if (!to) return;

    const lang = opts.lang || String(user?.lang || "he");
    await sendRefundNotification(to, order, refundAmount, lang);

    log.info(
      { orderId: orderIdStr, refundAmount },
      "[email] sendRefundNotificationSafe: sent",
    );
  } catch (err) {
    log.error(
      { orderId: orderIdStr, err: String(err?.message || err) },
      "[email] sendRefundNotificationSafe: FAILED",
    );
  }
}

/**
 * sendB2BApprovalEmail — notifies user their B2B application was approved.
 */
export async function sendB2BApprovalEmail(
  to,
  { businessName, wholesaleTier },
  lang = "he",
) {
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
        ${
          isAr
            ? "يمكنك الآن الاستفادة من أسعار الجملة الخاصة عند التسوق. أسعار الجملة ستظهر تلقائياً على المنتجات."
            : "כעת תוכל ליהנות ממחירי סיטונאות מיוחדים בעת הקנייה. מחירי הסיטונאות יופיעו אוטומטית על המוצרים."
        }
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
        ${
          isAr
            ? "نأسف لإبلاغك أن طلب فتح حساب تجاري لم تتم الموافقة عليه في الوقت الحالي. إذا كانت لديك أي أسئلة أو ترغب في إعادة التقديم، لا تتردد في التواصل معنا."
            : "לצערנו, הבקשה לפתיחת חשבון עסקי לא אושרה כרגע. אם יש לך שאלות או שברצונך להגיש בקשה מחדש, אל תהסס ליצור איתנו קשר."
        }
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

/**
 * sendCheckoutOTP — sends a 6-digit OTP code to verify checkout.
 *
 * @param {string} to        Customer email
 * @param {string} name      Customer name
 * @param {string} otpCode   6-digit OTP code
 * @param {string} lang      "he" | "ar"
 */
export async function sendCheckoutOTP(to, name, otpCode, lang = "he") {
  const isAr = lang === "ar";
  const safeName = String(name || "").trim() || (isAr ? "عميلنا" : "הלקוח");
  const issuedAt = fmtDateTime(new Date(), lang);

  const subject = isAr
    ? `${STORE_NAME} — رمز تأكيد الطلب (OTP)`
    : `${STORE_NAME} — קוד אימות להזמנה (OTP)`;

  const html = `
<!DOCTYPE html>
<html lang="${isAr ? "ar" : "he"}">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:#f7f7f7;font-family:Arial,Helvetica,sans-serif;">
  <div dir="rtl" style="max-width:580px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:#111827;padding:28px 32px;text-align:center;">
      <p style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:1px;">${STORE_NAME}</p>
      <p style="margin:6px 0 0;color:#d1d5db;font-size:12px;">
        ${isAr ? "تحقق أمني لإتمام الطلب" : "אימות אבטחה להשלמת הזמנה"}
      </p>
    </div>
    <div style="padding:30px 32px;text-align:center;">
      <h2 style="margin:0 0 8px;color:#111827;font-size:20px;">
        ${isAr ? `مرحباً ${escapeHtml(safeName)}` : `שלום ${escapeHtml(safeName)}`}
      </h2>
      <p style="margin:0 0 24px;color:#4b5563;font-size:14px;line-height:1.6;">
        ${isAr ? "الرجاء إدخال الرمز التالي لإتمام تأكيد الطلب. هذا الرمز صالح لمدة 10 دقائق ويُستخدم لمرة واحدة فقط." : "יש להזין את הקוד הבא כדי לאשר את ההזמנה. הקוד בתוקף ל-10 דקות ולשימוש חד-פעמי."}
      </p>
      <div style="display:inline-block;background:#f9fafb;border:2px dashed #111827;border-radius:12px;padding:16px 36px;margin-bottom:18px;">
        <p style="margin:0;font-size:40px;font-weight:700;color:#111827;letter-spacing:10px;font-family:monospace;">${escapeHtml(otpCode)}</p>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin:8px 0 18px;border:1px solid #ececec;border-radius:8px;overflow:hidden;">
        <tbody>
          <tr>
            <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;color:#6b7280;width:40%;">${isAr ? "وقت الإرسال" : "שעת שליחה"}</td>
            <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-weight:500;">${escapeHtml(issuedAt)}</td>
          </tr>
          <tr>
            <td style="padding:8px 10px;color:#6b7280;width:40%;">${isAr ? "الصلاحية" : "תוקף"}</td>
            <td style="padding:8px 10px;font-weight:500;">${isAr ? "10 دقائق" : "10 דקות"}</td>
          </tr>
        </tbody>
      </table>
      <p style="margin:0;color:#9ca3af;font-size:13px;line-height:1.6;">
        ${isAr ? "إذا لم تطلب هذا الرمز، تجاهل هذا البريد. لا تشارك الرمز مع أي شخص." : "אם לא ביקשת את הקוד, ניתן להתעלם מהמייל. אין לשתף את הקוד עם אף גורם."}
      </p>
    </div>
    <div style="background:#f5f5f5;padding:16px 32px;text-align:center;border-top:1px solid #e0e0e0;">
      <p style="margin:0;color:#9ca3af;font-size:12px;">${STORE_NAME} &copy; ${new Date().getFullYear()}</p>
    </div>
  </div>
</body>
</html>`;

  const text = isAr
    ? `رمز تأكيد الطلب: ${otpCode}\nوقت الإرسال: ${issuedAt}\nالصلاحية: 10 دقائق (استخدام مرة واحدة)\nلا تشارك هذا الرمز مع أي شخص.`
    : `קוד אימות להזמנה: ${otpCode}\nשעת שליחה: ${issuedAt}\nתוקף: 10 דקות (חד-פעמי)\nאין לשתף את הקוד עם אף גורם.`;

  return send({ to, subject, html, text });
}

/**
 * sendAdminOrderNotification — notifies the admin (SMTP_USER) about a new order.
 *
 * @param {object} order   Order document (lean or mongoose)
 * @param {string} lang    "he" | "ar"
 */
export async function sendAdminOrderNotification(order, lang = "he") {
  const adminEmail = SMTP_USER;
  if (!adminEmail) {
    log.warn(
      "[email] sendAdminOrderNotification: SMTP_USER not configured, skipping",
    );
    return;
  }

  const isAr = lang === "ar";
  const orderNumber = order.orderNumber || order._id;
  const orderId = String(order._id || "");
  const total = Number(order.pricing?.total || 0);
  const subtotal = Number(order.pricing?.subtotal || 0);
  const shippingFee = Number(order.pricing?.shippingFee || 0);
  const discountTotal = Number(
    order.pricing?.discountTotal ||
      Number(order.pricing?.discounts?.coupon?.amount || 0) +
        Number(order.pricing?.discounts?.campaign?.amount || 0) +
        Number(order.pricing?.discounts?.offer?.amount || 0),
  );
  const customerName = String(order.shipping?.address?.fullName || "").trim();
  const customerPhone = String(
    order.shipping?.phone || order.shipping?.address?.phone || "",
  ).trim();
  const customerEmail = String(order.userId?.email || "").trim();
  const paymentLabel = resolvePaymentMethodLabel(order.paymentMethod, isAr);
  const shippingLabel = resolveShippingLabel(order.shipping, isAr);
  const shippingAddress = buildAddressLine(order.shipping?.address || {});
  const orderCreatedAt = fmtDateTime(order.createdAt, lang);
  const adminOrderUrl = `${
    process.env.FRONTEND_URL || "https://barberbang.com"
  }/admin/orders/${orderId}`;

  const itemsHtml = (order.items || [])
    .map((it) => {
      const name = isAr
        ? it.titleAr || it.titleHe || it.title || ""
        : it.titleHe || it.titleAr || it.title || "";
      const qty = Number(it.qty || 1);
      const unitPrice = Number(it.unitPrice || 0);
      const lineTotal = unitPrice * qty;
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid #f0f0f0;">${escapeHtml(name)}</td>
        <td style="padding:8px;border-bottom:1px solid #f0f0f0;text-align:center;">${qty}</td>
        <td style="padding:8px;border-bottom:1px solid #f0f0f0;text-align:end;">${fmt(unitPrice)}</td>
        <td style="padding:8px;border-bottom:1px solid #f0f0f0;text-align:end;font-weight:600;">${fmt(lineTotal)}</td>
      </tr>`;
    })
    .join("");

  const subject = `[${STORE_NAME}] ${
    isAr ? "طلب جديد" : "הזמנה חדשה"
  } #${orderNumber} — ${fmt(total)}`;

  const html = `
<!DOCTYPE html>
<html lang="${isAr ? "ar" : "he"}">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:#f7f7f7;font-family:Arial,Helvetica,sans-serif;">
  <div dir="rtl" style="max-width:700px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:#065f46;padding:24px 32px;">
      <p style="margin:0;color:#fff;font-size:20px;font-weight:700;">
        🛒 ${isAr ? "طلب جديد!" : "הזמנה חדשה!"} #${orderNumber}
      </p>
      <p style="margin:6px 0 0;color:#d1fae5;font-size:12px;">
        ${isAr ? `تاريخ الطلب: ${escapeHtml(orderCreatedAt)}` : `תאריך הזמנה: ${escapeHtml(orderCreatedAt)}`}
      </p>
    </div>
    <div style="padding:28px 32px;">

      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px;border:1px solid #ececec;border-radius:8px;overflow:hidden;">
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;color:#666;width:35%;">${isAr ? "رقم الطلب" : "מספר הזמנה"}:</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-weight:600;">#${escapeHtml(orderNumber)}</td>
        </tr>
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;color:#666;">${isAr ? "معرّف الطلب" : "מזהה הזמנה"}:</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-weight:600;">${escapeHtml(orderId)}</td>
        </tr>
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;color:#666;">${isAr ? "اسم العميل" : "שם הלקוח"}:</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-weight:600;">${escapeHtml(customerName || "-")}</td>
        </tr>
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;color:#666;">${isAr ? "رقم الهاتف" : "טלפון"}:</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-weight:600;">${escapeHtml(customerPhone || "-")}</td>
        </tr>
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;color:#666;">${isAr ? "البريد الإلكتروني" : "אימייל"}:</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-weight:600;">${escapeHtml(customerEmail || "-")}</td>
        </tr>
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;color:#666;">${isAr ? "طريقة الشحن/الاستلام" : "אופן משלוח/איסוף"}:</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;">${escapeHtml(shippingLabel)}</td>
        </tr>
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;color:#666;">${isAr ? "طريقة الدفع" : "אמצעי תשלום"}:</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;">${escapeHtml(paymentLabel)}</td>
        </tr>
        <tr>
          <td style="padding:8px 10px;color:#666;">${isAr ? "العنوان" : "כתובת"}:</td>
          <td style="padding:8px 10px;">${escapeHtml(shippingAddress || "-")}</td>
        </tr>
      </table>

      <hr style="border:none;border-top:1px solid #e0e0e0;margin:16px 0;" />

      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:8px;text-align:start;color:#333;">${isAr ? "المنتج" : "מוצר"}</th>
            <th style="padding:8px;text-align:center;color:#333;">${isAr ? "الكمية" : "כמות"}</th>
            <th style="padding:8px;text-align:end;color:#333;">${isAr ? "سعر الوحدة" : "מחיר יחידה"}</th>
            <th style="padding:8px;text-align:end;color:#333;">${isAr ? "الإجمالي" : "סה״כ"}</th>
          </tr>
        </thead>
        <tbody>${itemsHtml || `<tr><td colspan="4" style="padding:12px;text-align:center;color:#999;">${isAr ? "لا توجد عناصر" : "אין פריטים"}</td></tr>`}</tbody>
      </table>

      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:8px;border-top:2px solid #e5e7eb;">
        <tr>
          <td style="padding:8px 0;color:#666;">${isAr ? "المجموع الجزئي" : "סכום ביניים"}:</td>
          <td style="padding:8px 0;text-align:end;">${fmt(subtotal)}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;color:#666;">${isAr ? "الشحن" : "משלוח"}:</td>
          <td style="padding:8px 0;text-align:end;">${shippingFee > 0 ? fmt(shippingFee) : isAr ? "مجاني" : "חינם"}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;color:#666;">${isAr ? "الخصم" : "הנחה"}:</td>
          <td style="padding:8px 0;text-align:end;color:${discountTotal > 0 ? "#16a34a" : "#111827"};">${discountTotal > 0 ? `-${fmt(discountTotal)}` : fmt(0)}</td>
        </tr>
      </table>

      <div style="text-align:end;font-size:18px;font-weight:700;color:#111827;padding:10px 0 0;">
        ${isAr ? "المجموع الكلي" : "סה״כ"}: ${fmt(total)}
      </div>

      <div style="margin-top:20px;text-align:center;">
        <a href="${escapeHtml(adminOrderUrl)}" style="display:inline-block;background:#111827;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:600;">
          ${isAr ? "عرض الطلب في لوحة التحكم" : "צפייה בהזמנה בלוח הבקרה"}
        </a>
      </div>

    </div>
    <div style="background:#f5f5f5;padding:16px 32px;text-align:center;border-top:1px solid #e0e0e0;">
      <p style="margin:0;color:#999;font-size:12px;">${STORE_NAME} — ${new Date().toLocaleString(isAr ? "ar-IL" : "he-IL")}</p>
    </div>
  </div>
</body>
</html>`;

  const text = isAr
    ? `طلب جديد #${orderNumber}\nمعرّف الطلب: ${orderId}\nتاريخ الطلب: ${orderCreatedAt}\nالعميل: ${customerName || "-"}\nالهاتف: ${customerPhone || "-"}\nالإيميل: ${customerEmail || "-"}\nالشحن/الاستلام: ${shippingLabel}\nالعنوان: ${shippingAddress || "-"}\nطريقة الدفع: ${paymentLabel}\nالمجموع الجزئي: ${fmt(subtotal)}\nالشحن: ${shippingFee > 0 ? fmt(shippingFee) : "مجاني"}\nالخصم: ${discountTotal > 0 ? `-${fmt(discountTotal)}` : fmt(0)}\nالمجموع الكلي: ${fmt(total)}\nرابط الإدارة: ${adminOrderUrl}`
    : `הזמנה חדשה #${orderNumber}\nמזהה הזמנה: ${orderId}\nתאריך הזמנה: ${orderCreatedAt}\nלקוח: ${customerName || "-"}\nטלפון: ${customerPhone || "-"}\nאימייל: ${customerEmail || "-"}\nמשלוח/איסוף: ${shippingLabel}\nכתובת: ${shippingAddress || "-"}\nאמצעי תשלום: ${paymentLabel}\nסכום ביניים: ${fmt(subtotal)}\nמשלוח: ${shippingFee > 0 ? fmt(shippingFee) : "חינם"}\nהנחה: ${discountTotal > 0 ? `-${fmt(discountTotal)}` : fmt(0)}\nסה״כ: ${fmt(total)}\nקישור ניהול: ${adminOrderUrl}`;

  return send({ to: adminEmail, subject, html, text });
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
  sendCheckoutOTP,
  sendAdminOrderNotification,
};