import { describe, it, expect } from 'vitest';
import { decode, encode } from '../encoding.js';

describe('encoding', () => {
  describe('decode', () => {
    it('decodes utf8 buffer', () => {
      const buffer = Buffer.from('Hello, World!', 'utf8');
      expect(decode(buffer, 'utf8')).toBe('Hello, World!');
    });

    it('decodes utf-8 buffer (alias)', () => {
      const buffer = Buffer.from('Hello', 'utf8');
      expect(decode(buffer, 'utf-8')).toBe('Hello');
    });

    it('decodes latin1 buffer', () => {
      const buffer = Buffer.from([0xc0, 0xc1, 0xc2]); // À Á Â in latin1
      expect(decode(buffer, 'latin1')).toBe('ÀÁÂ');
    });

    it('decodes iso-8859-2 buffer', () => {
      const buffer = Buffer.from([0xa1, 0xa2, 0xa3]); // Polish chars
      const result = decode(buffer, 'iso-8859-2');
      expect(result).toBeTruthy();
    });

    it('falls back to utf8 on invalid encoding', () => {
      const buffer = Buffer.from('test', 'utf8');
      expect(decode(buffer, 'invalid-encoding-xyz')).toBe('test');
    });

    it('uses utf8 as default', () => {
      const buffer = Buffer.from('default', 'utf8');
      expect(decode(buffer)).toBe('default');
    });
  });

  describe('encode', () => {
    it('encodes to utf8 buffer', () => {
      const result = encode('Hello', 'utf8');
      expect(result.toString('utf8')).toBe('Hello');
    });

    it('encodes to utf-8 buffer (alias)', () => {
      const result = encode('Hello', 'utf-8');
      expect(result.toString('utf8')).toBe('Hello');
    });

    it('encodes to latin1 buffer', () => {
      const result = encode('ÀÁÂ', 'latin1');
      expect(result[0]).toBe(0xc0);
      expect(result[1]).toBe(0xc1);
      expect(result[2]).toBe(0xc2);
    });

    it('falls back to utf8 on invalid encoding', () => {
      const result = encode('test', 'invalid-encoding-xyz');
      expect(result.toString('utf8')).toBe('test');
    });

    it('uses utf8 as default', () => {
      const result = encode('default');
      expect(result.toString('utf8')).toBe('default');
    });
  });

  describe('roundtrip', () => {
    it('roundtrips utf8', () => {
      const original = 'Hello, 世界! 🌍';
      const encoded = encode(original, 'utf8');
      const decoded = decode(encoded, 'utf8');
      expect(decoded).toBe(original);
    });

    it('roundtrips latin1', () => {
      const original = 'Héllo Wörld';
      const encoded = encode(original, 'latin1');
      const decoded = decode(encoded, 'latin1');
      expect(decoded).toBe(original);
    });
  });
});
