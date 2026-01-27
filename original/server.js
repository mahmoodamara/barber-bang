import "dotenv/config";
import { app } from "./app.js";
import { connectDB } from "./config/db.js";

const PORT = Number(process.env.PORT || 4000);

await connectDB();

app.listen(PORT, () => {
  console.log(`[server] running on http://localhost:${PORT}`);
});
