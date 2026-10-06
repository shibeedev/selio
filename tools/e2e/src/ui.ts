// Headless browser test of the deployed web app over the Chrome DevTools Protocol (no Puppeteer or Playwright).
// Usage: npm run ui -w @selio/e2e -- [--url=https://selio.site] [--network=usdt0-replay,...]
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { REPO_ROOT, readDotEnv } from "./lib/env.js";
import { Recorder, toMarkdown, type ScenarioResult } from "./lib/report.js";

const CHROME_PATHS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

function log(line: string): void {
  process.stdout.write(line + "\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RpcEntry {
  t: number;
  body: string;
  response?: string;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
}

/** Minimal Chrome DevTools Protocol client on Node's global WebSocket. */
class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; method: string }>();
  readonly rpcLog: RpcEntry[] = [];
  private readonly rpcByRequest = new Map<string, RpcEntry>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (ev) => this.onMessage(JSON.parse(String(ev.data)) as CdpMessage));
  }

  static connect(url: string, debugRpc: boolean): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("error", (e) => reject(e), { once: true });
      ws.addEventListener(
        "open",
        () => {
          const cdp = new Cdp(ws);
          void (async () => {
            await cdp.send("Page.enable");
            await cdp.send("Runtime.enable");
            if (debugRpc) await cdp.send("Network.enable");
            resolve(cdp);
          })().catch(reject);
        },
        { once: true },
      );
    });
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.ws.close();
  }

  private onMessage(msg: CdpMessage): void {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    const params = msg.params ?? {};
    if (msg.method === "Network.requestWillBeSent") {
      const request = params.request as { url: string; postData?: string };
      if (!request.url.includes("/rpc/")) return;
      const entry: RpcEntry = { t: Date.now(), body: request.postData ?? "" };
      this.rpcLog.push(entry);
      this.rpcByRequest.set(params.requestId as string, entry);
    } else if (msg.method === "Network.loadingFinished") {
      const entry = this.rpcByRequest.get(params.requestId as string);
      if (!entry) return;
      this.send<{ body: string }>("Network.getResponseBody", { requestId: params.requestId }).then(
        (r) => (entry.response = r.body),
        () => undefined,
      );
    }
  }
}

const q = (id: string) => `document.querySelector('[data-testid="${id}"]')`;

/** Page helpers over one CDP target; `base` is the web app URL. */
class Page {
  /** Panel outcomes and hashes visible before the last click, to tell a new transaction from the previous one. */
  private before: { hashes: string; panels: string[] } = { hashes: "", panels: [] };

  constructor(
    private readonly cdp: Cdp,
    private readonly base: string,
  ) {}

