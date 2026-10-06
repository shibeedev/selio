import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

/**
 * The caller's IP, used only for limits. Cloudflare sets CF-Connecting-IP on every request it proxies, and the
 * backend listens on 127.0.0.1 only, so the tunnel connector is its one public client.
 */
export function clientIp(req: Pick<IncomingMessage, "headers" | "socket">): string {
  const header = req.headers["cf-connecting-ip"];
  const value = typeof header === "string" ? header.trim() : "";
  const ip = isIP(value) ? value : (req.socket.remoteAddress ?? "");
  const mapped = ip.toLowerCase().startsWith("::ffff:") ? ip.slice(7) : "";
  return isIP(mapped) === 4 ? mapped : ip;
}

/** An IPv4 address is its own bucket; an IPv6 address counts as its /64, so one host cannot multiply its limit. */
export function ipBucket(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  return `${ipv6Groups(ip).slice(0, 4).join(":")}::/64`;
}

/** The eight groups of an IPv6 address, without leading zeros. */
function ipv6Groups(ip: string): string[] {
  let address = ip.split("%")[0] ?? ip;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    address = `${address.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const zeros = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...zeros, ...right].map((g) => parseInt(g, 16).toString(16));
}
