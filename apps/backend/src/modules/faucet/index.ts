import { createTransactional, type Db } from "../../shared/db/database.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import { ForkkitAdapter, type ForkkitChainPort } from "./adapters/forkkit.adapter.js";
import { createFaucetController } from "./faucet.controller.js";
import { FaucetRepository } from "./faucet.repository.js";
import { createFaucetRouter } from "./faucet.routes.js";
import { FaucetService, type FaucetServiceOptions } from "./faucet.service.js";
import type { KitRunner } from "./faucet.types.js";

export function createFaucetModule({
  db,
  chain,
  logger,
  kits,
  options,
}: {
  db: Db;
  chain: ForkkitChainPort;
  logger: Logger;
  kits?: KitRunner;
  options?: Partial<FaucetServiceOptions>;
}) {
  const service = new FaucetService(
    new FaucetRepository(db),
    kits ?? new ForkkitAdapter(chain),
    createTransactional(db),
    logger.child({ module: "faucet" }),
    options,
  );
  return { service, router: createFaucetRouter(createFaucetController(service)) };
}

export { FaucetService };
export type { FaucetServiceOptions, ForkkitChainPort, KitRunner };
export type { KitType } from "./faucet.types.js";
