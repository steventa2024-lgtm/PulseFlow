import dns from 'node:dns/promises';
import net from 'node:net';

export class NetworkPolicyError extends Error {
  readonly code = 'NETWORK_DENIED';
  constructor(message: string) {
    super(message);
    this.name = 'NetworkPolicyError';
  }
}

export interface NetworkPolicy {
  /** Allow loopback / RFC1918 / link-local / ULA destinations. Required for local fixtures. */
  allowPrivateNetwork: boolean;
  /** Hosts always allowed even when private (e.g. the PulseFlow loopback fixture server). */
  allowHosts?: string[];
  denyHosts?: string[];
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const V4_PRIVATE: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return V4_PRIVATE.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
  }
  return true;
}

/**
 * Validates scheme and resolves the hostname, rejecting private destinations unless allowed.
 * Note: a DNS answer can change between this check and the connection (rebinding); server
 * deployments that need strict guarantees should also enforce egress at the network layer.
 */
export async function assertUrlAllowed(rawUrl: string, policy: NetworkPolicy): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NetworkPolicyError(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetworkPolicyError(`Only http and https URLs are allowed (got ${url.protocol})`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (policy.denyHosts?.some((h) => h.toLowerCase() === host)) {
    throw new NetworkPolicyError(`Host ${host} is blocked by policy`);
  }
  if (policy.allowPrivateNetwork) return url;
  if (policy.allowHosts?.some((h) => h.toLowerCase() === url.host.toLowerCase() || h.toLowerCase() === host)) {
    return url;
  }
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new NetworkPolicyError(`Blocked request to private/loopback address (${host}). Enable "Allow private network" in workflow permissions if intended.`);
  }
  return url;
}
