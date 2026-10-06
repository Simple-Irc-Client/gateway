import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { IrcClient, ircCommand, type IrcClientOptions } from './irc-client.js';
import { privateAddressGuard } from './security.js';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('IrcClient', () => {
  let client: IrcClient;
  let server: Server;
  let serverSocket: Socket | null;
  let receivedBytes: Buffer;
  let received: string;
  let options: IrcClientOptions;

  beforeEach(async () => {
    client = new IrcClient();
    serverSocket = null;
    receivedBytes = Buffer.alloc(0);
    received = '';

    server = createServer((socket) => {
      serverSocket = socket;
      socket.on('data', (data: Buffer) => {
        receivedBytes = Buffer.concat([receivedBytes, data]);
        received = receivedBytes.toString();
      });
      // The client may reset the connection
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    options = { host: '127.0.0.1', port, tls: false, encoding: 'utf8', pongTimeout: 120 };
  });

  afterEach(async () => {
    client.destroy();
    serverSocket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const connect = async (overrides: Partial<IrcClientOptions> = {}): Promise<void> => {
    client.connect({ ...options, ...overrides });
    await wait(50);
  };

  describe('connecting', () => {
    it('emits socket connected with the socket ports', async () => {
      const onConnected = vi.fn();
      client.on('socket connected', onConnected);

      await connect();

      expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ remotePort: options.port, remoteAddress: '127.0.0.1' }));
    });

    it('sends nothing on its own; the browser registers itself', async () => {
      await connect();
      expect(received).toBe('');
    });

    it('sends WEBIRC as the first line', async () => {
      await connect({ webirc: { password: 'secret', gateway: 'gw', hostname: '1.2.3.4.web', ip: '1.2.3.4' } });
      expect(received).toBe('WEBIRC secret gw 1.2.3.4.web 1.2.3.4\r\n');
    });

    it('refuses a host that resolves to a private address', async () => {
      const onError = vi.fn();
      const onConnected = vi.fn();
      client.on('error', onError);
      client.on('socket connected', onConnected);

      await connect({ host: 'localhost', lookup: privateAddressGuard });

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('private address') }));
      expect(onConnected).not.toHaveBeenCalled();
    });

    it('emits close when the connection ends', async () => {
      const onClose = vi.fn();
      client.on('close', onClose);

      await connect();
      client.destroy();
      await wait(50);

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('sending', () => {
    it('terminates lines with CRLF and strips embedded line breaks', async () => {
      await connect();
      client.send('PRIVMSG #test :Hello\r\nQUIT');
      await wait(50);

      expect(received).toBe('PRIVMSG #test :HelloQUIT\r\n');
    });

    it('encodes with the connection encoding', async () => {
      await connect({ encoding: 'iso-8859-2' });
      client.send('PRIVMSG #test :zażółć');
      await wait(50);

      expect(receivedBytes).toEqual(Buffer.from([...Buffer.from('PRIVMSG #test :za'), 0xbf, 0xf3, 0xb3, 0xe6, 0x0d, 0x0a]));
    });

    it('sends QUIT with the message on quit()', async () => {
      await connect();
      client.quit('Goodbye');
      await wait(50);

      expect(received).toContain('QUIT :Goodbye\r\n');
    });

    it('returns false while not connected', () => {
      expect(client.send('PING test')).toBe(false);
      expect(client.writable).toBe(false);
    });

    it('returns true while the socket has buffer space', async () => {
      await connect();
      expect(client.send('PING test')).toBe(true);
      expect(client.writable).toBe(true);
    });
  });

  describe('receiving', () => {
    const collectLines = (): string[] => {
      const lines: string[] = [];
      client.on('line', (line) => lines.push(line));
      return lines;
    };

    it('emits each received line without its terminator', async () => {
      const lines = collectLines();
      await connect();

      serverSocket?.write(':server NOTICE * :Hello\r\n:server NOTICE * :Again\r\n');
      await wait(50);

      expect(lines).toEqual([':server NOTICE * :Hello', ':server NOTICE * :Again']);
    });

    it('accepts lines ending in a bare LF', async () => {
      const lines = collectLines();
      await connect();

      serverSocket?.write(':server NOTICE * :one\n:server NOTICE * :two\n');
      await wait(50);

      expect(lines).toEqual([':server NOTICE * :one', ':server NOTICE * :two']);
    });

    it('waits for the rest of a partial line', async () => {
      const lines = collectLines();
      await connect();

      serverSocket?.write(':server NOTICE');
      await wait(20);
      expect(lines).toEqual([]);

      serverSocket?.write(' * :Hello\r\n');
      await wait(20);
      expect(lines).toEqual([':server NOTICE * :Hello']);
    });

    it('answers a server PING', async () => {
      await connect();

      serverSocket?.write('PING :server123\r\n');
      await wait(50);

      expect(received).toContain('PONG :server123\r\n');
    });

    it('drops the connection when a line exceeds 2 MiB', async () => {
      const onClose = vi.fn();
      client.on('close', onClose);
      client.on('error', () => undefined);
      await connect();

      serverSocket?.write(Buffer.alloc(2.1 * 1024 * 1024, 0x41));
      await wait(100);

      expect(onClose).toHaveBeenCalled();
    });

    it('holds lines back while paused', async () => {
      const lines = collectLines();
      await connect();

      client.pause();
      serverSocket?.write(':server NOTICE * :while-paused\r\n');
      await wait(50);
      expect(lines).toEqual([]);

      client.resume();
      await wait(50);
      expect(lines).toEqual([':server NOTICE * :while-paused']);
    });
  });

  describe('waitForDrain', () => {
    it('rejects while not connected', async () => {
      await expect(client.waitForDrain()).rejects.toThrow('Socket closed');
    });

    it('resolves at once when nothing is buffered', async () => {
      await connect();
      await expect(client.waitForDrain()).resolves.toBeUndefined();
    });
  });
});

describe('ircCommand', () => {
  it('returns the command word in upper case', () => {
    expect(ircCommand('ping :x')).toBe('PING');
  });

  it('skips the source', () => {
    expect(ircCommand(':server PONG server :123')).toBe('PONG');
  });

  it('skips IRCv3 tags and the source', () => {
    expect(ircCommand('@time=2026-01-01T00:00:00Z :server PING :x')).toBe('PING');
    expect(ircCommand('@label=1 NICK me')).toBe('NICK');
  });
});
