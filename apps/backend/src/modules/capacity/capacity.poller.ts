import type { Logger } from "../../shared/middlewares/logger.js";
import type { CapacitySnapshot, SnapshotListener } from "./capacity.types.js";

/** Fixed-delay loop: round k+1 starts `intervalMs` after round k ends, so rounds never overlap. */
export class CapacityPoller {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = true;

  constructor(
    private readonly snapshot: () => Promise<CapacitySnapshot[]>,
    private readonly listeners: SnapshotListener[],
    private readonly intervalMs: number,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  /** Stops scheduling and waits for an in-flight round, including its listeners. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.runOnce().finally(() => {
        this.running = null;
        if (!this.stopped) this.schedule(this.intervalMs);
      });
    }, delay);
  }

  private async runOnce(): Promise<void> {
    let snapshots: CapacitySnapshot[];
    try {
      snapshots = await this.snapshot();
    } catch (err) {
      this.logger.error({ err }, "capacity poll failed");
      return;
    }
    for (const listener of this.listeners) {
      try {
        await listener(snapshots);
      } catch (err) {
        this.logger.error({ err }, "capacity listener failed");
      }
    }
  }
}
