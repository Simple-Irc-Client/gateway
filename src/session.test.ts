import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import WebSocket from 'ws';
import { Gateway } from './gateway.js';
import { loadConfig, type Config } from './config.js';
import { IrcClient } from './irc-client.js';
import { SEQ_TAG } from './playback.js';

const GATEWAY_PORT = 18669;
const WAIT_TIMEOUT_MS = 3000;

const waitFor = async (condition: () => boolean, description: string): Promise<void> => {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** IRC server that welcomes every NICK and records what each connection sent. */
class FakeIrcServer {
  readonly connections: { socket: Socket; received: string[] }[] = [];
  private readonly server: Server = createServer((socket) => {
    const connection = { socket, received: [] as string[] };
    this.connections.push(connection);
    let pending = '';
    socket.on('data', (data) => {
      pending += data.toString();
      const lines = pending.split('\r\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        connection.received.push(line);
        if (line.startsWith('NICK ')) {
          socket.write(`:irc.test 001 ${line.slice('NICK '.length)} :Welcome\r\n`);
        }
      }
    });
    socket.on('error', () => undefined);
  });

  get port(): number {
    return (this.server.address() as { port: number }).port;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    for (const { socket } of this.connections) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  send(connectionIndex: number, line: string): void {
    this.connections[connectionIndex]?.socket.write(`${line}\r\n`);
  }

  received(connectionIndex: number): string[] {
    return this.connections[connectionIndex]?.received ?? [];
  }
}

/** A browser-side WebSocket that records every line it receives. */
class Browser {
  readonly messages: string[] = [];
  closeCode: number | null = null;
  readonly webSocket: WebSocket;

  constructor(params: Record<string, string>) {
    this.webSocket = new WebSocket(`ws://127.0.0.1:${GATEWAY_PORT}/webirc?${new URLSearchParams(params).toString()}`);
    this.webSocket.on('message', (data) => this.messages.push(data.toString()));
    this.webSocket.on('close', (code) => {
      this.closeCode = code;
    });
    this.webSocket.on('error', () => undefined);
  }

  async opened(): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      this.webSocket.once('open', () => resolve());
      this.webSocket.once('error', reject);
    });
    return this;
  }

  async closed(): Promise<void> {
    await waitFor(() => this.closeCode !== null, 'the WebSocket to close');
  }

  get token(): string | undefined {
    return this.messages.find((message) => message.startsWith(':sic-gateway SESSION '))?.split(' ')[2];
  }

  /** Mimics the kernel's registration, then waits for the server's welcome. */
  async register(nick = 'tester'): Promise<this> {
    this.webSocket.send(`NICK ${nick}`);
    this.webSocket.send(`USER ${nick} 0 * :${nick}`);
    await waitFor(() => this.messages.some((message) => message.includes(' 001 ')), 'RPL_WELCOME');
    return this;
  }

  /** Closes without QUIT, as a frozen mobile tab's connection does. */
  async drop(): Promise<void> {
    this.webSocket.close();
    await this.closed();
  }
}

