import type { NetworkKey } from "@selio/sdk";
import type { Transactional } from "../../shared/db/database.js";
import type { ChainGateway } from "../../shared/integrations/chain/chain.gateway.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import type { CapacitySnapshotRow } from "./capacity.model.js";
import type { CapacityRepository } from "./capacity.repository.js";
import {
  BID_CAPACITY_LEVELS_BPS,
  HOUR_MS,
  MAX_HISTORY_HOURS,
  type CapacityDto,
  type CapacityPoint,
  type CapacitySnapshot,
} from "./capacity.types.js";

export type CapacityChainPort = Pick<ChainGateway, "readCapacity" | "deployedNetworks">;

/** Chart points oldest first; debtor capacity and session assets are left out. */
export function toHistoryPoints(rows: CapacitySnapshotRow[]): CapacityPoint[] {
  return [...rows]
    .sort((a, b) => a.at - b.at)
    .map((r) => ({ t: r.at, utilizationBps: r.utilizationBps, withdrawable: r.withdrawable, supplied: r.supplied }));
}

export class CapacityService {
  constructor(
    private readonly repo: Pick<CapacityRepository, "insertMany" | "listSince" | "deleteOlderThan">,
    private readonly chain: CapacityChainPort,
    private readonly inTransaction: Transactional,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  async getCapacity(network: NetworkKey): Promise<CapacityDto> {
    const r = await this.chain.readCapacity(network, BID_CAPACITY_LEVELS_BPS);
    return {
      network,
      at: this.now(),
      underlying: { address: r.underlying.address, symbol: r.underlying.symbol, decimals: r.underlying.decimals },
      withdrawable: r.withdrawable.toString(),
      supplied: r.supplied.toString(),
      utilizationBps: r.utilizationBps,
      debtorCapacity: r.debtorCapacity.toString(),
      sessionAssets: r.sessionAssets.toString(),
      bidCapacity: r.bidCapacity.map((b) => ({ discountBps: b.discountBps, assets: b.assets.toString() })),
    };
  }

  getHistory(network: NetworkKey, hours: number): CapacityPoint[] {
    return toHistoryPoints(this.repo.listSince(network, this.now() - hours * HOUR_MS));
  }

  /** One poll round: reads every deployed network, skips the ones that fail, stores the rest and prunes old rows. */
  async snapshotAll(): Promise<CapacitySnapshot[]> {
    const networks = this.chain.deployedNetworks();
    const results = await Promise.allSettled(networks.map((n) => this.chain.readCapacity(n, [])));
    const at = this.now();
    const snapshots: CapacitySnapshot[] = [];
    const rows: Omit<CapacitySnapshotRow, "id">[] = [];
    results.forEach((result, i) => {
      const network = networks[i]!;
      if (result.status === "rejected") {
        this.logger.warn({ network, err: result.reason }, "capacity snapshot skipped");
        return;
      }
      const r = result.value;
      snapshots.push({ network, at, utilizationBps: r.utilizationBps, withdrawable: r.withdrawable, supplied: r.supplied });
      rows.push({
        network,
        at,
        utilizationBps: r.utilizationBps,
        withdrawable: r.withdrawable.toString(),
        supplied: r.supplied.toString(),
        debtorCapacity: r.debtorCapacity.toString(),
        sessionAssets: r.sessionAssets.toString(),
      });
    });
    this.inTransaction((tx) => {
      this.repo.insertMany(rows, tx);
      this.repo.deleteOlderThan(at - MAX_HISTORY_HOURS * HOUR_MS, tx);
    });
    return snapshots;
  }
}
