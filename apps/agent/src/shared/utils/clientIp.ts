import { isIP } from "node:net";
import type { Request } from "express";

/**
 * The caller's IP: `CF-Connecting-IP` when it is a valid address (the service listens on 127.0.0.1,
 * so the tunnel connector is its only public client), else the socket address. IPv4-mapped IPv6
 * addresses count as their IPv4 address.
 */
export function clientIp(req: Request): string {
  const header = req.headers["cf-connecting-ip"];
  const forwarded = typeof header === "string" ? header.trim() : "";
  const ip = isIP(forwarded) ? forwarded : (req.socket.remoteAddress ?? "");
  const mapped = ip.toLowerCase().startsWith("::ffff:") ? ip.slice(7) : "";
  return isIP(mapped) === 4 ? mapped : ip;
}

/** Rate-limit bucket: an IPv4 address is its own bucket, an IPv6 address counts as its /64. */
export function ipBucket(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const [head = "", tail] = ip.toLowerCase().split("::");
  const groups = (part: string) => (part ? part.split(":") : []);
  const width = (parts: string[]) => parts.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const full = tail === undefined ? left : [...left, ...Array<string>(8 - width(left) - width(right)).fill("0"), ...right];
  return `${full.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}
