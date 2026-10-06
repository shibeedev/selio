import { createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { AppError } from "../../../shared/errors/AppError.js";
import type { WebhookPayload, WebhookSender, WebhookTarget } from "../alerts.types.js";

export const SIGNATURE_HEADER = "X-Selio-Signature";

export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv6");
}

/** False for loopback, private, CGNAT, link-local (metadata), unique-local, multicast and reserved addresses. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  // An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is matched against the IPv4 rules by BlockList itself.
  return !BLOCKED.check(address, family === 6 ? "ipv6" : "ipv4");
}

export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

export interface TargetCheckOptions {
  /** NODE_ENV=development: http://localhost is accepted, without the address checks. */
  allowLocalhost?: boolean;
  lookupImpl?: LookupFn;
}

type TargetResult = { ok: true; target: WebhookTarget } | { ok: false; reason: string; retryable: boolean };

const systemLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

function refuse(reason: string, retryable = false): TargetResult {
  return { ok: false, reason, retryable };
}

async function resolveTarget(raw: string, options: TargetCheckOptions): Promise<TargetResult> {
  const lookup = options.lookupImpl ?? systemLookup;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("webhookUrl must be an https URL of a public host");
  }
  // The URL parser has already normalised numeric IPv4 forms such as 2130706433 or 0x7f.1.
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");

  if (url.protocol === "http:" && host === "localhost") {
    if (!options.allowLocalhost) return refuse("http://localhost webhooks are accepted only when NODE_ENV=development");
    const first = (await lookup(host).catch(() => []))[0];
    return first
      ? { ok: true, target: { url: raw, address: first.address, family: first.family === 6 ? 6 : 4 } }
      : refuse(`webhookUrl host ${host} does not resolve`, true);
  }
  if (url.protocol !== "https:") return refuse("webhookUrl must be an https URL of a public host");

  const literal = isIP(host);
  if (literal !== 0) {
    return isPublicAddress(host)
      ? { ok: true, target: { url: raw, address: host, family: literal === 6 ? 6 : 4 } }
      : refuse(`webhookUrl host ${host} is not a public host`);
  }
  // A name without a dot would be completed with the resolver's search domains; these suffixes are never public.
  if (!host.includes(".") || /\.(localhost|local|internal)$/.test(host)) {
    return refuse(`webhookUrl host ${host} is not a public host`);
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host);
  } catch {
    return refuse(`webhookUrl host ${host} does not resolve`, true);
  }
  const first = addresses[0];
  if (!first) return refuse(`webhookUrl host ${host} does not resolve`, true);
  if (!addresses.every((a) => isPublicAddress(a.address))) {
    return refuse(`webhookUrl host ${host} resolves to a non-public address`);
  }
  return { ok: true, target: { url: raw, address: first.address, family: first.family === 6 ? 6 : 4 } };
}

/** The public-host check: resolves to the address a delivery may connect to, or refuses with 400 WEBHOOK_NOT_ALLOWED. */
export async function checkTarget(url: string, options: TargetCheckOptions = {}): Promise<WebhookTarget> {
  const result = await resolveTarget(url, options);
  if (!result.ok) throw new AppError(400, "WEBHOOK_NOT_ALLOWED", result.reason);
  return result.target;
}

/** Sends one attempt and resolves its HTTP status. */
export type PostFn = (target: WebhookTarget, body: string, headers: Record<string, string>) => Promise<number>;

function nodePost(timeoutMs: number): PostFn {
  return (target, body, headers) =>
    new Promise<number>((resolve, reject) => {
      const url = new URL(target.url);
      // Connect to the address the check approved, so a DNS answer that changes after the check (DNS rebinding)
      // cannot redirect the request. TLS still uses the URL's hostname for SNI and the certificate check.
      const lookup: LookupFunction = (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      };
      const send = url.protocol === "http:" ? httpRequest : httpsRequest;
      // Node's HTTP client never follows redirects; the response body is never read.
      const req = send(url, { method: "POST", headers, lookup, agent: false, signal: AbortSignal.timeout(timeoutMs) }, (res) => {
        res.on("error", () => undefined);
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end(body);
    });
}

export interface WebhookAdapterOptions extends TargetCheckOptions {
  secret?: string;
  retryDelaysMs?: number[];
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  postImpl?: PostFn;
}

/** Signed POST with retries; every attempt checks the host again and connects to the address it checked. */
export class WebhookAdapter implements WebhookSender {
  private readonly secret: string | undefined;
  private readonly retryDelaysMs: number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly post: PostFn;
  private readonly targetOptions: TargetCheckOptions;

  constructor(options: WebhookAdapterOptions = {}) {
    this.secret = options.secret;
    this.retryDelaysMs = options.retryDelaysMs ?? [1_000, 3_000];
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.post = options.postImpl ?? nodePost(options.timeoutMs ?? 5_000);
    this.targetOptions = { allowLocalhost: options.allowLocalhost, lookupImpl: options.lookupImpl };
  }

  checkTarget(url: string): Promise<WebhookTarget> {
    return checkTarget(url, this.targetOptions);
  }

  async deliver(url: string, payload: WebhookPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
      "User-Agent": "selio-webhook/0.1",
    };
    if (this.secret) headers[SIGNATURE_HEADER] = signWebhookBody(this.secret, body);

    const attempts = this.retryDelaysMs.length + 1;
    let lastError = "unknown error";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const checked = await resolveTarget(url, this.targetOptions);
      if (checked.ok) {
        try {
          const status = await this.post(checked.target, body, headers);
          if (status >= 200 && status < 300) return;
          if (status !== 408 && status !== 429 && status < 500) {
            throw new AppError(502, "UPSTREAM_ERROR", `Webhook rejected the delivery (HTTP ${status})`);
          }
          lastError = `HTTP ${status}`;
        } catch (err) {
          if (err instanceof AppError) throw err;
          lastError = err instanceof Error ? err.message : String(err);
        }
      } else if (checked.retryable) {
        lastError = checked.reason;
      } else {
        throw new AppError(502, "UPSTREAM_ERROR", `Webhook target refused: ${checked.reason}`);
      }
      const delay = this.retryDelaysMs[attempt - 1];
      if (delay !== undefined) await this.sleep(delay);
    }
    throw new AppError(502, "UPSTREAM_ERROR", `Webhook delivery failed after ${attempts} attempts (${lastError})`);
  }
}
