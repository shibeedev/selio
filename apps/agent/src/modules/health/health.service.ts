import { pingDatabase, type Db } from "../../shared/db/database.js";

export class HealthService {
  constructor(
    private readonly db: Db,
    /** Names of the variables to set while Dynamic is not configured; empty when it is. */
    private readonly dynamicMissing: readonly string[],
  ) {}

  /** null when ready, else the reason. */
  notReadyReason(): string | null {
    if (this.dynamicMissing.length > 0) return `Dynamic is not configured: set ${this.dynamicMissing.join(", ")}`;
    if (!pingDatabase(this.db)) return "The database is not reachable";
    return null;
  }
}
