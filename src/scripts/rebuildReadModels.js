import { connectDb, disconnectDb } from "../data/db.js";
import { refreshReadModels } from "../services/readModels.service.js";

async function main() {
  await connectDb();
  const out = await refreshReadModels({ maxTimeMs: 8000 });
  // eslint-disable-next-line no-console
  console.log(out);
  await disconnectDb();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
