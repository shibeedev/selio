import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { capacityHistoryQuerySchema, capacityParamsSchema } from "./capacity.schema.js";
import type { CapacityService } from "./capacity.service.js";

export function createCapacityController(service: CapacityService) {
  return {
    getCapacity: asyncHandler(async (req, res) => {
      const { network } = capacityParamsSchema.parse(req.params);
      res.json(await service.getCapacity(network));
    }),
    getHistory: asyncHandler(async (req, res) => {
      const { network } = capacityParamsSchema.parse(req.params);
      const { hours } = capacityHistoryQuerySchema.parse(req.query);
      res.json({ points: service.getHistory(network, hours) });
    }),
  };
}

export type CapacityController = ReturnType<typeof createCapacityController>;
