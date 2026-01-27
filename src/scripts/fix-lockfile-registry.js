import fs from "fs";

const LOCK = "package-lock.json";
const FROM = "https://packages.applied-caas-gateway1.internal.api.openai.org/artifactory/api/npm/npm-public/";
const TO = "https://registry.npmjs.org/";

const raw = fs.readFileSync(LOCK, "utf8");
const patched = raw.split(FROM).join(TO);

if (patched === raw) {
  console.log("[fix-lockfile] No internal registry URLs found.");
  process.exit(0);
}

fs.writeFileSync(LOCK, patched, "utf8");
console.log("[fix-lockfile] Rewrote internal registry URLs to npmjs.org");
