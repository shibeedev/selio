import type { ActionRow } from "../executor/actions.repository.js";
import type { GrantRow } from "./grants.model.js";

export interface GrantDto {
  id: string;
  network: "monad-testnet";
  kind: "sell" | "bid" | "vault";
  thresholdBps: number;
  alertId: string;
  maxPerAction: string;
  maxTotal: string;
  usedTotal: string;
  maxSellDiscountBps: number | null;
  payMask: number | null;
  minBidDiscountBps: number | null;
  payIdx: number | null;
  expiresAt: number;
  status: "active" | "revoked" | "expired" | "exhausted";
  createdAt: number;
}

export interface ActionDto {
  id: number;
  grantId: string;
  kind: "sell" | "bid" | "vault" | "cancel";
  triggerAt: number;
  utilizationBps: number | null;
  assets: string | null;
  fee: string | null;
  net: string | null;
  status: "planned" | "sending" | "done" | "failed" | "skipped";
  txHashes: string[];
  bidId: string | null;
  message: string | null;
  at: number;
}

export interface MeDto {
  address: string;
  delegation: { status: "active" | "revoked" | "invalid"; since: number } | null;
  grants: GrantDto[];
  actions: ActionDto[];
}

/** Recent actions listed by GET /agent/v1/me (the bound of the backend's alert events). */
export const ACTIONS_LIMIT = 100;

export function toGrantDto(g: GrantRow): GrantDto {
  return {
    id: g.id,
    network: g.network,
    kind: g.kind,
    thresholdBps: g.thresholdBps,
    alertId: g.alertId,
    maxPerAction: g.maxPerAction.toString(),
    maxTotal: g.maxTotal.toString(),
    usedTotal: g.usedTotal.toString(),
    maxSellDiscountBps: g.maxSellDiscountBps,
    payMask: g.payMask,
    minBidDiscountBps: g.minBidDiscountBps,
    payIdx: g.payIdx,
    expiresAt: g.expiresAt,
    status: g.status,
    createdAt: g.createdAt,
  };
}

export function toActionDto(a: ActionRow): ActionDto {
  return {
    id: a.id,
    grantId: a.grantId,
    kind: a.kind,
    triggerAt: a.triggerAt,
    utilizationBps: a.utilizationBps,
    assets: a.assets,
    fee: a.fee,
    net: a.net,
    status: a.status,
    txHashes: a.txHashes,
    bidId: a.bidId,
    message: a.message,
    at: a.createdAt,
  };
}
