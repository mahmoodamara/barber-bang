import { refreshReadModels } from "../../services/readModels.service.js";

export async function process(job) {
  const maxTimeMs = job?.payload?.maxTimeMs || 4000;
  await refreshReadModels({ maxTimeMs });
}
