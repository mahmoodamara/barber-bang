import { generateInvoicePdf } from "../../services/invoice.service.js";
import { sendInvoiceEmailForOrder } from "../../services/email.service.js";
import { Order } from "../../models/Order.js";

export async function process(job) {
  const { orderId } = job.payload || {};
  if (!orderId) throw new Error("JOB_INVALID_PAYLOAD");

  try {
    const pdfBuffer = await generateInvoicePdf(orderId);
    await sendInvoiceEmailForOrder({ orderId, pdfBuffer });
    await Order.updateOne(
      { _id: orderId },
      { $set: { invoiceStatus: "issued", invoiceIssuedAt: new Date() } },
    );
  } catch (err) {
    await Order.updateOne(
      { _id: orderId },
      { $set: { invoiceStatus: "failed" } },
    ).catch(() => {});
    throw err;
  }
}
