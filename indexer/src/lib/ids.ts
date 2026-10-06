// Entity ids and UTC time buckets (Part 10 §10.1 E.1).

export type IntervalName = "HOUR" | "DAY";

export const HOUR = 3_600;
export const DAY = 86_400;

export const hourStart = (timestamp: number): number => Math.floor(timestamp / HOUR) * HOUR;
export const dayStart = (timestamp: number): number => Math.floor(timestamp / DAY) * DAY;

/** The HOUR and DAY buckets that hold `timestamp`. */
export const buckets = (timestamp: number): { interval: IntervalName; start: number }[] => [
  { interval: "HOUR", start: hourStart(timestamp) },
  { interval: "DAY", start: dayStart(timestamp) },
];

/** Log entities: the log index is unique within a block. */
export const logId = (blockNumber: number, logIndex: number): string => `${blockNumber}-${logIndex}`;

export const bucketId = (owner: string, interval: IntervalName, start: number): string =>
  `${owner}-${interval}-${start}`;

export const sessionEntityId = (market: string, sessionId: bigint): string => `${market}-${sessionId}`;
export const bidEntityId = (market: string, bidId: bigint): string => `${market}-${bidId}`;
export const feeTotalId = (market: string, payToken: string): string => `${market}-${payToken}`;
export const accountTokenId = (account: string, token: string): string => `${account}-${token}`;
export const borrowPositionId = (marketId: string, account: string): string => `${marketId}-${account}`;
