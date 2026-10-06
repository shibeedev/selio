export interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  details: Record<string, string>;
  txs: string[];
  error?: string;
}

export interface ScenarioResult {
  network: string;
  mode: "fork" | "live";
  forkBlock?: string;
  deployment?: Record<string, unknown>;
  steps: StepResult[];
  startedAt: string;
  ms: number;
}

export class AssertionError extends Error {}

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

/** Fails unless `actual` is within `tol` of `expected` (a difference equal to `tol` passes). */
export function near(actual: bigint, expected: bigint, tol: bigint, what: string): void {
  const diff = actual > expected ? actual - expected : expected - actual;
  if (diff > tol) throw new AssertionError(`${what}: expected ${expected} ± ${tol}, got ${actual}`);
}

/** Runs and records the steps of one network; after a failure, later steps are skipped unless independent. */
export class Recorder {
  readonly steps: StepResult[] = [];
  private failed = false;
  private currentTxs: string[] = [];

  constructor(
    readonly network: string,
    private readonly log: (line: string) => void,
  ) {}

  get hasFailed(): boolean {
    return this.failed;
  }

  noteTx(hash: string): void {
    this.currentTxs.push(hash);
  }

  async step(
    name: string,
    fn: () => Promise<Record<string, string> | void>,
    opts: { independent?: boolean } = {},
  ): Promise<boolean> {
    if (this.failed && !opts.independent) {
      this.steps.push({ name, ok: false, ms: 0, details: {}, txs: [], error: "skipped: an earlier step failed" });
      this.log(`  - SKIP ${name}`);
      return false;
    }
    const t0 = Date.now();
    this.currentTxs = [];
    try {
      const details = (await fn()) ?? {};
      const ms = Date.now() - t0;
      this.steps.push({ name, ok: true, ms, details, txs: this.currentTxs });
      this.log(`  ✓ ${name} (${ms} ms)${Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : ""}`);
      return true;
    } catch (e) {
      const ms = Date.now() - t0;
      const error = (e instanceof Error ? e.message : String(e)).split("\n").slice(0, 6).join(" | ");
      this.steps.push({ name, ok: false, ms, details: {}, txs: this.currentTxs, error });
      this.failed = true;
      this.log(`  ✗ ${name}: ${error}`);
      return false;
    }
  }
}

export function toMarkdown(results: ScenarioResult[], startedAt: string): string {
  const all = results.flatMap((r) => r.steps);
  const passed = all.filter((s) => s.ok).length;
  const lines = [
    "# Selio end-to-end report",
    "",
    `Started ${startedAt}. ${passed}/${all.length} steps passed.`,
    "",
    "| Network | Mode | Fork block | Passed | Duration |",
    "|---|---|---|---|---|",
  ];
  for (const r of results) {
    const ok = r.steps.filter((s) => s.ok).length;
    lines.push(`| ${r.network} | ${r.mode} | ${r.forkBlock ?? "-"} | ${ok}/${r.steps.length} | ${(r.ms / 1000).toFixed(1)} s |`);
  }
  for (const r of results) {
    lines.push("", `## ${r.network}`, "", "| # | Step | Result | Details |", "|---|---|---|---|");
    r.steps.forEach((s, i) => {
      const cell = s.ok
        ? Object.entries(s.details)
            .map(([k, v]) => `${k}: ${v}`)
            .join("<br>")
        : (s.error ?? "").replace(/\|/g, "\\|");
      lines.push(`| ${i + 1} | ${s.name} | ${s.ok ? "pass" : "FAIL"} | ${cell} |`);
    });
  }
  return lines.join("\n") + "\n";
}
