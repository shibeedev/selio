import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import type { DeploymentsService } from "./deployments.service.js";

export function createDeploymentsController(service: DeploymentsService) {
  return {
    getDeployment: asyncHandler(async (req, res) => {
      // Fork deployments are re-created every day, so every answer, a 404 included, must be revalidated.
      res.set("Cache-Control", "no-cache");
      res.json(service.getDeployment(req.params.file ?? ""));
    }),
  };
}

export type DeploymentsController = ReturnType<typeof createDeploymentsController>;
