// src/jobs/productRanking.job.js
import { recalculateProductRanking } from "../services/ranking.service.js";

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

let intervalId = null;
let isRunning = false;
let lastRunAt = null;
let lastRunStats = null;

async function runRankingJob() {
  if (isRunning) {
    console.info("[ranking-job] Skipping - previous run still in progress");
    return null;
  }

  isRunning = true;
  const start = Date.now();
  const now = new Date();

  try {
    const batchSize = Number(process.env.PRODUCT_RANKING_BATCH_SIZE) || 500;
    const stats = await recalculateProductRanking({ now, batchSize });
    lastRunAt = now;
    lastRunStats = {
      runAt: now.toISOString(),
      durationMs: Date.now() - start,
      ...stats,
    };

    console.info("[ranking-job] Completed:", JSON.stringify(lastRunStats));
    return lastRunStats;
  } catch (err) {
    console.error("[ranking-job] Failed:", String(err?.message || err));
    return { error: String(err?.message || err) };
  } finally {
    isRunning = false;
  }
}

export function startProductRankingJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (intervalId) {
    console.warn("[ranking-job] Job already running, ignoring start request");
    return getProductRankingJobStatus();
  }

  const ms = Number(intervalMs) || DEFAULT_INTERVAL_MS;
  console.info(`[ranking-job] Starting with interval ${ms}ms`);

  runRankingJob().catch((err) => {
    console.error("[ranking-job] Initial run failed:", String(err?.message || err));
  });

  intervalId = setInterval(() => {
    runRankingJob().catch((err) => {
      console.error("[ranking-job] Scheduled run failed:", String(err?.message || err));
    });
  }, ms);

  if (intervalId.unref) intervalId.unref();

  return getProductRankingJobStatus();
}

export function stopProductRankingJob() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.info("[ranking-job] Stopped");
  }
}

export function getProductRankingJobStatus() {
  return {
    running: !!intervalId,
    currentlyExecuting: isRunning,
    lastRunAt,
    lastRunStats,
  };
}

export async function triggerProductRankingJob() {
  return runRankingJob();
}

export { runRankingJob };
