import { dynamicUserOf } from "../../shared/middlewares/requireDynamicUser.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { createGrantSchema, deleteGrantQuerySchema, grantIdParamsSchema } from "./grants.schema.js";
import type { GrantService } from "./grants.service.js";

export function createGrantsController(service: GrantService) {
  return {
    me: asyncHandler(async (_req, res) => {
      res.json(service.me(dynamicUserOf(res)));
    }),
    create: asyncHandler(async (req, res) => {
      const input = createGrantSchema.parse(req.body);
      res.status(201).json(service.create(dynamicUserOf(res), input));
    }),
    remove: asyncHandler(async (req, res) => {
      const { id } = grantIdParamsSchema.parse(req.params);
      const { cancelBid } = deleteGrantQuerySchema.parse(req.query);
      service.remove(dynamicUserOf(res), id, cancelBid);
      res.status(204).end();
    }),
    revoke: asyncHandler(async (_req, res) => {
      res.json(await service.revoke(dynamicUserOf(res)));
    }),
  };
}

export type GrantsController = ReturnType<typeof createGrantsController>;
