import { ENV } from "../utils/env.js";
import { tryAcquireLease, renewLease } from "../services/leaseLock.service.js";
import { enqueueJob } from "../jobs/jobRunner.js";
import { cancelExpiredOrders, cancelStaleDraftOrders, reconcilePaidOrders } from "../services/payment.service.js";

function ms(envName, def) {
  return Math.max(1000, Number(ENV[envName] || def));
}

export function startLeaderScheduler({ isDbReadyFn } = {}) {
  const ownerId = String(ENV.INSTANCE_ID || "unknown").trim();
  const leaseName = String(ENV.LEASE_NAME || "global-scheduler").trim();

  const heartbeatMs = ms("LEASE_HEARTBEAT_MS", 5000);
  const leaseTtlMs = ms("LEASE_TTL_MS", 20000); // used implicitly in lease service
  void leaseTtlMs; // keep documented

  const readModelsEveryMs = ms("READ_MODELS_REFRESH_EVERY_MS", 60000);
  const maxTimeMs = Number(ENV.QUERY_MAX_TIME_MS || 4000);

  const cancelEveryMs = ms("WORKER_CANCEL_SWEEP_EVERY_MS", 30000);
  const cancelLimit = Number(ENV.WORKER_CANCEL_SWEEP_LIMIT || 50);
  const confirmEveryMs = ms("WORKER_STOCK_CONFIRM_SWEEP_EVERY_MS", 60000);
  const confirmLimit = Number(ENV.WORKER_STOCK_CONFIRM_SWEEP_LIMIT || 50);
  const draftEveryMs = ms("WORKER_DRAFT_CANCEL_SWEEP_EVERY_MS", 60000);
  const draftLimit = Number(ENV.WORKER_DRAFT_CANCEL_SWEEP_LIMIT || 50);

  let isLeader = false;
  let lastReadSlot = -1;
  let lastCancelSlot = -1;
  let lastConfirmSlot = -1;
  let lastDraftSlot = -1;

  async function tick() {
    try {
      if (typeof isDbReadyFn === "function" && !isDbReadyFn()) return;

      if (!isLeader) {
        isLeader = await tryAcquireLease({ name: leaseName, ownerId });
        return;
      }

      const renewed = await renewLease({ name: leaseName, ownerId });
      if (!renewed) {
        isLeader = false;
        return;
      }

      // 1) Read models refresh (deduped per slot)
      const readSlot = Math.floor(Date.now() / readModelsEveryMs);
      if (readSlot !== lastReadSlot) {
        lastReadSlot = readSlot;
        await enqueueJob({
          name: "read_models_refresh",
          payload: { maxTimeMs },
          dedupeKey: `read_models_refresh:${readSlot}`,
          runAt: new Date(),
          maxAttempts: 3,
        });
      }

      // 2) Cancel expired orders (leader-only execution; no duplicate sweeps)
      const cancelSlot = Math.floor(Date.now() / cancelEveryMs);
      if (cancelSlot !== lastCancelSlot) {
        lastCancelSlot = cancelSlot;
        try {
          await cancelExpiredOrders({ limit: cancelLimit });
        } catch {
          // never crash scheduler
        }
      }

      // 3) Reconcile payment-received but unconfirmed orders
      const confirmSlot = Math.floor(Date.now() / confirmEveryMs);
      if (confirmSlot !== lastConfirmSlot) {
        lastConfirmSlot = confirmSlot;
        try {
          await reconcilePaidOrders({ limit: confirmLimit });
        } catch {
          // never crash scheduler
        }
      }

      // 4) Cancel stale draft orders (no reservation leak)
      const draftSlot = Math.floor(Date.now() / draftEveryMs);
      if (draftSlot !== lastDraftSlot) {
        lastDraftSlot = draftSlot;
        try {
          await cancelStaleDraftOrders({ limit: draftLimit });
        } catch {
          // never crash scheduler
        }
      }
    } catch {
      isLeader = false;
    }
  }

  const t = setInterval(tick, heartbeatMs);
  t.unref();

  return () => clearInterval(t);
}
