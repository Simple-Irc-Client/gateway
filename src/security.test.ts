/**
 * Security Tests
 *
 * Tests for SSRF protection and IP validation functions
 */

import { describe, it, expect } from 'vitest';
import { isPrivateHost, privateAddressGuard } from './security.js';

describe('Security Functions', () => {
  describe('isPrivateHost', () => {
    describe('IPv4 private ranges', () => {
      it('blocks loopback addresses', () => {
        expect(isPrivateHost('127.0.0.1')).toBe(true);
        expect(isPrivateHost('127.0.0.0')).toBe(true);
        expect(isPrivateHost('127.1.2.3')).toBe(true);
      });

      it('blocks RFC1918 private ranges', () => {
        // 10.0.0.0/8
        expect(isPrivateHost('10.0.0.1')).toBe(true);
        expect(isPrivateHost('10.255.255.254')).toBe(true);

        // 172.16.0.0/12
        expect(isPrivateHost('172.16.0.1')).toBe(true);
        expect(isPrivateHost('172.31.255.254')).toBe(true);
        expect(isPrivateHost('172.15.255.254')).toBe(false); // Just below range
        expect(isPrivateHost('172.32.0.1')).toBe(false); // Just above range

        // 192.168.0.0/16
        expect(isPrivateHost('192.168.0.1')).toBe(true);
        expect(isPrivateHost('192.168.255.254')).toBe(true);
      });

      it('blocks link-local range', () => {
        expect(isPrivateHost('169.254.0.1')).toBe(true);
        expect(isPrivateHost('169.254.255.254')).toBe(true);
      });

      it('blocks 0.0.0.0/8', () => {
        expect(isPrivateHost('0.0.0.0')).toBe(true);
        expect(isPrivateHost('0.1.2.3')).toBe(true);
      });

      it('allows public IPv4 addresses', () => {
        expect(isPrivateHost('8.8.8.8')).toBe(false); // Google DNS
        expect(isPrivateHost('1.1.1.1')).toBe(false); // Cloudflare DNS
        expect(isPrivateHost('142.250.190.46')).toBe(false); // Google
      });
    });

    describe('IPv6 private ranges', () => {
      it('blocks loopback ::1', () => {
        expect(isPrivateHost('::1')).toBe(true);
        expect(isPrivateHost('[::1]')).toBe(true);
      });

      it('blocks unspecified address ::', () => {
        expect(isPrivateHost('::')).toBe(true);
      });

      it('blocks link-local fe80::/10', () => {
        expect(isPrivateHost('fe80::1')).toBe(true);
        expect(isPrivateHost('fe80:1234::1')).toBe(true);
        expect(isPrivateHost('febf:ffff::1')).toBe(true);
      });

      it('blocks ULA fc00::/7', () => {
        expect(isPrivateHost('fc00::1')).toBe(true);
        expect(isPrivateHost('fdff:ffff::1')).toBe(true);
      });

      it('blocks Teredo 2001:0000::/32', () => {
        expect(isPrivateHost('2001:0000::1')).toBe(true);
        expect(isPrivateHost('2001:0:4136:e378:8000:63bf:3fff:fdd2')).toBe(true);
      });

      it('allows global unicast IPv6 addresses', () => {
        expect(isPrivateHost('2001:4860:4860::8888')).toBe(false); // Google DNS
        expect(isPrivateHost('2606:4700:4700::1111')).toBe(false); // Cloudflare DNS
        expect(isPrivateHost('2a00:1450:4001:81c::200e')).toBe(false); // Google
      });
    });

    describe('IPv4-mapped IPv6 addresses', () => {
      it('blocks ::ffff:127.0.0.1', () => {
        expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true);
      });

      it('blocks ::ffff:10.0.0.1', () => {
        expect(isPrivateHost('::ffff:10.0.0.1')).toBe(true);
      });

      it('blocks ::ffff:192.168.0.1', () => {
        expect(isPrivateHost('::ffff:192.168.0.1')).toBe(true);
      });

      it('allows ::ffff:8.8.8.8', () => {
        expect(isPrivateHost('::ffff:8.8.8.8')).toBe(false);
      });
    });

    describe('Hostnames', () => {
      it('blocks localhost', () => {
        expect(isPrivateHost('localhost')).toBe(true);
      });

      it('blocks .local domains', () => {
        expect(isPrivateHost('test.local')).toBe(true);
        expect(isPrivateHost('mycomputer.local')).toBe(true);
      });

      it('allows regular hostnames', () => {
        expect(isPrivateHost('irc.example.com')).toBe(false);
        expect(isPrivateHost('gateway.example.org')).toBe(false);
      });
    });

    describe('Edge cases', () => {
      it('handles invalid inputs gracefully', () => {
        expect(isPrivateHost('')).toBe(false);
        expect(isPrivateHost('not-an-ip')).toBe(false);
        expect(isPrivateHost('999.999.999.999')).toBe(false);
      });

      it('blocks link-local IPv6 with a zone ID', () => {
        expect(isPrivateHost('fe80::1%eth0')).toBe(true);
      });

      it('blocks deprecated IPv4-compatible IPv6 addresses', () => {
        expect(isPrivateHost('::127.0.0.1')).toBe(true);
        expect(isPrivateHost('::8.8.8.8')).toBe(true);
      });
    });
  });

  describe('privateAddressGuard', () => {
    const resolve = (hostname: string, all: boolean): Promise<unknown> =>
      new Promise((done, fail) => {
        privateAddressGuard(hostname, { all }, (error, address) => (error ? fail(error) : done(address)));
      });

    it('refuses a hostname that resolves to a private address', async () => {
      await expect(resolve('localhost', false)).rejects.toThrow('private address');
      await expect(resolve('localhost', true)).rejects.toThrow('private address');
    });

    it('passes a public address through in both callback forms', async () => {
      await expect(resolve('8.8.8.8', false)).resolves.toBe('8.8.8.8');
      await expect(resolve('8.8.8.8', true)).resolves.toEqual([{ address: '8.8.8.8', family: 4 }]);
    });

    it('passes DNS errors through', async () => {
      await expect(resolve('does-not-exist.invalid', false)).rejects.toThrow();
    });
  });
});
