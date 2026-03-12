/**
 * Security utilities for the IRC Gateway
 * 
 * Includes SSRF protection and IP validation functions
 */

// ============================================================================
// SSRF Protection — block connections to private/reserved IP ranges
// ============================================================================

/**
 * Normalize an IPv6 address to its fully expanded 8-group hex form.
 * Returns null if the input is not a valid IPv6 address.
 * Example: "::1" → "0000:0000:0000:0000:0000:0000:0000:0001"
 */
export function normalizeIpv6(addr: string): string | null {
  // Handle :: expansion
  const halves = addr.split('::');
  if (halves.length > 2) return null; // Multiple :: is invalid

  let groups: string[];

  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    groups = addr.split(':');
  }

  if (groups.length !== 8) return null;

  // Validate and pad each group to 4 hex digits
  const normalized = groups.map((g) => {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    return g.padStart(4, '0').toLowerCase();
  });

  if (normalized.some((g) => g === null)) return null;
  return normalized.join(':');
}

/**
 * Check if a hostname is a private/reserved address that should not be
 * reachable from the public gateway (SSRF protection).
 */
export function isPrivateHost(host: string): boolean {
  const lower = host.toLowerCase();

  // Block well-known private hostnames
  if (lower === 'localhost' || lower.endsWith('.local') || lower === '[::1]') {
    return true;
  }

  // IPv6 literals (with or without brackets)
  const rawIpv6 = (lower.startsWith('[') && lower.endsWith(']')) ? lower.slice(1, -1) : lower;

  // Normalize IPv6 to full expanded form for reliable comparison
  const ipv6 = normalizeIpv6(rawIpv6);

  if (ipv6 !== null) {
    // Loopback ::1
    if (ipv6 === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
    // Unspecified ::
    if (ipv6 === '0000:0000:0000:0000:0000:0000:0000:0000') return true;
    // ULA fc00::/7
    const firstWord = parseInt(ipv6.slice(0, 4), 16);
    if ((firstWord & 0xfe00) === 0xfc00) return true;
    // Link-local fe80::/10
    if ((firstWord & 0xffc0) === 0xfe80) return true;
    // Teredo 2001:0000::/32
    if (ipv6.startsWith('2001:0000:')) return true;

    // IPv4-mapped ::ffff:x.x.x.x — extract and recurse
    if (ipv6.startsWith('0000:0000:0000:0000:0000:ffff:')) {
      const lastTwo = ipv6.slice(30).split(':');
      if (lastTwo.length === 2) {
        const hi = Number.parseInt(lastTwo[0], 16);
        const lo = Number.parseInt(lastTwo[1], 16);
        const mappedIp = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateHost(mappedIp);
      }
    }

    // IPv4-compatible ::x.x.x.x (deprecated but still dangerous)
    if (ipv6.startsWith('0000:0000:0000:0000:0000:0000:')) {
      const lastTwo = ipv6.slice(30).split(':');
      if (lastTwo.length === 2) {
        const hi = Number.parseInt(lastTwo[0], 16);
        const lo = Number.parseInt(lastTwo[1], 16);
        const mappedIp = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateHost(mappedIp);
      }
    }
  }

  // Fallback string checks for IPv4-mapped forms with dotted notation
  const v4MappedMatch = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(rawIpv6);
  if (v4MappedMatch) {
    return isPrivateHost(v4MappedMatch[1]);
  }

  // IPv4 check
  const parts = host.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    const octets = parts.map(Number);
    const [a, b] = octets;
    if (
      a === 127 ||                         // 127.0.0.0/8 loopback
      a === 10 ||                           // 10.0.0.0/8 private
      (a === 172 && b >= 16 && b <= 31) ||  // 172.16.0.0/12 private
      (a === 192 && b === 168) ||           // 192.168.0.0/16 private
      (a === 169 && b === 254) ||           // 169.254.0.0/16 link-local
      a === 0                               // 0.0.0.0/8 current network
    ) {
      return true;
    }
  }

  return false;
}