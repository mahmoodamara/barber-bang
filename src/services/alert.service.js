import { AlertLog } from "../models/AlertLog.js";
import { sendOpsEmail } from "./email.service.js";
import { ENV } from "../utils/env.js";

function minutesToMs(m) {
  return Math.max(1, Number(m || 30)) * 60_000;
}

export async function sendAlertOnce({ key, subject, text, meta = {} }) {
  const throttleMs = minutesToMs(ENV.ALERT_THROTTLE_MINUTES || 30);
  const now = new Date();

  const existing = await AlertLog.findOne({ key }).lean();
  if (existing?.lastSentAt) {
    const last = new Date(existing.lastSentAt).getTime();
    if (Date.now() - last < throttleMs) return { skipped: true };
  }

  // keep alert logs for 14 days
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60_000);

  await AlertLog.updateOne(
    { key },
    {
      $set: { lastSentAt: now, meta, expiresAt },
      $setOnInsert: { key },
    },
    { upsert: true },
  );

  const to = ENV.ALERT_EMAIL_TO;
  if (to) await sendOpsEmail({ to, subject, text });

  return { sent: true };
}
