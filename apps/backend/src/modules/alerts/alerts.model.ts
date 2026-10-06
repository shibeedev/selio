export interface AlertRow {
  id: string;
  owner: string;
  network: string;
  thresholdBps: number;
  webhookUrl: string | null;
  lastUtilizationBps: number | null;
  createdAt: number;
}

export interface AlertEventRow {
  id: number;
  alertId: string;
  owner: string;
  network: string;
  utilizationBps: number;
  thresholdBps: number;
  at: number;
}

export type NewAlertEvent = Omit<AlertEventRow, "id">;
