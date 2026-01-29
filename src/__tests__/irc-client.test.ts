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
        serverPort = typeof addr === 'object' ? addr!.port : 0;
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

  it('sends WEBIRC when configured', async () => {
    client.connect({
      host: '127.0.0.1',
      port: serverPort,
      nick: 'testnick',
      webirc: { password: 'webircpass', gateway: 'mygateway', hostname: '1.2.3.4.web', ip: '1.2.3.4' },
    });

    await new Promise((r) => setTimeout(r, 50));
    const allData = receivedData.join('');

    expect(allData).toContain('WEBIRC webircpass mygateway 1.2.3.4.web 1.2.3.4');
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
        serverPort = typeof addr === 'object' ? addr!.port : 0;
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
