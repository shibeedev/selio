import { DYNAMIC_RESPONSE_SIGNATURE_HEADER, DYNAMIC_REVIEW_SIGNATURE_HEADER } from "../../shared/crypto/signatures.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import type { ReviewService } from "./review.service.js";

export function createReviewController(service: ReviewService) {
  return {
    review: asyncHandler(async (req, res) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const answer = service.review(body, req.header(DYNAMIC_REVIEW_SIGNATURE_HEADER));
      if (answer.signature) res.setHeader(DYNAMIC_RESPONSE_SIGNATURE_HEADER, answer.signature);
      res.status(answer.status).type("application/json").send(answer.body);
    }),
  };
}

export type ReviewController = ReturnType<typeof createReviewController>;
