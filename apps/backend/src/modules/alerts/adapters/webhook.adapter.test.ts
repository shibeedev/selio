import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../shared/errors/AppError.js";
import type { WebhookPayload, WebhookTarget } from "../alerts.types.js";
import { checkTarget, SIGNATURE_HEADER, signWebhookBody, WebhookAdapter, type LookupFn } from "./webhook.adapter.js";

const PAYLOAD: WebhookPayload = {
  type: "selio.capacity.alert",
  network: "usdt0-replay",
  utilizationBps: 9_700,
  thresholdBps: 9_500,
  withdrawable: "5",
  supplied: "100",
  at: 42,
};

const publicLookup: LookupFn = async () => [{ address: "203.0.113.10", family: 4 }];
const loopbackLookup: LookupFn = async () => [{ address: "127.0.0.1", family: 4 }];

/** A local receiver that records each request and answers with the next status in `statuses`. */
async function receiver(statuses: number[]) {
  const requests: { method: string | undefined; headers: IncomingHttpHeaders; body: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method, headers: req.headers, body });
      const status = statuses[Math.min(requests.length - 1, statuses.length - 1)] ?? 200;
      if (status >= 300 && status < 400) res.setHeader("Location", "http://localhost:1/elsewhere");
      res.statusCode = status;
      res.end("ignored");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  servers.push(server);
  return { url: `http://localhost:${port}/hook`, requests };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

function localAdapter(options: { secret?: string } = {}) {
  return new WebhookAdapter({ ...options, allowLocalhost: true, lookupImpl: loopbackLookup, sleep: async () => undefined });
}

describe("WebhookAdapter", () => {
  it("signs the exact body with HMAC-SHA256 when a secret is set", async () => {
    const rx = await receiver([204]);
    await localAdapter({ secret: "s3cret" }).deliver(rx.url, PAYLOAD);
    expect(rx.requests).toHaveLength(1);
    const [req] = rx.requests;
    expect(req?.method).toBe("POST");
    expect(req?.headers["content-type"]).toBe("application/json");
    expect(req?.headers["user-agent"]).toBe("selio-webhook/0.1");
    expect(JSON.parse(req?.body ?? "")).toEqual(PAYLOAD);
    const expected = `sha256=${createHmac("sha256", "s3cret").update(req?.body ?? "").digest("hex")}`;
    expect(req?.headers[SIGNATURE_HEADER.toLowerCase()]).toBe(expected);
    expect(signWebhookBody("s3cret", req?.body ?? "")).toBe(expected);
  });

  it("omits the signature header without a secret", async () => {
    const rx = await receiver([200]);
    await localAdapter().deliver(rx.url, PAYLOAD);
    expect(rx.requests[0]?.headers[SIGNATURE_HEADER.toLowerCase()]).toBeUndefined();
  });

  it("retries 5xx and network errors with backoff, up to 3 attempts", async () => {
    const sleeps: number[] = [];
    const answers: (number | Error)[] = [503, Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), 200];
    const postImpl = vi.fn(async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? 200;
    });
    const adapter = new WebhookAdapter({
      lookupImpl: publicLookup,
      postImpl,
      retryDelaysMs: [10, 30],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await adapter.deliver("https://hooks.example.com/x", PAYLOAD);
    expect(postImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([10, 30]);
  });

  it("gives up after the third failed attempt with an AppError", async () => {
    const statuses = [500, 502, 429];
    const postImpl = vi.fn(async () => statuses.shift() ?? 200);
    const adapter = new WebhookAdapter({ lookupImpl: publicLookup, postImpl, sleep: async () => undefined });
    const err = await adapter.deliver("https://hooks.example.com/x", PAYLOAD).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ statusCode: 502, code: "UPSTREAM_ERROR" });
    expect((err as Error).message).toMatch(/after 3 attempts \(HTTP 429\)$/);
    expect(postImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 4xx rejection or follow redirects", async () => {
    const rejected = await receiver([400]);
    await expect(localAdapter().deliver(rejected.url, PAYLOAD)).rejects.toThrow("rejected the delivery (HTTP 400)");
    expect(rejected.requests).toHaveLength(1);

    const redirected = await receiver([302]);
    await expect(localAdapter().deliver(redirected.url, PAYLOAD)).rejects.toThrow("rejected the delivery (HTTP 302)");
    expect(redirected.requests).toHaveLength(1);
  });

  it("checks the host on every attempt and posts to the checked address", async () => {
    const answers = [
      [{ address: "203.0.113.10", family: 4 }],
      [{ address: "10.0.0.5", family: 4 }],
    ];
    const lookupImpl: LookupFn = async () => answers.shift() ?? [];
    const targets: WebhookTarget[] = [];
    const postImpl = vi.fn(async (target: WebhookTarget) => {
      targets.push(target);
      return 503;
    });
    const adapter = new WebhookAdapter({ lookupImpl, postImpl, sleep: async () => undefined });
    await expect(adapter.deliver("https://hooks.example.com/x", PAYLOAD)).rejects.toThrow(
      "Webhook target refused: webhookUrl host hooks.example.com resolves to a non-public address",
    );
    expect(postImpl).toHaveBeenCalledTimes(1);
    expect(targets).toEqual([{ url: "https://hooks.example.com/x", address: "203.0.113.10", family: 4 }]);
  });
});

describe("checkTarget", () => {
  it("accepts https hosts whose every address is public", async () => {
    await expect(checkTarget("https://hooks.example.com/x", { lookupImpl: publicLookup })).resolves.toEqual({
      url: "https://hooks.example.com/x",
      address: "203.0.113.10",
      family: 4,
    });
  });

  it.each([
    "https://127.0.0.1/",
    "https://0.0.0.0/",
    "https://10.1.2.3/",
    "https://172.16.0.1/",
    "https://192.168.1.1/",
    "https://100.64.0.1/",
    "https://169.254.169.254/",
    "https://[::1]/",
    "https://[fe80::1]/",
    "https://[fd00::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://metadata/",
    "https://metadata.google.internal/",
    "https://printer.local/",
    "https://app.localhost/",
    "https://mixed.example.com/",
    "http://hooks.example.com/",
  ])("refuses %s", async (url) => {
    const lookupImpl = vi.fn<LookupFn>(async () => [
      { address: "203.0.113.10", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    const postImpl = vi.fn(async () => 200);
    await expect(checkTarget(url, { lookupImpl })).rejects.toMatchObject({ statusCode: 400, code: "WEBHOOK_NOT_ALLOWED" });
    const adapter = new WebhookAdapter({ lookupImpl, postImpl, sleep: async () => undefined });
    await expect(adapter.deliver(url, PAYLOAD)).rejects.toThrow("Webhook target refused");
    expect(postImpl).not.toHaveBeenCalled();
  });

  it("accepts http://localhost only in development", async () => {
    const url = "http://localhost:9999/hook";
    await expect(checkTarget(url, { allowLocalhost: true, lookupImpl: loopbackLookup })).resolves.toMatchObject({
      address: "127.0.0.1",
    });
    await expect(checkTarget(url, { lookupImpl: loopbackLookup })).rejects.toMatchObject({
      code: "WEBHOOK_NOT_ALLOWED",
      message: "http://localhost webhooks are accepted only when NODE_ENV=development",
    });
  });
});
