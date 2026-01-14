import { performance } from "node:perf_hooks";

const BASE_URL = String(process.env.BASE_URL || "http://localhost:4000").replace(/\/+$/, "");
const DURATION_MS = Number(process.env.DURATION_MS || 15000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 10);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 10000);

const AUTH_TOKEN = String(process.env.AUTH_TOKEN || "").trim();
const AUTH_EMAIL = String(process.env.AUTH_EMAIL || "").trim();
const AUTH_PASSWORD = String(process.env.AUTH_PASSWORD || "");

const SCENARIOS = [
  {
    name: "search_text",
    method: "GET",
    path: "/api/v1/catalog/products?q=clipper&limit=20",
  },
  {
    name: "popular_sort",
    method: "GET",
    path: "/api/v1/catalog/products?sort=popular&limit=20",
  },
  {
    name: "home_payload",
    method: "GET",
    path: "/api/v1/catalog/home?productsLimit=6&reviewsLimit=3",
  },
  {
    name: "auth_burst",
    method: "POST",
    path: "/api/v1/auth/login",
    body: AUTH_EMAIL && AUTH_PASSWORD ? { email: AUTH_EMAIL, password: AUTH_PASSWORD } : null,
    requires: "auth_credentials",
  },
  {
    name: "orders_list",
    method: "GET",
    path: "/api/v1/orders?page=1&limit=20",
    requires: "auth_token",
  },
];

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function fetchOnce({ method, path, body, headers }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS).unref();
  const start = performance.now();

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    await res.arrayBuffer().catch(() => {});
    const ms = performance.now() - start;
    return { ok: res.ok, status: res.status, ms };
  } catch (err) {
    const ms = performance.now() - start;
    return { ok: false, status: 0, ms, error: err?.name || "ERR" };
  } finally {
    clearTimeout(timeout);
  }
}

async function runScenario(scenario) {
  const endAt = Date.now() + DURATION_MS;
  const latencies = [];
  const statusCounts = new Map();
  let errors = 0;

  const headers = { "content-type": "application/json" };
  if (scenario.requires === "auth_token") {
    headers.authorization = `Bearer ${AUTH_TOKEN}`;
  }

  async function worker() {
    while (Date.now() < endAt) {
      const res = await fetchOnce({
        method: scenario.method,
        path: scenario.path,
        body: scenario.body,
        headers,
      });
      latencies.push(res.ms);
      const key = String(res.status || 0);
      statusCounts.set(key, (statusCounts.get(key) || 0) + 1);
      if (!res.ok) errors += 1;
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  return {
    name: scenario.name,
    count: latencies.length,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    errors,
    statusCounts,
  };
}

async function main() {
  const active = SCENARIOS.filter((s) => {
    if (s.requires === "auth_token") return Boolean(AUTH_TOKEN);
    if (s.requires === "auth_credentials") return Boolean(AUTH_EMAIL && AUTH_PASSWORD);
    return true;
  });

  if (!active.length) {
    // eslint-disable-next-line no-console
    console.log("No scenarios to run (missing auth credentials/token).");
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`Base URL: ${BASE_URL}`);
  // eslint-disable-next-line no-console
  console.log(`Duration: ${DURATION_MS} ms, Concurrency: ${CONCURRENCY}`);

  for (const scenario of active) {
    // eslint-disable-next-line no-console
    console.log(`\nRunning: ${scenario.name}`);
    const out = await runScenario(scenario);
    const status = [...out.statusCounts.entries()]
      .map(([code, count]) => `${code}:${count}`)
      .join(" ");

    // eslint-disable-next-line no-console
    console.log(
      `count=${out.count} errors=${out.errors} p50=${out.p50.toFixed(1)}ms p95=${out.p95.toFixed(
        1,
      )}ms p99=${out.p99.toFixed(1)}ms status=[${status}]`,
    );
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
