// src/routes/home.routes.js
import express from "express";
import { getHomeData } from "../services/home.service.js";
import { sendOk } from "../utils/response.js";

const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const data = await getHomeData(req.lang);
    return sendOk(res, data);
  } catch (e) {
    return next(e);
  }
});

export default router;
