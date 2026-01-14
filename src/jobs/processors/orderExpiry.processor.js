import { cancelExpiredOrders } from "../../services/payment.service.js";
import { ENV } from "../../utils/env.js";

export async function process(_job) {
  const limit = Number(ENV.ORDER_EXPIRY_SWEEP_LIMIT || 50);
  await cancelExpiredOrders({ limit });
}
