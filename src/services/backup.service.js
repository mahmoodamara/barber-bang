import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ENV } from "../utils/env.js";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export async function runMongoDump() {
  const dumpBin = ENV.MONGODUMP_PATH || "mongodump";
  const dir = ENV.BACKUP_DIR || "./backups";
  ensureDir(dir);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(dir, `dump-${ts}`);

  const args = ["--uri", ENV.MONGO_URI, "--out", outDir];

  await new Promise((resolve, reject) => {
    const p = spawn(dumpBin, args, { stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`mongodump_failed:${code}`))));
  });

  await cleanupOldBackups(dir, Number(ENV.BACKUP_RETENTION_DAYS || 7));
  return outDir;
}

async function cleanupOldBackups(dir, retentionDays) {
  const keepMs = Math.max(1, retentionDays) * 24 * 60 * 60_000;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const now = Date.now();

  for (const e of entries) {
    const p = path.join(dir, e.name);
    const st = fs.statSync(p);
    if (now - st.mtimeMs > keepMs) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  }
}
