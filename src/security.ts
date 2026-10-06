// SSRF protection: the public gateway must not be usable to reach private or reserved addresses

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

const blockedAddresses = new BlockList();

// IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are matched against these too
blockedAddresses.addSubnet('0.0.0.0', 8, 'ipv4'); // current network
blockedAddresses.addSubnet('10.0.0.0', 8, 'ipv4'); // private
blockedAddresses.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
blockedAddresses.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local, incl. cloud metadata
blockedAddresses.addSubnet('172.16.0.0', 12, 'ipv4'); // private
blockedAddresses.addSubnet('192.168.0.0', 16, 'ipv4'); // private

blockedAddresses.addSubnet('::', 96, 'ipv6'); // unspecified, loopback and deprecated IPv4-compatible
blockedAddresses.addSubnet('fc00::', 7, 'ipv6'); // unique local
blockedAddresses.addSubnet('fe80::', 10, 'ipv6'); // link-local
blockedAddresses.addSubnet('2001::', 32, 'ipv6'); // Teredo, tunnels to arbitrary IPv4

/** True for an IP literal in a blocked range; hostnames are judged by `isPrivateHost`. */
export function isPrivateAddress(address: string): boolean {
  const unzoned = address.replace(/%.*$/, '');
  const family = isIP(unzoned);
  if (family === 0) {
    return false;
  }
  return blockedAddresses.check(unzoned, family === 4 ? 'ipv4' : 'ipv6');
}

/** Rejects a host by name alone; a hostname resolving to a private address is caught by `privateAddressGuard`. */
export function isPrivateHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local')) {
    return true;
  }
  const unbracketed = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  return isPrivateAddress(unbracketed);
}

/**
 * DNS lookup for outgoing sockets that fails on private addresses.
 * The check runs on the address actually connected to, so DNS rebinding can't slip past it.
 */
export const privateAddressGuard: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) {
      callback(error, '', 0);
      return;
    }

    const blocked = addresses.find(({ address }) => isPrivateAddress(address));
    if (blocked) {
      callback(new Error(`Connection to private address ${blocked.address} is not allowed`), '', 0);
      return;
    }

    if (options.all) {
      // The callback type only models the single-address form
      (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, addresses);
      return;
    }
    const [first] = addresses;
    if (!first) {
      callback(new Error(`No addresses found for ${hostname}`), '', 0);
      return;
    }
    callback(null, first.address, first.family);
  });
};
