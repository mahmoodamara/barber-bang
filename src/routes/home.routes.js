// src/routes/home.routes.js
import express from "express";
import { getHomeData } from "../services/home.service.js";
import { sendOk, setCacheHeaders } from "../utils/response.js";
import { withCache, buildHomeCacheKey } from "../utils/cache.js";

const router = express.Router();

const HOME_CACHE_TTL_MS = 60_000; // 60s
const HOME_SMAXAGE = 60;
const HOME_STALE_REVALIDATE = 120;

router.get("/", async (req, res, next) => {
  try {
    const lang = req.lang || "he";
    const key = buildHomeCacheKey(lang);
    const { data } = await withCache(key, () => getHomeData(lang), {
      ttlMs: HOME_CACHE_TTL_MS,
    });
    setCacheHeaders(res, {
      sMaxAge: HOME_SMAXAGE,
      staleWhileRevalidate: HOME_STALE_REVALIDATE,
      vary: "Accept-Language",
    });
    return sendOk(res, data);
  } catch (e) {
    return next(e);
  }
});

export default router;
