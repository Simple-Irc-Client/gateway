import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Gateway } from '../gateway.js';
import { loadConfig } from '../config.js';
import WebSocket from 'ws';

describe('Gateway', () => {
  let gateway: Gateway;
  const TEST_PORT = 18667;

  beforeEach(() => {
    loadConfig({ port: TEST_PORT, host: '127.0.0.1', path: '/irc' });
    gateway = new Gateway();
    gateway.start();
  });

  afterEach(() => {
    gateway.stop();
  });

  it('starts and accepts connections', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/irc`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 1000);
    });

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('rejects connections on wrong path', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/wrong`);

    await expect(
      new Promise<void>((resolve, reject) => {
        ws.on('open', () => reject(new Error('should not connect')));
        ws.on('error', () => resolve());
        setTimeout(() => reject(new Error('timeout')), 1000);
      })
    ).resolves.toBeUndefined();
  });

  it('enforces max connections per IP', async () => {
    loadConfig({ port: TEST_PORT, host: '127.0.0.1', path: '/irc', maxConnectionsPerIp: 2 });
    gateway.stop();
    gateway = new Gateway();
    gateway.start();

    await new Promise((r) => setTimeout(r, 50));

    const ws1 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/irc`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/irc`);

    await Promise.all([
      new Promise<void>((resolve) => ws1.on('open', resolve)),
      new Promise<void>((resolve) => ws2.on('open', resolve)),
    ]);

    const ws3 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/irc`);

    await expect(
      new Promise<void>((resolve, reject) => {
        ws3.on('open', () => reject(new Error('should not connect')));
        ws3.on('error', () => resolve());
        setTimeout(() => reject(new Error('timeout')), 1000);
      })
    ).resolves.toBeUndefined();

    ws1.close();
    ws2.close();
  });

  it('handles disconnect command', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/irc`);

    await new Promise<void>((resolve) => ws.on('open', resolve));

    ws.send(JSON.stringify({ event: 'sic-client-event', data: { type: 'disconnect' } }));

    // Should not crash
    await new Promise((r) => setTimeout(r, 50));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('handles raw command without connection', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/irc`);

    await new Promise<void>((resolve) => ws.on('open', resolve));

    // Should not crash when sending raw without IRC connection
    ws.send(JSON.stringify({ event: 'sic-client-event', data: { type: 'raw', line: 'PING test' } }));

    await new Promise((r) => setTimeout(r, 50));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('rejects disallowed servers when allowedServers is set', async () => {
    loadConfig({
      port: TEST_PORT,
      host: '127.0.0.1',
      path: '/irc',
      allowedServers: ['irc.allowed.com:6667'],
    });
    gateway.stop();
    gateway = new Gateway();
    gateway.start();

    await new Promise((r) => setTimeout(r, 50));

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/irc`);
    const messages: string[] = [];

    await new Promise<void>((resolve) => ws.on('open', resolve));

    ws.on('message', (data) => messages.push(data.toString()));

    ws.send(
      JSON.stringify({
        event: 'sic-client-event',
        data: { type: 'connect', nick: 'test', host: 'irc.notallowed.com', port: 6667 },
      })
    );

    await new Promise((r) => setTimeout(r, 100));

    const errorMsg = messages.find((m) => m.includes('sic-gateway-event'));
    expect(errorMsg).toBeTruthy();
    expect(errorMsg).toContain('not allowed');

    ws.close();
  });

  it('ignores invalid JSON', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/irc`);

    await new Promise<void>((resolve) => ws.on('open', resolve));

    ws.send('not json');
    ws.send('{invalid json}');

    await new Promise((r) => setTimeout(r, 50));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('ignores unknown events', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/irc`);

    await new Promise<void>((resolve) => ws.on('open', resolve));

    ws.send(JSON.stringify({ event: 'unknown-event', data: {} }));

    await new Promise((r) => setTimeout(r, 50));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});