describe('Resumable sessions', () => {
  let gateway: Gateway;
  let ircServer: FakeIrcServer;

  const startGateway = async (overrides: Partial<Config> = {}): Promise<void> => {
    loadConfig({ port: GATEWAY_PORT, host: '127.0.0.1', path: '/webirc', allowedOrigins: [], blockPrivateHosts: false, ...overrides });
    gateway = new Gateway();
    await gateway.start();
  };

  const server = (): Record<string, string> => ({ host: '127.0.0.1', port: String(ircServer.port), tls: 'false' });

  const hasQuit = (connectionIndex: number): boolean => ircServer.received(connectionIndex).some((line) => line.startsWith('QUIT'));

  /** A registered resumable session that just lost its WebSocket. */
  const detachedSession = async (): Promise<{ token: string; lastSeq: number }> => {
    const browser = await new Browser({ ...server(), session: 'true' }).opened();
    await browser.register();
    const token = browser.token ?? '';
    const lastSeq = browser.messages.length - 1;
    await browser.drop();
    // Long enough for a QUIT, if one were sent, to reach the IRC server
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { token, lastSeq };
  };

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    ircServer = new FakeIrcServer();
    await ircServer.start();
  });

  afterEach(async () => {
    await gateway.stop();
    await ircServer.stop();
    vi.restoreAllMocks();
  });

  it('gives a resumable session a token and numbers the lines it relays', async () => {
    await startGateway();
    const browser = await new Browser({ ...server(), session: 'true' }).opened();
    await browser.register();

    expect(browser.messages[0]).toMatch(/^:sic-gateway SESSION [\w-]{22}$/);
    expect(browser.messages[1]).toBe(`@${SEQ_TAG}=1 :irc.test 001 tester :Welcome`);
  });

  it('keeps the plain behavior for browsers that do not ask for a session', async () => {
    await startGateway();
    const browser = await new Browser(server()).opened();
    await browser.register();

    expect(browser.messages).toEqual([':irc.test 001 tester :Welcome']);

    await browser.drop();
    await waitFor(() => hasQuit(0), 'QUIT');
  });

  it('keeps the IRC connection when the browser drops and replays what it missed', async () => {
    await startGateway();
    const { token, lastSeq } = await detachedSession();

    ircServer.send(0, ':friend!u@h PRIVMSG #chan :while you were away');
    ircServer.send(0, '@time=2026-01-01T00:00:00.000Z :friend!u@h PRIVMSG #chan :timed');
    await new Promise((resolve) => setTimeout(resolve, 100));

    const resumed = await new Browser({ ...server(), resume: token, since: String(lastSeq) }).opened();
    await waitFor(() => resumed.messages.length === 3, 'the replay');

    expect(resumed.messages[0]).toBe(':sic-gateway RESUMED complete');
    expect(resumed.messages[1]).toMatch(new RegExp(`^@${SEQ_TAG}=2;time=\\S+Z :friend!u@h PRIVMSG #chan :while you were away$`));
    expect(resumed.messages[2]).toBe(`@${SEQ_TAG}=3;time=2026-01-01T00:00:00.000Z :friend!u@h PRIVMSG #chan :timed`);
    expect(ircServer.connections).toHaveLength(1);
    expect(hasQuit(0)).toBe(false);

    resumed.webSocket.send('PRIVMSG #chan :back');
    await waitFor(() => ircServer.received(0).includes('PRIVMSG #chan :back'), 'the resumed browser to reach IRC');
  });

  it('resumes with no replay when the browser saw every line', async () => {
    await startGateway();
    const { token, lastSeq } = await detachedSession();

    const resumed = await new Browser({ ...server(), resume: token, since: String(lastSeq) }).opened();
    await waitFor(() => resumed.messages.length > 0, 'RESUMED');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(resumed.messages).toEqual([':sic-gateway RESUMED complete']);
  });

  it('reports a partial replay when the buffer overflowed', async () => {
    await startGateway({ sessionBufferSize: 100 });
    const { token, lastSeq } = await detachedSession();

    for (let index = 0; index < 5; index++) {
      ircServer.send(0, `:friend!u@h PRIVMSG #chan :message number ${index}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    const resumed = await new Browser({ ...server(), resume: token, since: String(lastSeq) }).opened();
    await waitFor(() => resumed.messages.length > 1, 'the replay');

    expect(resumed.messages[0]).toBe(':sic-gateway RESUMED partial');
    expect(resumed.messages.at(-1)).toContain('message number 4');
  });

  it('starts a new session for an unknown token', async () => {
    await startGateway();
    const browser = await new Browser({ ...server(), resume: 'not-a-real-token' }).opened();
    await waitFor(() => browser.token !== undefined, 'SESSION');

    expect(browser.token).not.toBe('not-a-real-token');
    await waitFor(() => ircServer.connections.length === 1, 'a new IRC connection');
  });

  it('does not hand a session to a connection for another server', async () => {
    await startGateway();
    const { token } = await detachedSession();

    const browser = await new Browser({ ...server(), port: '1', resume: token }).opened();
    await waitFor(() => browser.messages.length > 0, 'the first line');

    expect(browser.messages[0]).toMatch(/^:sic-gateway SESSION /);
    expect(browser.token).not.toBe(token);
  });

  it('closes the older WebSocket when the session is resumed on a newer one', async () => {
    await startGateway();
    const first = await new Browser({ ...server(), session: 'true' }).opened();
    await first.register();

    const second = await new Browser({ ...server(), resume: first.token ?? '' }).opened();
    await first.closed();
    expect(first.closeCode).toBe(4001);

    ircServer.send(0, ':friend!u@h PRIVMSG #chan :hello');
    await waitFor(() => second.messages.some((message) => message.endsWith('hello')), 'the line on the newer WebSocket');
    expect(hasQuit(0)).toBe(false);
  });

  it('ends the session when the browser quits', async () => {
    await startGateway();
    const browser = await new Browser({ ...server(), session: 'true' }).opened();
    await browser.register();
    browser.webSocket.send('QUIT :bye');
    await browser.drop();

    const retry = await new Browser({ ...server(), resume: browser.token ?? '' }).opened();
    await waitFor(() => retry.messages.length > 0, 'the first line');
    expect(retry.messages[0]).toMatch(/^:sic-gateway SESSION /);
  });

  it('does not keep a session that never registered', async () => {
    await startGateway();
    const browser = await new Browser({ ...server(), session: 'true' }).opened();
    await waitFor(() => ircServer.connections.length === 1, 'the IRC connection');
    await browser.drop();

    await waitFor(() => hasQuit(0), 'QUIT');
  });

  it('quits IRC once the linger time passes without a browser', async () => {
    await startGateway({ sessionLinger: 1 });
    const { token } = await detachedSession();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(hasQuit(0)).toBe(false);

    await waitFor(() => hasQuit(0), 'QUIT after the linger time');

    const retry = await new Browser({ ...server(), resume: token }).opened();
    await waitFor(() => retry.messages.length > 0, 'the first line');
    expect(retry.messages[0]).toMatch(/^:sic-gateway SESSION /);
  });

  it('forgets a detached session whose IRC connection closed', async () => {
    await startGateway();
    const { token } = await detachedSession();

    ircServer.connections[0]?.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const retry = await new Browser({ ...server(), resume: token }).opened();
    await waitFor(() => retry.messages.length > 0, 'the first line');
    expect(retry.messages[0]).toMatch(/^:sic-gateway SESSION /);
  });

  it('resumes IRC reads that were paused for the dropped browser', async () => {
    await startGateway();
    const resume = vi.spyOn(IrcClient.prototype, 'resume');
    await detachedSession();

    expect(resume).toHaveBeenCalled();
  });

  it('ends the session named by replace', async () => {
    await startGateway();
    const { token } = await detachedSession();
    expect(hasQuit(0)).toBe(false);

    await new Browser({ ...server(), session: 'true', replace: token }).opened();

    await waitFor(() => hasQuit(0), 'QUIT of the replaced session');
  });

  it('ends the oldest detached session to make room under the per-IP limit', async () => {
    await startGateway({ maxConnectionsPerIp: 1 });
    await detachedSession();
    expect(hasQuit(0)).toBe(false);

    const browser = await new Browser({ ...server(), session: 'true' }).opened();
    await waitFor(() => browser.token !== undefined, 'SESSION');

    await waitFor(() => hasQuit(0), 'QUIT of the detached session');
  });

  it('still refuses new connections when every session has a browser', async () => {
    await startGateway({ maxClients: 1 });
    await new Browser({ ...server(), session: 'true' }).opened();

    const refused = new Browser({ ...server(), session: 'true' });
    await expect(refused.opened()).rejects.toThrow('503');
  });

  it('ignores session requests when resuming is disabled', async () => {
    await startGateway({ sessionLinger: 0 });
    const browser = await new Browser({ ...server(), session: 'true' }).opened();
    await browser.register();

    expect(browser.messages).toEqual([':irc.test 001 tester :Welcome']);
  });

  it('quits detached sessions on shutdown', async () => {
    await startGateway();
    await detachedSession();
    expect(hasQuit(0)).toBe(false);

    await gateway.stop();
    await startGateway();

    await waitFor(() => hasQuit(0), 'QUIT on shutdown');
  });
});