  async eval<T = unknown>(expression: string): Promise<T> {
    const res = await this.cdp.send<{
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(`page error: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result.value as T;
  }

  async goto(hash: string): Promise<void> {
    await this.cdp.send("Page.navigate", { url: `${this.base}/${hash}` });
    await this.waitFor(`document.readyState === "complete"`, 30_000, "page load");
  }

  async waitFor(cond: string, timeoutMs: number, what: string): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      const ok = await this.eval<boolean>(`Boolean(${cond})`).catch(() => false);
      if (ok) return;
      if (Date.now() - t0 >= timeoutMs) throw new Error(`timed out waiting for ${what}`);
      await sleep(500);
    }
  }

  waitTestId(id: string, timeoutMs = 30_000): Promise<void> {
    return this.waitFor(q(id), timeoutMs, `[data-testid="${id}"]`);
  }

  async click(id: string, timeoutMs = 30_000): Promise<void> {
    await this.waitFor(`${q(id)} && !${q(id)}.disabled`, timeoutMs, `enabled ${id}`);
    await this.remember();
    await this.eval(`${q(id)}.click()`);
  }

  async clickFirst(prefix: string, timeoutMs = 60_000): Promise<string> {
    const sel = `document.querySelector('[data-testid^="${prefix}"]')`;
    await this.waitFor(sel, timeoutMs, `${prefix}*`);
    const id = await this.eval<string>(`${sel}.getAttribute("data-testid")`);
    await this.remember();
    await this.eval(`${sel}.click()`);
    return id;
  }

  async type(id: string, value: string): Promise<void> {
    await this.waitTestId(id);
    // Sets a React-controlled input the way typing would.
    await this.eval(`(() => {
      const el = ${q(id)};
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
  }

  async text(id: string): Promise<string> {
    return this.eval<string>(`(${q(id)}?.textContent ?? "").trim()`);
  }

  private panels(): Promise<{
    hashes: string;
    panels: { outcome: string; hashes: string[]; signature: string; reason: string }[];
  }> {
    return this.eval(`(() => {
      const hashes = [...document.querySelectorAll('[data-testid="tx-hash"]')].map((h) => h.getAttribute("data-hash")).join(",");
      const panels = [...document.querySelectorAll('[data-testid="tx-status"]')].map((p) => {
        const outcome = p.getAttribute("data-outcome") ?? "";
        const own = [...p.querySelectorAll('[data-testid="tx-hash"]')].map((h) => h.getAttribute("data-hash"));
        const message = p.querySelector('[data-testid="tx-message"]')?.textContent ?? "";
        const errors = [...p.querySelectorAll(".tx-step-error")].map((e) => e.textContent).join(" | ");
        return { outcome, hashes: own, signature: outcome + ":" + own.join(",") + ":" + p.textContent, reason: (message + " " + errors).trim() };
      });
      return { hashes, panels };
    })()`);
  }

  private async remember(): Promise<void> {
    const now = await this.panels().catch(() => ({ hashes: this.before.hashes, panels: [] }));
    this.before = { hashes: now.hashes, panels: now.panels.map((p) => p.signature) };
  }

  /**
   * Waits until the transaction started by the last click is confirmed. A panel keeps the previous action's "sent"
   * outcome until a new one starts, and a page can show several panels, so the new hashes must also belong to a
   * panel whose outcome is "sent"; a panel that newly shows "failed" fails the step.
   */
  async waitTxSent(timeoutMs = 240_000): Promise<string> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const now = await this.panels().catch(() => null);
      if (now) {
        const failed = now.panels.find((p) => p.outcome === "failed" && !this.before.panels.includes(p.signature));
        if (failed) throw new Error(`transaction failed: ${failed.reason}`);
        const known = new Set(this.before.hashes.split(","));
        const fresh = now.panels.filter((p) => p.hashes.some((h) => !known.has(h)));
        if (now.hashes !== this.before.hashes && fresh.length > 0 && fresh.every((p) => p.outcome === "sent")) {
          return now.hashes;
        }
      }
      await sleep(1000);
    }
    throw new Error("timed out waiting for the transaction to confirm");
  }

  async capture(path: string): Promise<void> {
    const shot = await this.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${path}.png`, Buffer.from(shot.data, "base64"));
    writeFileSync(`${path}.txt`, await this.eval<string>("document.body.innerText"));
  }

  /** Opens the app on `network` with the demo wallet holding `key`. */
  async session(network: string, key: string): Promise<void> {
    await this.goto("#/");
    await this.eval(`(() => {
      localStorage.setItem("selio.network", ${JSON.stringify(network)});
      localStorage.setItem("selio.demoWallet.privateKey", ${JSON.stringify(key)});
      localStorage.setItem("selio.wallet.kind", "demo");
    })()`);
    // A hash-only navigation keeps the running app.
    await this.cdp.send("Page.reload", { ignoreCache: true });
    await sleep(1000);
    await this.waitFor(`document.readyState === "complete"`, 30_000, "reload");
    await this.waitTestId("wallet-button");
  }
}

function findChrome(): string {
  const path = process.env.CHROME_PATH ?? CHROME_PATHS.find((p) => existsSync(p)) ?? "";
  if (!path) throw new Error("Chrome or Edge not found; set CHROME_PATH");
  return path;
}

async function launch(): Promise<{ chrome: ChildProcess; cdp: Cdp }> {
  const profile = mkdtempSync(join(tmpdir(), "selio-ui-"));
  const chrome = spawn(
    findChrome(),
    [
      "--headless=new",
      "--remote-debugging-port=9333",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 60; i++) {
    const targets = await fetch("http://127.0.0.1:9333/json/list")
      .then((res) => res.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>)
      .catch(() => []);
    const page = targets.find((t) => t.type === "page");
    if (page) return { chrome, cdp: await Cdp.connect(page.webSocketDebuggerUrl, !!process.env.UI_DEBUG_RPC) };
    await sleep(500);
  }
  throw new Error("Chrome did not expose a page target");
}

interface Amounts {
  sell: string;
  buy: string;
  vault: string;
  bid: string;
}

const FORK_AMOUNTS: Record<"aave" | "morpho", Amounts> = {
  aave: { sell: "2", buy: "0.5", vault: "1", bid: "1" },
  morpho: { sell: "2000", buy: "500", vault: "1000", bid: "1000" },
};

const VENUE: Record<string, "aave" | "morpho"> = {
  "monad-testnet": "morpho",
  "usdt0-replay": "aave",
  "vault-freeze": "morpho",
};

/** Connect and browse a network: shared first steps of every run. */
async function browse(page: Page, r: Recorder, network: string, key: string): Promise<void> {
  await r.step(`${network}: select the network and connect the demo wallet`, async () => {
    await page.session(network, key);
    try {
      await page.waitTestId("wallet-address", 5_000);
    } catch {
      await page.click("wallet-button");
      await page.waitTestId("wallet-address", 30_000);
    }
    return { address: await page.text("wallet-address") };
  });
  await r.step(
    `${network}: every page renders with live chain data`,
    async () => {
      await page.goto("#/");
      await page.waitTestId(`capacity-row-${network}`, 60_000);
      const capacity = (await page.text(`capacity-row-${network}`)).slice(0, 120);
      const pages: [string, string][] = [
        ["#/sell", "page-sell"],
        ["#/buy", "page-buy"],
        ["#/earn", "page-earn"],
        ["#/frozen-collateral", "page-frozen"],
        ["#/developers", "page-developers"],
      ];
      for (const [hash, id] of pages) {
        await page.goto(hash);
        await page.waitTestId(id, 30_000);
      }
      await page.goto("#/earn");
      await page.waitTestId("orderbook", 60_000);
      return { capacity };
    },
    { independent: true },
  );
}

/** Fork networks: demo kits from the faucet, then every write flow with the demo wallet. */
async function forkFlow(page: Page, r: Recorder, network: string, amounts: Amounts): Promise<void> {
  for (const kit of ["seller", "borrower", "bidder"]) {
    await r.step(`${network}: get the ${kit} demo kit from the faucet`, async () => {
      await page.goto("#/sell");
      await page.click(`demo-kit-${kit}`);
      await page.waitFor(`${q("demo-funds-result")} && !${q("demo-funds-result")}.textContent.includes("…")`, 240_000, "faucet result");
      const result = await page.text("demo-funds-result");
      if (/fail|error|limit/i.test(result)) throw new Error(result);
      return { result: result.slice(0, 140) };
    });
  }
  await r.step(`${network}: open a Dutch auction from the Sell page`, async () => {
    await page.goto("#/sell");
    await page.click("sell-mode-auction");
    await page.type("sell-amount", amounts.sell);
    await page.click("sell-submit");
    return { txs: await page.waitTxSent() };
  });
  await r.step(`${network}: buy and repay from the wallet on the Buy page`, async () => {
    await page.goto("#/buy");
    const session = await page.clickFirst("buy-select-");
    await page.type("buy-amount", amounts.buy);
    await page.click("buy-submit");
    return { session, txs: await page.waitTxSent() };
  });
  await r.step(`${network}: deposit into the Selio Vault`, async () => {
    await page.goto("#/earn");
    await page.type("vault-deposit-amount", amounts.vault);
    await page.click("vault-deposit-submit");
    return { txs: await page.waitTxSent() };
  });
  await r.step(`${network}: place a limit bid, then cancel it`, async () => {
    await page.goto("#/earn");
    await page.click("earn-tab-bids");
    await page.type("bid-amount", amounts.bid);
    await page.click("bid-submit");
    await page.waitTxSent();
    const cancelled = await page.clickFirst("bid-cancel-");
    return { cancelled, txs: await page.waitTxSent() };
  });
  await r.step(`${network}: withdraw the unsold auction at once`, async () => {
    await page.goto("#/sell");
    const session = await page.clickFirst("session-withdraw-");
    return { session, txs: await page.waitTxSent() };
  });
}

/** Live networks with two funded keys: seller and buyer flows with testnet funds. */
async function liveFlow(page: Page, r: Recorder, network: string, sellerKey: string, buyerKey: string): Promise<void> {
  const amounts = { sell: "2", buy: "0.5", bid: "0.5" };
  await r.step(`${network}: seller opens a Dutch auction in the web app`, async () => {
    await page.session(network, sellerKey);
    await page.goto("#/sell");
    await page.click("sell-mode-auction");
    await page.type("sell-amount", amounts.sell);
    await page.click("sell-submit");
    return { txs: await page.waitTxSent() };
  });
  await r.step(`${network}: buyer buys and repays in the web app`, async () => {
    await page.session(network, buyerKey);
    await page.goto("#/buy");
    const session = await page.clickFirst("buy-select-");
    await page.type("buy-amount", amounts.buy);
    await page.click("buy-submit");
    return { session, txs: await page.waitTxSent() };
  });
  await r.step(`${network}: buyer places and cancels a limit bid`, async () => {
    await page.goto("#/earn");
    await page.click("earn-tab-bids");
    await page.type("bid-amount", amounts.bid);
    await page.click("bid-submit");
    await page.waitTxSent();
    const cancelled = await page.clickFirst("bid-cancel-");
    return { cancelled, txs: await page.waitTxSent() };
  });
  await r.step(`${network}: seller withdraws the unsold rest`, async () => {
    await page.session(network, sellerKey);
    await page.goto("#/sell");
    const session = await page.clickFirst("session-withdraw-");
    return { session, txs: await page.waitTxSent() };
  });
}

/** Signs in to alerts with the demo wallet, saves an in-app alert (no webhook) and deletes it. */
async function alertStep(page: Page, r: Recorder, network: string): Promise<void> {
  await r.step(
    `${network}: sign in with the wallet, save an alert, then delete it`,
    async () => {
      await page.goto("#/");
      await page.waitFor(`${q("alert-signin")} || ${q("alert-session")}`, 60_000, "alert form");
      if (await page.eval<boolean>(`Boolean(${q("alert-signin")})`)) await page.click("alert-signin");
      await page.waitTestId("alert-session", 60_000);
      await page.type("alert-threshold", "100");
      await page.click("alert-save");
      await page.waitFor(`(${q("alert-status")}?.textContent ?? "").trim().startsWith("Saved.")`, 60_000, "alert saved");
      const alert = await page.clickFirst("alert-delete-");
      await page.waitFor(`!document.querySelector('[data-testid^="alert-row-"]')`, 30_000, "alert removed");
      return { alert };
    },
    { independent: true },
  );
}

async function main(): Promise<void> {
  const urlArg = process.argv.find((a) => a.startsWith("--url="));
  const url = (urlArg === undefined ? "https://selio.site" : (urlArg.split("=")[1] as string)).replace(/\/$/, "");
  const netArg = process.argv.find((a) => a.startsWith("--network="));
  const networks = netArg === undefined ? Object.keys(VENUE) : (netArg.split("=")[1] as string).split(",");
  const env = readDotEnv();
  const startedAt = new Date().toISOString();
  const results: ScenarioResult[] = [];
  const { chrome, cdp } = await launch();
  try {
    const page = new Page(cdp, url);
    for (const network of networks) {
      const t0 = Date.now();
      log(`\n== ${network} (web app at ${url})`);
      const r = new Recorder(network, log);
      const isFork = network === "usdt0-replay" || network === "vault-freeze";
      const key = isFork ? generatePrivateKey() : (env.PRIVATE_KEY ?? generatePrivateKey());
      await browse(page, r, network, key);
      if (isFork) await forkFlow(page, r, network, FORK_AMOUNTS[VENUE[network] ?? "morpho"]);
      else if (env.PRIVATE_KEY && env.E2E_BUYER_KEY) await liveFlow(page, r, network, env.PRIVATE_KEY, env.E2E_BUYER_KEY);
      await alertStep(page, r, network);
      if (r.hasFailed) {
        const reports = join(REPO_ROOT, "reports");
        const base = join(reports, `ui-failure-${network}`);
        mkdirSync(reports, { recursive: true });
        await page.capture(base).catch(() => undefined);
        if (process.env.UI_DEBUG_RPC) writeFileSync(`${base}-rpc.json`, JSON.stringify(cdp.rpcLog.slice(-60), null, 1));
        log(`  captured ${base}.png / .txt`);
      }
      results.push({ network, mode: "live", steps: r.steps, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0 });
    }
  } finally {
    cdp.close();
    chrome.kill();
  }
  mkdirSync(join(REPO_ROOT, "reports"), { recursive: true });
  const markdown = toMarkdown(results, startedAt).replace(/^# .*$/m, `# Selio web app report (${url})`);
  writeFileSync(join(REPO_ROOT, "reports", "ui-latest.md"), markdown);
  const steps = results.flatMap((res) => res.steps);
  const passed = steps.filter((s) => s.ok).length;
  log(`\n${passed}/${steps.length} steps passed. Report: reports/ui-latest.md`);
  process.exitCode = passed === steps.length ? 0 : 1;
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.stack : String(e)}`);
  process.exitCode = 1;
});
