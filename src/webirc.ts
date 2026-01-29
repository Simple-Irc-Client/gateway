import type { WebircParams } from './types.js';
import * as net from 'net';

export function buildWebircCommand(params: WebircParams): string {
  const { password, gateway, hostname, ip } = params;
  return `WEBIRC ${password} ${gateway} ${hostname} ${ip}`;
}

export function ipToHex(ip: string): string {
  if (net.isIPv4(ip)) {
    return ip
      .split('.')
      .map((octet) => parseInt(octet, 10).toString(16).padStart(2, '0'))
      .join('');
  }

  if (net.isIPv6(ip)) {
    const full = expandIPv6(ip);
    return full.replace(/:/g, '');
  }

  return ip;
}

function expandIPv6(ip: string): string {
  const parts = ip.split(':');
  const emptyIndex = parts.indexOf('');

  if (emptyIndex !== -1) {
    const before = parts.slice(0, emptyIndex);
    const after = parts.slice(emptyIndex + 1).filter((p) => p !== '');
    const missing = 8 - before.length - after.length;
    const expanded = [...before, ...Array(missing).fill('0000'), ...after];
    parts.length = 0;
    parts.push(...expanded);
  }

  return parts.map((p) => p.padStart(4, '0')).join(':');
}

export function resolveClientHostname(ip: string): string {
  const hexIp = ipToHex(ip);
  return `${hexIp}.web`;
}
