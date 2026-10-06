import type { NetworkKey } from "@selio/sdk";

export const EVENTS_LIMIT = 100;
/** Most alerts one owner can have at a time. */
export const MAX_ALERTS_PER_OWNER = 10;
/** Deliveries one poll round runs at the same time. */
export const WEBHOOK_CONCURRENCY = 4;
/** Webhooks one owner can receive per `WEBHOOK_OWNER_WINDOW_MS`; fired alerts beyond it keep their in-app event. */
export const WEBHOOK_OWNER_LIMIT = 10;
export const WEBHOOK_OWNER_WINDOW_MS = 60 * 60_000;

/** A stored webhook is shown only as its host and its last four characters. */
export interface MaskedWebhook {
  host: string;
  last4: string;
}

export interface Alert {
  id: string;
  owner: string;
  network: NetworkKey;
  thresholdBps: number;
  webhookUrl: string | null;
  createdAt: number;
}

export interface AlertDto {
  id: string;
  owner: string;
  network: NetworkKey;
  thresholdBps: number;
  webhook: MaskedWebhook | null;
  createdAt: number;
}

export interface AlertEventDto {
  id: number;
  alertId: string;
  network: NetworkKey;
  utilizationBps: number;
  thresholdBps: number;
  at: number;
}

export interface WebhookPayload {
  type: "selio.capacity.alert";
  network: NetworkKey;
  utilizationBps: number;
  thresholdBps: number;
  withdrawable: string;
  supplied: string;
  at: number;
}

/** The address a delivery connects to, approved by the public-host check. */
export interface WebhookTarget {
  url: string;
  address: string;
  family: 4 | 6;
}

export interface WebhookSender {
  /** Refuses (400 WEBHOOK_NOT_ALLOWED) a URL that is not https to a public host. */
  checkTarget(url: string): Promise<WebhookTarget>;
  deliver(url: string, payload: WebhookPayload): Promise<void>;
}
