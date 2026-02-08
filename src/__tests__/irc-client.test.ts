import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IrcClient } from '../irc-client.js';
import { createServer, Server } from 'net';

describe('IrcClient', () => {
  let client: IrcClient;
  let server: Server;
  let serverPort: number;
  let receivedData: string[] = [];

  beforeEach(async () => {
    client = new IrcClient();
    receivedData = [];

    // Create a simple TCP server to test against
    server = createServer((socket) => {
      socket.on('data', (data) => {
        receivedData.push(data.toString());
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(async () => {
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('emits socket_connected on connect', async () => {
    const onConnect = vi.fn();
    client.on('socket_connected', onConnect);

    client.connect({ host: '127.0.0.1', port: serverPort, nick: 'testnick' });

    await new Promise((r) => setTimeout(r, 50));
    expect(onConnect).toHaveBeenCalled();
  });

  it('sends CAP, NICK and USER on connect', async () => {
    client.connect({ host: '127.0.0.1', port: serverPort, nick: 'testnick' });

    await new Promise((r) => setTimeout(r, 50));
    const allData = receivedData.join('');

    expect(allData).toContain('CAP LS 302');
    expect(allData).toContain('NICK testnick');
    expect(allData).toContain('USER testnick');
  });

  it('sends PASS when password provided', async () => {
    client.connect({ host: '127.0.0.1', port: serverPort, nick: 'testnick', password: 'secret' });

    await new Promise((r) => setTimeout(r, 50));
    const allData = receivedData.join('');

    expect(allData).toContain('PASS secret');
  });

  it('skips WEBIRC and emits error on non-TLS connection', async () => {
    const onError = vi.fn();
    client.on('error', onError);

    client.connect({
      host: '127.0.0.1',
      port: serverPort,
      nick: 'testnick',
      webirc: { password: 'webircpass', gateway: 'mygateway', hostname: '1.2.3.4.web', ip: '1.2.3.4' },
    });

    await new Promise((r) => setTimeout(r, 50));
    const allData = receivedData.join('');

    // WEBIRC should NOT be sent over non-TLS
    expect(allData).not.toContain('WEBIRC');
    // Error should be emitted
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('TLS') })
    );
  });

  it('emits raw events for outgoing lines', async () => {
    const onRaw = vi.fn();
    client.on('raw', onRaw);

    client.connect({ host: '127.0.0.1', port: serverPort, nick: 'testnick' });

    await new Promise((r) => setTimeout(r, 50));

    // Check that raw events were emitted for outgoing messages (fromServer = false)
    expect(onRaw).toHaveBeenCalledWith(expect.stringContaining('NICK'), false);
  });

  it('reports connected status', async () => {
    expect(client.connected).toBe(false);

    client.connect({ host: '127.0.0.1', port: serverPort, nick: 'testnick' });
    await new Promise((r) => setTimeout(r, 50));

    expect(client.connected).toBe(true);
  });

  it('sends QUIT on quit()', async () => {
    client.connect({ host: '127.0.0.1', port: serverPort, nick: 'testnick' });
    await new Promise((r) => setTimeout(r, 50));

    receivedData = [];
    client.quit('Goodbye');

    await new Promise((r) => setTimeout(r, 50));
    const allData = receivedData.join('');

    expect(allData).toContain('QUIT :Goodbye');
  });

  it('sends raw messages via send()', async () => {
    client.connect({ host: '127.0.0.1', port: serverPort, nick: 'testnick' });
    await new Promise((r) => setTimeout(r, 50));

    receivedData = [];
    client.send('PRIVMSG #test :Hello');

    await new Promise((r) => setTimeout(r, 50));
    const allData = receivedData.join('');

    expect(allData).toContain('PRIVMSG #test :Hello');
  });

  it('emits close on disconnect', async () => {
    const onClose = vi.fn();
    client.on('close', onClose);

    client.connect({ host: '127.0.0.1', port: serverPort, nick: 'testnick' });
    await new Promise((r) => setTimeout(r, 50));

    client.destroy();
    await new Promise((r) => setTimeout(r, 50));

    expect(onClose).toHaveBeenCalled();
  });
});

describe('IrcClient line parsing', () => {
  let client: IrcClient;
  let server: Server;
  let serverPort: number;
  let serverSocket: import('net').Socket | null = null;

  beforeEach(async () => {
    client = new IrcClient();

    server = createServer((socket) => {
      serverSocket = socket;
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(async () => {
    client.destroy();
    serverSocket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('emits raw events for incoming lines', async () => {
    const onRaw = vi.fn();
    client.on('raw', onRaw);

    client.connect({ host: '127.0.0.1', port: serverPort, nick: 'testnick' });
    await new Promise((r) => setTimeout(r, 50));

    serverSocket?.write(':server NOTICE * :Hello\r\n');
    await new Promise((r) => setTimeout(r, 50));

    expect(onRaw).toHaveBeenCalledWith(':server NOTICE * :Hello', true);
  });

  it('responds to PING with PONG', async () => {
    client.connect({ host: '127.0.0.1', port: serverPort, nick: 'testnick' });
    await new Promise((r) => setTimeout(r, 50));

    const received: string[] = [];
    serverSocket?.on('data', (d) => received.push(d.toString()));

    serverSocket?.write('PING :server123\r\n');
    await new Promise((r) => setTimeout(r, 50));

    expect(received.join('')).toContain('PONG :server123');
  });

  it('emits connected on 001 numeric', async () => {
    const onConnected = vi.fn();
    client.on('connected', onConnected);

    client.connect({ host: '127.0.0.1', port: serverPort, nick: 'testnick' });
    await new Promise((r) => setTimeout(r, 50));

    serverSocket?.write(':server 001 testnick :Welcome\r\n');
    await new Promise((r) => setTimeout(r, 50));

    expect(onConnected).toHaveBeenCalled();
  });

  it('emits connected on IRCv3 tagged 001 numeric', async () => {
    const onConnected = vi.fn();
    client.on('connected', onConnected);

    client.connect({ host: '127.0.0.1', port: serverPort, nick: 'testnick' });
    await new Promise((r) => setTimeout(r, 50));

    serverSocket?.write('@time=2026-02-01T00:07:46.552Z :lead.libera.chat 001 testnick :Welcome\r\n');
    await new Promise((r) => setTimeout(r, 50));

    expect(onConnected).toHaveBeenCalled();
  });

  it('does not emit connected on user message containing 001', async () => {
    const onConnected = vi.fn();
    client.on('connected', onConnected);

    client.connect({ host: '127.0.0.1', port: serverPort, nick: 'testnick' });
    await new Promise((r) => setTimeout(r, 50));

    // User message with 001 in it should NOT trigger connected
    serverSocket?.write(':nick!user@host PRIVMSG #channel :error 001 happened\r\n');
    await new Promise((r) => setTimeout(r, 50));

    expect(onConnected).not.toHaveBeenCalled();
  });

  it('destroys connection when receive buffer exceeds 64KB', async () => {
    const onClose = vi.fn();
    const onError = vi.fn();
    client.on('close', onClose);
    client.on('error', onError);

    client.connect({ host: '127.0.0.1', port: serverPort, nick: 'testnick' });
    await new Promise((r) => setTimeout(r, 50));

    // Send 65KB of data without line terminators to overflow the buffer
    const bigData = Buffer.alloc(65 * 1024, 0x41);
    serverSocket?.write(bigData);

    await new Promise((r) => setTimeout(r, 100));

    expect(onClose).toHaveBeenCalled();
  });

  it('handles data within buffer limits without disconnecting', async () => {
    const onRaw = vi.fn();
    const onClose = vi.fn();
    client.on('raw', onRaw);
    client.on('close', onClose);

    client.connect({ host: '127.0.0.1', port: serverPort, nick: 'testnick' });
    await new Promise((r) => setTimeout(r, 50));

    onRaw.mockClear();

    // Send data within limits with proper line terminator
    const message = ':server NOTICE * :' + 'A'.repeat(500) + '\r\n';
    serverSocket?.write(message);

    await new Promise((r) => setTimeout(r, 50));

    expect(onRaw).toHaveBeenCalledWith(
      expect.stringContaining('NOTICE'),
      true
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('handles partial lines correctly', async () => {
    const onRaw = vi.fn();
    client.on('raw', onRaw);

    client.connect({ host: '127.0.0.1', port: serverPort, nick: 'testnick' });
    await new Promise((r) => setTimeout(r, 50));

    onRaw.mockClear();

    // Send partial line
    serverSocket?.write(':server NOTICE');
    await new Promise((r) => setTimeout(r, 20));

    // Line not complete yet
    const callsWithNotice = onRaw.mock.calls.filter(
      ([line, fromServer]) => fromServer && line.includes('NOTICE')
    );
    expect(callsWithNotice.length).toBe(0);

    // Complete the line
    serverSocket?.write(' * :Hello\r\n');
    await new Promise((r) => setTimeout(r, 20));

    expect(onRaw).toHaveBeenCalledWith(':server NOTICE * :Hello', true);
  });
});
