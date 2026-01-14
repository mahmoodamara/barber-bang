import mongoose from "mongoose";
import { NotificationLog } from "../../models/NotificationLog.js";
import { sendGenericEmail } from "../../services/mail.service.js";

const { Types } = mongoose;

export async function process(job) {
  const id = job?.payload?.notificationId;
  if (!id || !Types.ObjectId.isValid(String(id))) throw new Error("JOB_INVALID_PAYLOAD");

  const log = await NotificationLog.findById(id);
  if (!log) return;

  if (log.status === "sent" || log.status === "skipped") return;

  log.attempts = Number(log.attempts || 0) + 1;

  if (log.channel !== "email") {
    log.status = "skipped";
    log.lastError = "UNSUPPORTED_CHANNEL";
    await log.save();
    return;
  }

  const res = await sendGenericEmail({
    to: log.to,
    subject: log.subject,
    text: log.text,
    html: log.html,
  });

  if (res?.sent) {
    log.status = "sent";
    log.sentAt = new Date();
    log.lastError = null;
    await log.save();
    return;
  }

  if (res?.skipped) {
    log.status = "skipped";
    log.lastError = String(res.reason || "SKIPPED").slice(0, 300);
    await log.save();
    return;
  }

  log.status = "failed";
  log.lastError = String(res?.reason || "SEND_FAILED").slice(0, 300);
  await log.save();
}

