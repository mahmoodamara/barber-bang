import nodemailer from "nodemailer";
import { ENV } from "../utils/env.js";
import { Order } from "../models/Order.js";
import { User } from "../models/User.js";

const transporter = nodemailer.createTransport({
  host: ENV.SMTP_HOST,
  port: Number(ENV.SMTP_PORT || 587),
  secure: Number(ENV.SMTP_PORT || 587) === 465,
  auth: ENV.SMTP_USER && ENV.SMTP_PASS ? { user: ENV.SMTP_USER, pass: ENV.SMTP_PASS } : undefined,

  pool: true,
  maxConnections: 5,
  maxMessages: 200,

  connectionTimeout: 15_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
});

/**
 * Backward/forward compatible invoice email sender.
 *
 * Supported signatures:
 * 1) sendInvoiceEmail({ to, orderId, pdfBuffer })
 * 2) sendInvoiceEmail(orderId, pdfBuffer, to)
 */
export async function sendInvoiceEmail(arg1, arg2, arg3) {
  let to;
  let orderId;
  let pdfBuffer;

  if (arg1 && typeof arg1 === "object") {
    ({ to, orderId, pdfBuffer } = arg1);
  } else {
    orderId = arg1;
    pdfBuffer = arg2;
    to = arg3;
  }

  if (!to) {
    const err = new Error("INVOICE_EMAIL_TO_REQUIRED");
    err.statusCode = 500;
    throw err;
  }
  if (!orderId) {
    const err = new Error("INVOICE_EMAIL_ORDER_ID_REQUIRED");
    err.statusCode = 500;
    throw err;
  }
  if (!pdfBuffer) {
    const err = new Error("INVOICE_EMAIL_PDF_REQUIRED");
    err.statusCode = 500;
    throw err;
  }

  await transporter.sendMail({
    from: ENV.SMTP_FROM,
    to,
    subject: "Your Invoice",
    text: `Invoice for order ${orderId}`,
    attachments: [{ filename: "invoice.pdf", content: pdfBuffer }],
  });
}

/**
 * Production-friendly helper:
 * - Resolves recipient email from order (guestEmail) or user.emailLower
 * - Uses sendInvoiceEmail() for actual sending
 */
export async function sendInvoiceEmailForOrder({ orderId, pdfBuffer }) {
  const order = await Order.findById(orderId).select("userId guestEmail").lean();
  if (!order) {
    const err = new Error("ORDER_NOT_FOUND");
    err.statusCode = 404;
    throw err;
  }

  let to = order.guestEmail || null;
  if (!to && order.userId) {
    const user = await User.findById(order.userId).select("emailLower email").lean();
    to = user?.emailLower || user?.email || null;
  }

  if (!to) {
    const err = new Error("INVOICE_EMAIL_NO_RECIPIENT");
    err.statusCode = 409;
    throw err;
  }

  await sendInvoiceEmail({ to, orderId, pdfBuffer });
}

/**
 * Ops alert email (optional).
 * - Requires SMTP + ALERT_EMAIL_TO
 * - Safe no-op if not configured.
 */
export async function sendOpsEmail({ subject, text, meta } = {}) {
  if (!ENV.SMTP_HOST || !ENV.SMTP_FROM || !ENV.ALERT_EMAIL_TO) {
    return { sent: false, skipped: true, reason: "SMTP_OR_ALERT_EMAIL_NOT_CONFIGURED" };
  }

  const body = [
    text || "",
    meta ? `\n\nMeta:\n${JSON.stringify(meta, null, 2)}` : "",
  ].join("");

  await transporter.sendMail({
    from: ENV.SMTP_FROM,
    to: ENV.ALERT_EMAIL_TO,
    subject: subject || "Ops Alert",
    text: body,
  });

  return { sent: true };
}
