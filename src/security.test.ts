/**
 * Security Tests
 *
 * Tests for SSRF protection and IP validation functions
 */

import { describe, it, expect } from 'vitest';
import { normalizeIpv6, isPrivateHost } from './security.js';

describe('Security Functions', () => {
  describe('normalizeIpv6', () => {
    it('normalizes simple IPv6 addresses', () => {
      expect(normalizeIpv6('2001:db8::1')).toBe('2001:0db8:0000:0000:0000:0000:0000:0001');
      expect(normalizeIpv6('::1')).toBe('0000:0000:0000:0000:0000:0000:0000:0001');
      expect(normalizeIpv6('::')).toBe('0000:0000:0000:0000:0000:0000:0000:0000');
    });

    it('returns null for invalid IPv6 addresses', () => {
      expect(normalizeIpv6('invalid')).toBeNull();
      expect(normalizeIpv6('2001::25de::cade')).toBeNull(); // Multiple ::
      expect(normalizeIpv6('2001:0db8:0000:0000:0000:0000:0000:0000:0001')).toBeNull(); // Too many groups
    });

    it('handles mixed case input', () => {
      expect(normalizeIpv6('2001:DB8::1')).toBe('2001:0db8:0000:0000:0000:0000:0000:0001');
      expect(normalizeIpv6('::1')).toBe('0000:0000:0000:0000:0000:0000:0000:0001');
    });
  });

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

      it('handles IPv6 with zone IDs', () => {
        // Zone IDs should be stripped by the caller before validation
        // This is expected to return false since we don't strip zone IDs
        expect(isPrivateHost('fe80::1%eth0')).toBe(false);
      });
    });
  });
});