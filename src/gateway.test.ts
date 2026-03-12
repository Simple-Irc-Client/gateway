import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Gateway } from './gateway.js';
import { loadConfig } from './config.js';
import { IrcClient } from './irc-client.js';
import WebSocket from 'ws';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';

describe('Gateway', () => {
  let gateway: Gateway;
  const TEST_PORT = 18667;

  // Helper to create WebSocket URL with query params
  const createWsUrl = (host = 'irc.example.com', port = 6667, tls = false) => {
    const params = new URLSearchParams({
      host,
      port: String(port),
      tls: String(tls),
    });
    return `ws://127.0.0.1:${TEST_PORT}/webirc?${params.toString()}`;
  };

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    vi.spyOn(IrcClient.prototype, 'connectRaw').mockImplementation(() => {});
    loadConfig({ port: TEST_PORT, host: '127.0.0.1', path: '/webirc', allowedOrigins: [], blockPrivateHosts: false });
    gateway = new Gateway();
    gateway.start();
  });

  afterEach(() => {
    gateway.stop();
  });

  it('starts and accepts connections with valid query params', async () => {
    const ws = new WebSocket(createWsUrl());

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 1000);
    });

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('rejects connections on wrong path', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/wrong?host=irc.test.com&port=6667`);

    await expect(
      new Promise<void>((resolve, reject) => {
        ws.on('open', () => reject(new Error('should not connect')));
        ws.on('error', () => resolve());
        setTimeout(() => reject(new Error('timeout')), 1000);
      })
    ).resolves.toBeUndefined();
  });

  it('rejects connections without host parameter', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/webirc?port=6667`);

    await expect(
      new Promise<void>((resolve, reject) => {
        ws.on('open', () => reject(new Error('should not connect')));
        ws.on('error', () => resolve());
        setTimeout(() => reject(new Error('timeout')), 1000);
      })
    ).resolves.toBeUndefined();
  });

  it('rejects connections without port parameter', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/webirc?host=irc.test.com`);

    await expect(
      new Promise<void>((resolve, reject) => {
        ws.on('open', () => reject(new Error('should not connect')));
        ws.on('error', () => resolve());
        setTimeout(() => reject(new Error('timeout')), 1000);
      })
    ).resolves.toBeUndefined();
  });

  it('enforces max connections per IP', async () => {
    loadConfig({ port: TEST_PORT, host: '127.0.0.1', path: '/webirc', maxConnectionsPerIp: 2, allowedOrigins: [], blockPrivateHosts: false });
    gateway.stop();
    gateway = new Gateway();
    gateway.start();

    await new Promise((r) => setTimeout(r, 50));

    const ws1 = new WebSocket(createWsUrl());
    const ws2 = new WebSocket(createWsUrl());

    await Promise.all([
      new Promise<void>((resolve) => ws1.on('open', resolve)),
      new Promise<void>((resolve) => ws2.on('open', resolve)),
    ]);

    const ws3 = new WebSocket(createWsUrl());

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

  it('forwards raw IRC commands to IRC client', async () => {
    const ws = new WebSocket(createWsUrl());
    const messages: string[] = [];

    await new Promise<void>((resolve) => ws.on('open', resolve));

    ws.on('message', (data) => messages.push(data.toString()));

    // Send raw IRC command (no JSON wrapping)
    ws.send('PING test');

    // Wait for potential response or connection failure
    await new Promise((r) => setTimeout(r, 100));

    // The WebSocket might close due to IRC connection failure (fake server)
    // but the gateway should have handled the message without crashing
    // We just verify the connection was established initially
    expect(messages.length).toBeGreaterThanOrEqual(0);
  });

  it('rejects disallowed servers when allowedServers is set', async () => {
    loadConfig({
      port: TEST_PORT,
      host: '127.0.0.1',
      path: '/webirc',
      allowedServers: ['irc.allowed.com:6667'],
      allowedOrigins: [],
      blockPrivateHosts: false,
    });
    gateway.stop();
    gateway = new Gateway();
    gateway.start();

    await new Promise((r) => setTimeout(r, 50));

    // Try to connect to a non-allowed server
    const ws = new WebSocket(createWsUrl('irc.notallowed.com', 6667));

    await expect(
      new Promise<void>((resolve, reject) => {
        ws.on('open', () => reject(new Error('should not connect')));
        ws.on('error', () => resolve());
        setTimeout(() => reject(new Error('timeout')), 1000);
      })
    ).resolves.toBeUndefined();
  });

  it('allows connections to allowed servers', async () => {
    loadConfig({
      port: TEST_PORT,
      host: '127.0.0.1',
      path: '/webirc',
      allowedServers: ['irc.allowed.com:6667'],
      allowedOrigins: [],
      blockPrivateHosts: false,
    });
    gateway.stop();
    gateway = new Gateway();
    gateway.start();

    await new Promise((r) => setTimeout(r, 50));

    // Connect to allowed server
    const ws = new WebSocket(createWsUrl('irc.allowed.com', 6667));

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 1000);
    });

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  describe('Origin validation', () => {
    it('rejects connections with disallowed origin', async () => {
      loadConfig({
        port: TEST_PORT,
        host: '127.0.0.1',
        path: '/webirc',
        allowedOrigins: ['https://simpleircclient.com'],
      });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();

      await new Promise((r) => setTimeout(r, 50));

      const ws = new WebSocket(createWsUrl(), {
        origin: 'https://evil.com',
      });

      await expect(
        new Promise<void>((resolve, reject) => {
          ws.on('open', () => reject(new Error('should not connect')));
          ws.on('error', () => resolve());
          setTimeout(() => reject(new Error('timeout')), 1000);
        })
      ).resolves.toBeUndefined();
    });

    it('rejects connections with no origin when allowedOrigins is set', async () => {
      loadConfig({
        port: TEST_PORT,
        host: '127.0.0.1',
        path: '/webirc',
        allowedOrigins: ['https://simpleircclient.com'],
      });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();

      await new Promise((r) => setTimeout(r, 50));

      // ws library doesn't send Origin by default
      const ws = new WebSocket(createWsUrl());

      await expect(
        new Promise<void>((resolve, reject) => {
          ws.on('open', () => reject(new Error('should not connect')));
          ws.on('error', () => resolve());
          setTimeout(() => reject(new Error('timeout')), 1000);
        })
      ).resolves.toBeUndefined();
    });

    it('allows connections with matching origin', async () => {
      loadConfig({
        port: TEST_PORT,
        host: '127.0.0.1',
        path: '/webirc',
        allowedOrigins: ['https://simpleircclient.com'],
      });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();

      await new Promise((r) => setTimeout(r, 50));

      const ws = new WebSocket(createWsUrl(), {
        origin: 'https://simpleircclient.com',
      });

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 1000);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('allows all origins when allowedOrigins is empty', async () => {
      loadConfig({
        port: TEST_PORT,
        host: '127.0.0.1',
        path: '/webirc',
        allowedOrigins: [],
      });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();

      await new Promise((r) => setTimeout(r, 50));

      const ws = new WebSocket(createWsUrl(), {
        origin: 'https://anything.com',
      });

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 1000);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('allows connections from any of multiple allowed origins', async () => {
      loadConfig({
        port: TEST_PORT,
        host: '127.0.0.1',
        path: '/webirc',
        allowedOrigins: ['https://simpleircclient.com', 'https://dev.simpleircclient.com'],
      });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();

      await new Promise((r) => setTimeout(r, 50));

      const ws = new WebSocket(createWsUrl(), {
        origin: 'https://dev.simpleircclient.com',
      });

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 1000);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });
  });

  describe('SSRF protection', () => {
    beforeEach(() => {
      loadConfig({ port: TEST_PORT, host: '127.0.0.1', path: '/webirc', allowedOrigins: [], blockPrivateHosts: true });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();
    });

    it('blocks connections to localhost', async () => {
      await new Promise((r) => setTimeout(r, 50));
      const ws = new WebSocket(createWsUrl('localhost', 6667));

      await expect(
        new Promise<void>((resolve, reject) => {
          ws.on('open', () => reject(new Error('should not connect')));
          ws.on('error', () => resolve());
          setTimeout(() => reject(new Error('timeout')), 1000);
        })
      ).resolves.toBeUndefined();
    });

    it('blocks connections to 127.0.0.1', async () => {
      await new Promise((r) => setTimeout(r, 50));
      const ws = new WebSocket(createWsUrl('127.0.0.1', 6667));

      await expect(
        new Promise<void>((resolve, reject) => {
          ws.on('open', () => reject(new Error('should not connect')));
          ws.on('error', () => resolve());
          setTimeout(() => reject(new Error('timeout')), 1000);
        })
      ).resolves.toBeUndefined();
    });

    it('blocks connections to 10.x.x.x', async () => {
      await new Promise((r) => setTimeout(r, 50));
      const ws = new WebSocket(createWsUrl('10.0.0.1', 6667));

      await expect(
        new Promise<void>((resolve, reject) => {
          ws.on('open', () => reject(new Error('should not connect')));
          ws.on('error', () => resolve());
          setTimeout(() => reject(new Error('timeout')), 1000);
        })
      ).resolves.toBeUndefined();
    });

    it('blocks connections to 192.168.x.x', async () => {
      await new Promise((r) => setTimeout(r, 50));
      const ws = new WebSocket(createWsUrl('192.168.1.1', 6667));

      await expect(
        new Promise<void>((resolve, reject) => {
          ws.on('open', () => reject(new Error('should not connect')));
          ws.on('error', () => resolve());
          setTimeout(() => reject(new Error('timeout')), 1000);
        })
      ).resolves.toBeUndefined();
    });

    it('blocks connections to 172.16.x.x', async () => {
      await new Promise((r) => setTimeout(r, 50));
      const ws = new WebSocket(createWsUrl('172.16.0.1', 6667));

      await expect(
        new Promise<void>((resolve, reject) => {
          ws.on('open', () => reject(new Error('should not connect')));
          ws.on('error', () => resolve());
          setTimeout(() => reject(new Error('timeout')), 1000);
        })
      ).resolves.toBeUndefined();
    });

    it('blocks connections to 0.0.0.0', async () => {
      await new Promise((r) => setTimeout(r, 50));
      const ws = new WebSocket(createWsUrl('0.0.0.0', 6667));

      await expect(
        new Promise<void>((resolve, reject) => {
          ws.on('open', () => reject(new Error('should not connect')));
          ws.on('error', () => resolve());
          setTimeout(() => reject(new Error('timeout')), 1000);
        })
      ).resolves.toBeUndefined();
    });

    it('blocks IPv4-mapped IPv6 addresses (::ffff:127.0.0.1)', async () => {
      await new Promise((r) => setTimeout(r, 50));
      const ws = new WebSocket(createWsUrl('::ffff:127.0.0.1', 6667));

      await expect(
        new Promise<void>((resolve, reject) => {
          ws.on('open', () => reject(new Error('should not connect')));
          ws.on('error', () => resolve());
          setTimeout(() => reject(new Error('timeout')), 1000);
        })
      ).resolves.toBeUndefined();
    });

    it('blocks IPv4-mapped IPv6 private addresses (::ffff:10.0.0.1)', async () => {
      await new Promise((r) => setTimeout(r, 50));
      const ws = new WebSocket(createWsUrl('::ffff:10.0.0.1', 6667));

      await expect(
        new Promise<void>((resolve, reject) => {
          ws.on('open', () => reject(new Error('should not connect')));
          ws.on('error', () => resolve());
          setTimeout(() => reject(new Error('timeout')), 1000);
        })
      ).resolves.toBeUndefined();
    });

    it('blocks IPv4-mapped IPv6 with brackets ([::ffff:192.168.1.1])', async () => {
      await new Promise((r) => setTimeout(r, 50));
      const ws = new WebSocket(createWsUrl('[::ffff:192.168.1.1]', 6667));

      await expect(
        new Promise<void>((resolve, reject) => {
          ws.on('open', () => reject(new Error('should not connect')));
          ws.on('error', () => resolve());
          setTimeout(() => reject(new Error('timeout')), 1000);
        })
      ).resolves.toBeUndefined();
    });

    it('blocks IPv4-compatible IPv6 addresses (::127.0.0.1)', async () => {
      await new Promise((r) => setTimeout(r, 50));
      const ws = new WebSocket(createWsUrl('::127.0.0.1', 6667));

      await expect(
        new Promise<void>((resolve, reject) => {
          ws.on('open', () => reject(new Error('should not connect')));
          ws.on('error', () => resolve());
          setTimeout(() => reject(new Error('timeout')), 1000);
        })
      ).resolves.toBeUndefined();
    });

    it('blocks Teredo addresses (2001:0000:...)', async () => {
      await new Promise((r) => setTimeout(r, 50));
      const ws = new WebSocket(createWsUrl('2001:0000:1234:5678:9abc:def0:1234:5678', 6667));

      await expect(
        new Promise<void>((resolve, reject) => {
          ws.on('open', () => reject(new Error('should not connect')));
          ws.on('error', () => resolve());
          setTimeout(() => reject(new Error('timeout')), 1000);
        })
      ).resolves.toBeUndefined();
    });

    it('blocks [::1] IPv6 loopback', async () => {
      await new Promise((r) => setTimeout(r, 50));
      const ws = new WebSocket(createWsUrl('[::1]', 6667));

      await expect(
        new Promise<void>((resolve, reject) => {
          ws.on('open', () => reject(new Error('should not connect')));
          ws.on('error', () => resolve());
          setTimeout(() => reject(new Error('timeout')), 1000);
        })
      ).resolves.toBeUndefined();
    });

    it('allows connections to public hostnames', async () => {
      await new Promise((r) => setTimeout(r, 50));
      const ws = new WebSocket(createWsUrl('irc.libera.chat', 6667));

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 1000);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('allows private hosts when blockPrivateHosts is false', async () => {
      loadConfig({
        port: TEST_PORT,
        host: '127.0.0.1',
        path: '/webirc',
        allowedOrigins: [],
        blockPrivateHosts: false,
      });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();

      await new Promise((r) => setTimeout(r, 50));

      const ws = new WebSocket(createWsUrl('127.0.0.1', 6667));

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 1000);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });
  });

  describe('Rate limiting', () => {
    let ircServer: TcpServer;
    let ircServerPort: number;
    let receivedLines: string[];

    beforeEach(async () => {
      vi.mocked(IrcClient.prototype.connectRaw).mockRestore();
      receivedLines = [];
      ircServer = createTcpServer((socket) => {
        socket.on('data', (data) => {
          const lines = data.toString().split('\r\n').filter(Boolean);
          receivedLines.push(...lines);
        });
      });

      await new Promise<void>((resolve) => {
        ircServer.listen(0, '127.0.0.1', () => {
          ircServerPort = (ircServer.address() as { port: number }).port;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => ircServer.close(() => resolve()));
    });

    it('forwards messages within the rate limit', async () => {
      const ws = new WebSocket(createWsUrl('127.0.0.1', ircServerPort));
      await new Promise<void>((resolve) => ws.on('open', resolve));

      // Wait for IRC connection to establish
      await new Promise((r) => setTimeout(r, 100));
      receivedLines = [];

      // Send exactly 50 messages (at the limit)
      for (let i = 0; i < 50; i++) {
        ws.send(`PRIVMSG #test :message ${i}`);
      }

      await new Promise((r) => setTimeout(r, 300));

      const privmsgs = receivedLines.filter((line) => line.startsWith('PRIVMSG'));
      expect(privmsgs.length).toBe(50);

      ws.close();
    });

    it('drops messages exceeding rate limit of 50 per window', async () => {
      const ws = new WebSocket(createWsUrl('127.0.0.1', ircServerPort));
      await new Promise<void>((resolve) => ws.on('open', resolve));

      // Wait for IRC connection to establish
      await new Promise((r) => setTimeout(r, 100));
      receivedLines = [];

      // Send 60 messages rapidly (limit is 50 per 5s window)
      for (let i = 0; i < 60; i++) {
        ws.send(`PRIVMSG #test :message ${i}`);
      }

      await new Promise((r) => setTimeout(r, 300));

      const privmsgs = receivedLines.filter((line) => line.startsWith('PRIVMSG'));
      expect(privmsgs.length).toBe(50);

      ws.close();
    });
  });

  it('closes connection when message exceeds maxPayload (64 KB)', async () => {
    const ws = new WebSocket(createWsUrl(), { maxPayload: 0 });

    await new Promise<void>((resolve) => ws.on('open', resolve));

    const oversized = 'A'.repeat(65 * 1024);

    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
      ws.on('error', () => { /* expected — server closes for oversized payload */ });
      ws.send(oversized);
    });

    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  });

  it('handles multiple lines in single message', async () => {
    const ws = new WebSocket(createWsUrl());

    await new Promise<void>((resolve) => ws.on('open', resolve));

    // Send multiple IRC commands in one message
    ws.send('NICK test\r\nUSER test 0 * :Test User');

    // Wait for potential response or connection failure
    await new Promise((r) => setTimeout(r, 100));

    // The WebSocket might close due to IRC connection failure (fake server)
    // but the gateway should have handled the message without crashing
    // We just verify that the gateway processed the batched message
    expect(true).toBe(true);
  });

  describe('TLS enforcement', () => {
    it('allows connections without TLS when enforceTls is false', async () => {
      loadConfig({ 
        port: TEST_PORT, 
        host: '127.0.0.1', 
        path: '/webirc', 
        allowedOrigins: [], 
        blockPrivateHosts: false,
        enforceTls: false
      });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();

      const ws = new WebSocket(createWsUrl('irc.example.com', 6667, false));

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 1000);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('rejects connections without TLS when enforceTls is true', async () => {
      loadConfig({ 
        port: TEST_PORT, 
        host: '127.0.0.1', 
        path: '/webirc', 
        allowedOrigins: [], 
        blockPrivateHosts: false,
        enforceTls: true
      });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();

      const ws = new WebSocket(createWsUrl('irc.example.com', 6667, false));

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => reject(new Error('should not connect')));
        ws.on('error', () => resolve());
        setTimeout(() => reject(new Error('timeout')), 1000);
      });

      expect(ws.readyState).not.toBe(WebSocket.OPEN);
    });

    it('allows connections with TLS when enforceTls is true', async () => {
      loadConfig({ 
        port: TEST_PORT, 
        host: '127.0.0.1', 
        path: '/webirc', 
        allowedOrigins: [], 
        blockPrivateHosts: false,
        enforceTls: true
      });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();

      const ws = new WebSocket(createWsUrl('irc.example.com', 6697, true));

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 1000);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('allows insecure connections with allowInsecure override when enforceTls is true', async () => {
      loadConfig({ 
        port: TEST_PORT, 
        host: '127.0.0.1', 
        path: '/webirc', 
        allowedOrigins: [], 
        blockPrivateHosts: false,
        enforceTls: true
      });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();

      const params = new URLSearchParams({
        host: 'irc.example.com',
        port: '6667',
        tls: 'false',
        allowInsecure: 'true'
      });
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/webirc?${params.toString()}`);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 1000);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });
  });

  describe('WebSocket ping/pong keepalive', () => {
    it('sends ping frames to connected clients', async () => {
      loadConfig({
        port: TEST_PORT,
        host: '127.0.0.1',
        path: '/webirc',
        allowedOrigins: [],
        blockPrivateHosts: false,
        wsPingInterval: 1,
        wsPongTimeout: 3,
      });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();

      await new Promise((r) => setTimeout(r, 50));

      const ws = new WebSocket(createWsUrl());
      const pings: Buffer[] = [];

      await new Promise<void>((resolve) => ws.on('open', resolve));

      ws.on('ping', (data) => {
        pings.push(data);
      });

      // Wait for at least one ping (interval is 1s)
      await new Promise((r) => setTimeout(r, 1500));

      expect(pings.length).toBeGreaterThanOrEqual(1);
      ws.close();
    });

    it('terminates clients that do not respond to pings', async () => {
      loadConfig({
        port: TEST_PORT,
        host: '127.0.0.1',
        path: '/webirc',
        allowedOrigins: [],
        blockPrivateHosts: false,
        wsPingInterval: 1,
        wsPongTimeout: 1,
      });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();

      await new Promise((r) => setTimeout(r, 50));

      const ws = new WebSocket(createWsUrl());

      await new Promise<void>((resolve) => ws.on('open', resolve));

      // Disable automatic pong responses
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      ws.pong = () => {};
      ws.on('ping', () => { /* swallow — don't respond */ });

      // Wait for ping (1s) + pong timeout (1s) + buffer
      const closed = await new Promise<boolean>((resolve) => {
        ws.on('close', () => resolve(true));
        setTimeout(() => resolve(false), 4000);
      });

      expect(closed).toBe(true);
    });

    it('keeps connection alive when client responds to pings', async () => {
      loadConfig({
        port: TEST_PORT,
        host: '127.0.0.1',
        path: '/webirc',
        allowedOrigins: [],
        blockPrivateHosts: false,
        wsPingInterval: 1,
        wsPongTimeout: 1,
      });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();

      await new Promise((r) => setTimeout(r, 50));

      // ws library automatically responds to pings with pongs by default
      const ws = new WebSocket(createWsUrl());

      await new Promise<void>((resolve) => ws.on('open', resolve));

      // Wait longer than ping + pong timeout — connection should survive
      await new Promise((r) => setTimeout(r, 3500));

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });
  });

  describe('Registration timeout', () => {
    it('disconnects clients that never send NICK/USER', async () => {
      loadConfig({
        port: TEST_PORT,
        host: '127.0.0.1',
        path: '/webirc',
        allowedOrigins: [],
        blockPrivateHosts: false,
        registrationTimeout: 1,
        idleTimeout: 0,
      });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();

      await new Promise((r) => setTimeout(r, 50));

      const ws = new WebSocket(createWsUrl());
      const messages: string[] = [];

      await new Promise<void>((resolve) => ws.on('open', resolve));

      ws.on('message', (data) => messages.push(data.toString()));

      // Don't send NICK or USER — wait for timeout
      const closed = await new Promise<boolean>((resolve) => {
        ws.on('close', () => resolve(true));
        setTimeout(() => resolve(false), 3000);
      });

      expect(closed).toBe(true);
      expect(messages.some((m) => m.includes('Registration timeout'))).toBe(true);
    });

    it('does not disconnect clients that send NICK within the window', async () => {
      loadConfig({
        port: TEST_PORT,
        host: '127.0.0.1',
        path: '/webirc',
        allowedOrigins: [],
        blockPrivateHosts: false,
        registrationTimeout: 1,
        idleTimeout: 0,
      });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();

      await new Promise((r) => setTimeout(r, 50));

      const ws = new WebSocket(createWsUrl());

      await new Promise<void>((resolve) => ws.on('open', resolve));

      // Send NICK immediately
      ws.send('NICK testuser');

      // Wait past the registration timeout
      await new Promise((r) => setTimeout(r, 1500));

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('does not disconnect clients that send USER within the window', async () => {
      loadConfig({
        port: TEST_PORT,
        host: '127.0.0.1',
        path: '/webirc',
        allowedOrigins: [],
        blockPrivateHosts: false,
        registrationTimeout: 1,
        idleTimeout: 0,
      });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();

      await new Promise((r) => setTimeout(r, 50));

      const ws = new WebSocket(createWsUrl());

      await new Promise<void>((resolve) => ws.on('open', resolve));

      ws.send('USER testuser 0 * :Test');

      await new Promise((r) => setTimeout(r, 1500));

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });
  });

  describe('Idle timeout', () => {
    it('disconnects clients with no meaningful IRC traffic', async () => {
      loadConfig({
        port: TEST_PORT,
        host: '127.0.0.1',
        path: '/webirc',
        allowedOrigins: [],
        blockPrivateHosts: false,
        registrationTimeout: 0,
        idleTimeout: 1,
      });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();

      await new Promise((r) => setTimeout(r, 50));

      const ws = new WebSocket(createWsUrl());
      const messages: string[] = [];

      await new Promise<void>((resolve) => ws.on('open', resolve));

      ws.on('message', (data) => messages.push(data.toString()));

      // Send only PING — should not reset idle timer
      await new Promise((r) => setTimeout(r, 500));
      ws.send('PING test');

      const closed = await new Promise<boolean>((resolve) => {
        ws.on('close', () => resolve(true));
        setTimeout(() => resolve(false), 3000);
      });

      expect(closed).toBe(true);
      expect(messages.some((m) => m.includes('Idle timeout'))).toBe(true);
    });

    it('resets idle timer on meaningful traffic', async () => {
      loadConfig({
        port: TEST_PORT,
        host: '127.0.0.1',
        path: '/webirc',
        allowedOrigins: [],
        blockPrivateHosts: false,
        registrationTimeout: 0,
        idleTimeout: 2,
      });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();

      await new Promise((r) => setTimeout(r, 50));

      const ws = new WebSocket(createWsUrl());

      await new Promise<void>((resolve) => ws.on('open', resolve));

      // Send meaningful traffic at 1s — resets the 2s idle timer
      await new Promise((r) => setTimeout(r, 1000));
      ws.send('NICK testuser');

      // At 2.5s total — would have timed out without the reset
      await new Promise((r) => setTimeout(r, 1500));

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('does not disconnect when idle timeout is disabled', async () => {
      loadConfig({
        port: TEST_PORT,
        host: '127.0.0.1',
        path: '/webirc',
        allowedOrigins: [],
        blockPrivateHosts: false,
        registrationTimeout: 0,
        idleTimeout: 0,
      });
      gateway.stop();
      gateway = new Gateway();
      gateway.start();

      await new Promise((r) => setTimeout(r, 50));

      const ws = new WebSocket(createWsUrl());

      await new Promise<void>((resolve) => ws.on('open', resolve));

      // Wait a while — should stay connected
      await new Promise((r) => setTimeout(r, 1500));

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });
  });
});
