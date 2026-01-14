import { runOpsMonitors } from "../../services/opsMonitor.service.js";

export async function process(_job) {
  await runOpsMonitors();
}
