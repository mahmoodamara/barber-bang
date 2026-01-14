import nodemailer from "nodemailer";
import { logger } from "../utils/logger.js";
import { ENV } from "../utils/env.js";

let transporterPromise;

/**
 * Build / memoize SMTP transporter.
 * - Returns null when SMTP is not configured.
 * - Uses TLS automatically for port 465 unless SMTP_SECURE explicitly set.
 */
function getTransporter() {
  if (transporterPromise) return transporterPromise;

  if (ENV.MAIL_DRIVER && ENV.MAIL_DRIVER !== "smtp") {
    transporterPromise = Promise.resolve(null);
    return transporterPromise;
  }

  const host = ENV.SMTP_HOST;
  const port = Number(ENV.SMTP_PORT);
  const user = ENV.SMTP_USER;
  const pass = ENV.SMTP_PASS;
  const secure = ENV.SMTP_SECURE !== undefined ? ENV.SMTP_SECURE : port === 465; // honor explicit value
  const name = ENV.SMTP_NAME;

  if (!host || !port || !user || !pass) {
    transporterPromise = Promise.resolve(null);
    return transporterPromise;
  }

  transporterPromise = Promise.resolve(
    nodemailer.createTransport({
      host,
      port,
      secure,
      name,
      auth: { user, pass },

      // Reasonable timeouts (prevent hanging)
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,

      // Pooling can help under load (safe defaults)
      pool: true,
      maxConnections: 3,
      maxMessages: 200,
    }),
  );

  return transporterPromise;
}

function getFrom() {
  return ENV.MAIL_FROM || ENV.SMTP_FROM || ENV.SMTP_USER || "no-reply@example.com";
}

function normalizeRecipient(v) {
  if (!v) return null;

  // support string, array of strings, or { address } objects (defensive)
  if (Array.isArray(v)) {
    const arr = v
      .flatMap((x) => (x && typeof x === "object" ? [x.address] : [x]))
      .map((x) => String(x || "").trim())
      .filter(Boolean);
    return arr.length ? arr.join(", ") : null;
  }

  if (typeof v === "object") {
    const addr = String(v.address || "").trim();
    return addr || null;
  }

  const s = String(v).trim();
  return s || null;
}

function ensureRecipients(payload) {
  const to = normalizeRecipient(payload?.to);
  const cc = normalizeRecipient(payload?.cc);
  const bcc = normalizeRecipient(payload?.bcc);

  // Nodemailer requires at least one recipient among to/cc/bcc
  const hasAny = Boolean(to || cc || bcc);
  return { to, cc, bcc, hasAny };
}

async function sendMail(payload = {}) {
  const transporter = await getTransporter();
  if (!transporter) {
    return { sent: false, skipped: true, reason: "NOT_CONFIGURED" };
  }

  const { to, cc, bcc, hasAny } = ensureRecipients(payload);
  if (!hasAny) {
    return { sent: false, skipped: true, reason: "MISSING_TO" };
  }

  const from = payload.from || getFrom();

  // If you need custom SMTP envelope (bounce/return-path), keep it valid with recipients.
  const envelopeFrom = ENV.MAIL_ENVELOPE_FROM || ENV.MAIL_BOUNCE_TO || undefined;
  const envelope = envelopeFrom
    ? {
        from: envelopeFrom,
        to: []
          .concat(to ? [to] : [])
          .concat(cc ? [cc] : [])
          .concat(bcc ? [bcc] : [])
          .join(", "),
      }
    : undefined;

  const mailOptions = {
    ...payload,
    from,
    to,
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    ...(envelope ? { envelope } : {}),
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    return { sent: true, messageId: info?.messageId };
  } catch (err) {
    logger.error(
      {
        err: { name: err?.name, message: err?.message, code: err?.code },
        to,
      },
      "SMTP send failed",
    );
    return { sent: false, skipped: false, reason: "SMTP_ERROR" };
  }
}

export async function sendGenericEmail({ to, subject, text, html } = {}) {
  const toNorm = normalizeRecipient(to);
  if (!toNorm) return { sent: false, skipped: true, reason: "MISSING_TO" };

  return sendMail({
    to: toNorm,
    from: getFrom(),
    subject: subject || "",
    text: text || "",
    html: html || undefined,
  });
}

export async function sendPasswordResetEmail({ to, token, requestId } = {}) {
  const toNorm = normalizeRecipient(to);
  if (!toNorm || !token) {
    return { sent: false, skipped: true, reason: "MISSING_PARAMS" };
  }

  const resetUrl = `${ENV.FRONTEND_URL}/auth/reset-password?token=${encodeURIComponent(token)}`;
  logger.info({ to: toNorm, requestId }, "Password reset email send attempt");

  return sendMail({
    to: toNorm,
    from: getFrom(),
    subject: "Reset your password",
    text: `Use this link to reset your password: ${resetUrl}`,
    html: `<p>Use this link to reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`,
  });
}

export async function sendEmailOtp({ to, code, requestId } = {}) {
  const toNorm = normalizeRecipient(to);
  const codeNorm = String(code || "").replace(/\D/g, "").slice(0, 6);

  if (!toNorm || !codeNorm) {
    return { sent: false, skipped: true, reason: "MISSING_PARAMS" };
  }

  logger.info({ to: toNorm, requestId }, "Email OTP send attempt");

  return sendMail({
    to: toNorm,
    from: getFrom(),
    subject: "Verify your email",
    text: `Your verification code is: ${codeNorm}`,
    html: `<p>Your verification code is:</p><p><strong>${codeNorm}</strong></p>`,
  });
}
