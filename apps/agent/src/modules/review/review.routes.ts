import express, { Router } from "express";
import type { ReviewController } from "./review.controller.js";

export function createReviewRouter(controller: ReviewController): Router {
  const router = Router();
  // Raw bytes: express.json() would break the x-dynamic-signature check.
  router.post("/dynamic/transaction-review", express.raw({ type: "application/json", limit: "1mb" }), controller.review);
  return router;
}
