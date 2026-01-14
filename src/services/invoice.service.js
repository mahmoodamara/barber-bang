import puppeteer from "puppeteer-core";
import { ENV } from "../utils/env.js";
import { Order } from "../models/Order.js";
import { toMajorUnits } from "../utils/money.js";

let browserPromise;
let browserInstance;
let activeJobs = 0;
let jobsSinceLaunch = 0;
let launchedAtMs = 0;
let recyclePending = false;
const waiters = [];

function limits() {
  return {
    maxConcurrency: Number(ENV.PDF_MAX_CONCURRENCY || 2),
    recycleJobs: Number(ENV.PDF_BROWSER_RECYCLE_JOBS || 50),
    maxAgeMs: Number(ENV.PDF_BROWSER_MAX_AGE_MS || 30 * 60 * 1000),
  };
}

async function acquireSlot() {
  const { maxConcurrency } = limits();
  if (activeJobs < maxConcurrency) {
    activeJobs += 1;
    return;
  }
  await new Promise((resolve) => waiters.push(resolve));
  activeJobs += 1;
}

async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
  }
  browserInstance = null;
  browserPromise = null;
  launchedAtMs = 0;
  jobsSinceLaunch = 0;
  recyclePending = false;
}

async function recycleIfNeeded() {
  if (!browserInstance) return;
  const { recycleJobs, maxAgeMs } = limits();
  const tooManyJobs = recycleJobs > 0 && jobsSinceLaunch >= recycleJobs;
  const tooOld = maxAgeMs > 0 && launchedAtMs && Date.now() - launchedAtMs >= maxAgeMs;
  if (!tooManyJobs && !tooOld) return;

  if (activeJobs > 0) {
    recyclePending = true;
    return;
  }
  await closeBrowser();
}

async function releaseSlot() {
  activeJobs = Math.max(0, activeJobs - 1);
  const next = waiters.shift();
  if (next) next();
  if (activeJobs === 0 && recyclePending) {
    await recycleIfNeeded();
  }
}

async function getBrowser() {
  if (!browserPromise) {
    const execPath = ENV.CHROME_EXECUTABLE_PATH || process.env.CHROME_EXECUTABLE_PATH;
    if (!execPath) {
      const err = new Error("CHROME_EXECUTABLE_PATH_REQUIRED");
      err.statusCode = 500;
      throw err;
    }

    browserPromise = puppeteer
      .launch({
        executablePath: execPath,
        headless: "new",
      })
      .then((b) => {
        browserInstance = b;
        launchedAtMs = Date.now();
        jobsSinceLaunch = 0;
        return b;
      });
  }
  return browserPromise;
}

export async function generateInvoicePdf(orderId) {
  const order = await Order.findById(orderId).lean();
  if (!order) {
    const err = new Error("ORDER_NOT_FOUND");
    err.statusCode = 404;
    throw err;
  }

  const timeoutMs = Number(ENV.PDF_TIMEOUT_MS || 15000);

  await acquireSlot();
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    page.setDefaultTimeout(timeoutMs);

    // Minimal safe HTML (لا تدخل user input خام هنا)
    await page.setContent(
      `<html><body style="font-family: Arial">
        <h1>Invoice</h1>
        <p>Order: ${String(order._id)}</p>
        <p>Status: ${String(order.status)}</p>
        <p>Total: ${String(toMajorUnits(order.pricing?.grandTotal ?? 0, order.pricing?.currency ?? "ILS"))} ${String(order.pricing?.currency ?? "")}</p>
      </body></html>`,
      { waitUntil: "domcontentloaded" },
    );

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
    });

    jobsSinceLaunch += 1;
    return pdf;
  } finally {
    await page.close().catch(() => {});
    await releaseSlot();
    await recycleIfNeeded();
  }
}
