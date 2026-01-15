import nodemailer from "nodemailer";
import { logger } from "../utils/logger.js";
import { ENV } from "../utils/env.js";

let transporterPromise;

function getTransporter() {
  if (transporterPromise) return transporterPromise;
  if (ENV.MAIL_DRIVER && ENV.MAIL_DRIVER !== "smtp") {
    transporterPromise = Promise.resolve(null);
    return transporterPromise;
  }
  const host = ENV.SMTP_HOST;
  const port = ENV.SMTP_PORT;
  const user = ENV.SMTP_USER;
  const pass = ENV.SMTP_PASS;
  const secure = ENV.SMTP_SECURE ?? Number(port) === 465;
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
    }),
  );
  return transporterPromise;
}

function getFrom() {
  return ENV.MAIL_FROM || ENV.SMTP_FROM || ENV.SMTP_USER || "no-reply@example.com";
}

async function sendMail(payload) {
  const transporter = await getTransporter();
  if (!transporter) {
    return { sent: false, skipped: true, reason: "NOT_CONFIGURED" };
  }

  try {
    const envelopeFrom = ENV.MAIL_ENVELOPE_FROM || undefined;
    const bounceTo = ENV.MAIL_BOUNCE_TO || undefined;
    const envelope = envelopeFrom || bounceTo ? { from: envelopeFrom, to: bounceTo } : undefined;
    const info = await transporter.sendMail({ ...payload, envelope });
    return { sent: true, messageId: info?.messageId };
  } catch (err) {
    logger.error(
      { err: { name: err?.name, message: err?.message }, to: payload?.to },
      "SMTP send failed",
    );
    return { sent: false, skipped: false, reason: "SMTP_ERROR" };
  }
}

export async function sendGenericEmail({ to, subject, text, html } = {}) {
  if (!to) return { sent: false, skipped: true, reason: "MISSING_TO" };
  return sendMail({
    to,
    from: getFrom(),
    subject: subject || "",
    text: text || "",
    html: html || undefined,
  });
}

export async function sendPasswordResetEmail({ to, token, requestId } = {}) {
  if (!to || !token) {
    return { sent: false, skipped: true, reason: "MISSING_PARAMS" };
  }

  const resetUrl = `${ENV.FRONTEND_URL}/auth/reset-password?token=${encodeURIComponent(token)}`;
  logger.info({ to, requestId }, "Password reset email send attempt");

  return sendMail({
    to,
    from: getFrom(),
    subject: "Reset your password",
    text: `Use this link to reset your password: ${resetUrl}`,
    html: `<p>Use this link to reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`,
  });
}

export async function sendEmailOtp({ to, code, requestId } = {}) {
  if (!to || !code) {
    return { sent: false, skipped: true, reason: "MISSING_PARAMS" };
  }

  logger.info({ to, requestId }, "Email OTP send attempt");
  return sendMail({
    to,
    from: getFrom(),
    subject: "Verify your email",
    text: `Your verification code is: ${code}`,
    html: `<p>Your verification code is:</p><p><strong>${code}</strong></p>`,
  });
}
