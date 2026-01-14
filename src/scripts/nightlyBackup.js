import fs from "node:fs";
import path from "node:path";
import { runMongoDump } from "../services/backup.service.js";
import { ENV } from "../utils/env.js";

function lockPath() {
  const dir = ENV.BACKUP_DIR || "./backups";
  return path.join(dir, ".backup.lock");
}

async function main() {
  const lp = lockPath();

  try {
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    fs.openSync(lp, "wx"); // fails if exists
  } catch {
    // eslint-disable-next-line no-console
    console.log("Backup skipped: lock exists");
    return;
  }

  try {
    const out = await runMongoDump();
    // eslint-disable-next-line no-console
    console.log("Backup created:", out);
  } finally {
    try {
      fs.rmSync(lp, { force: true });
    } catch {
      // ignore
    }
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
