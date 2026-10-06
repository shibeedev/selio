import type { Transactional } from "../../shared/db/database.js";
import type { ChainPort } from "../../shared/integrations/chain/chain.gateway.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import type { DelegationPort } from "../delegations/index.js";
import type { IntentRepository } from "../executor/intents.repository.js";
import { createReviewController } from "./review.controller.js";
import { createReviewRouter } from "./review.routes.js";
import { ReviewService, type ReviewServiceOptions } from "./review.service.js";

export { ReviewService } from "./review.service.js";

export interface ReviewModuleDeps {
  intents: IntentRepository;
  delegations: Pick<DelegationPort, "findByWalletId">;
  chain: Pick<ChainPort, "deployment">;
  inTransaction: Transactional;
  logger: Logger;
  options: ReviewServiceOptions;
  now?: () => number;
}

export function createReviewModule(deps: ReviewModuleDeps) {
  const service = new ReviewService(
    deps.intents,
    deps.delegations,
    deps.chain,
    deps.inTransaction,
    deps.logger.child({ module: "review" }),
    deps.options,
    deps.now,
  );
  return { service, router: createReviewRouter(createReviewController(service)) };
}
