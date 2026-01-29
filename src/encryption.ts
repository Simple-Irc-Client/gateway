import { webcrypto } from 'crypto';

const crypto = webcrypto;

let encryptionKey: webcrypto.CryptoKey | null = null;
let encryptionEnabled = false;

export async function initEncryption(base64Key: string): Promise<void> {
  if (!base64Key) {
    encryptionEnabled = false;
    return;
  }

  const keyData = Buffer.from(base64Key, 'base64');
  if (keyData.length !== 32) {
    throw new Error('Encryption key must be 32 bytes (256 bits)');
  }

  encryptionKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  encryptionEnabled = true;
}

export function isEncryptionEnabled(): boolean {
  return encryptionEnabled;
}

export async function encryptMessage(data: unknown): Promise<string> {
  if (!encryptionEnabled || !encryptionKey) {
    return JSON.stringify(data);
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const messageBytes = new TextEncoder().encode(JSON.stringify(data));

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    encryptionKey,
    messageBytes
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return Buffer.from(combined).toString('base64');
}

export async function decryptMessage(message: string): Promise<unknown> {
  if (!encryptionEnabled || !encryptionKey) {
    return JSON.parse(message);
  }

  const combined = Buffer.from(message, 'base64');
  const iv = combined.subarray(0, 12);
  const encryptedData = combined.subarray(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    encryptionKey,
    encryptedData
  );

  return JSON.parse(new TextDecoder().decode(decrypted));
}

export function generateKey(): string {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(keyBytes).toString('base64');
}
