/**
 * Identd (RFC 1413): tells an IRC server which user owns a connection the gateway opened.
 *
 *   Query:    "serverPort, clientPort\r\n"
 *   Response: "serverPort, clientPort : USERID : UNIX : username\r\n"
 *   Error:    "serverPort, clientPort : ERROR : NO-USER\r\n"
 */

import * as net from 'node:net';

const MAX_QUERY_BYTES = 512;

// The IRC server can ask before the gateway has registered the connection
const RETRY_DELAY_MS = 500;

const MAX_CONCURRENT_CONNECTIONS = 50;

// Removes entries whose unregister was missed
const ENTRY_TTL_MS = 10 * 60 * 1000;

/** Printable ASCII only, without spaces or colons (they delimit the response), at most 64 chars. */
function sanitizeUsername(raw: string): string {
  return raw
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[\s:]/g, '_')
    .slice(0, 64);
}

const isValidPort = (port: number): boolean => Number.isInteger(port) && port >= 1 && port <= 65535;

const entryKey = (localPort: number, remotePort: number, remoteHost: string): string => `${localPort},${remotePort},${remoteHost}`;

export class IdentdServer {
  private server: net.Server | null = null;
  private entries = new Map<string, { username: string; createdAt: number }>();
  private connections = new Set<net.Socket>();
  private expiryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly timeoutSeconds: number;

  constructor(timeoutSeconds = 30) {
    this.timeoutSeconds = timeoutSeconds;
  }

  /** `localPort` is the gateway's end of the IRC connection; the remote pair is the IRC server. */
  register(localPort: number, remotePort: number, remoteHost: string, username: string): void {
    const key = entryKey(localPort, remotePort, remoteHost);
    const sanitized = sanitizeUsername(username);
    this.entries.set(key, { username: sanitized, createdAt: Date.now() });
    console.info(`[identd] Registered ${key} → ${sanitized}`);
  }

  unregister(localPort: number, remotePort: number, remoteHost: string): void {
    const key = entryKey(localPort, remotePort, remoteHost);
    this.entries.delete(key);
    console.info(`[identd] Unregistered ${key}`);
  }

  start(port: number, host = '::'): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.handleConnection(socket));

      server.on('error', (error) => {
        console.warn(`[identd] Server error: ${error.message}`);
        reject(error);
      });

      server.listen(port, host, () => {
        this.server = server;
        this.expiryTimer = setInterval(() => this.expireEntries(), ENTRY_TTL_MS);
        console.log(`[identd] Listening on ${host}:${port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      if (this.expiryTimer) {
        clearInterval(this.expiryTimer);
        this.expiryTimer = null;
      }
      // close() waits for open connections, which could take a full query timeout
      for (const socket of this.connections) {
        socket.destroy();
      }
      this.server.close(() => {
        this.server = null;
        this.entries.clear();
        console.info('[identd] Stopped');
        resolve();
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    if (this.connections.size >= MAX_CONCURRENT_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.connections.add(socket);
    socket.once('close', () => this.connections.delete(socket));

    socket.setTimeout(this.timeoutSeconds * 1000);
    socket.on('timeout', () => socket.destroy());
    // A client error only ends its own query
    socket.on('error', () => undefined);

    let received = '';
    const onData = (data: Buffer): void => {
      received += data.toString('ascii');
      if (received.length > MAX_QUERY_BYTES) {
        socket.destroy();
        return;
      }

      const lineEnd = received.indexOf('\n');
      if (lineEnd === -1) {
        return;
      }
      // One query per connection; anything after it is ignored
      socket.off('data', onData);
      this.answerQuery(socket, received.slice(0, lineEnd).replace(/\r$/, ''));
    };
    socket.on('data', onData);
  }

  private answerQuery(socket: net.Socket, line: string): void {
    // Entries are registered with the plain IPv4 form, while this dual-stack listener sees ::ffff:a.b.c.d
    const remoteHost = (socket.remoteAddress ?? '').replace(/^::ffff:/, '');

    const parts = line.split(',').map((part) => part.trim());
    if (parts.length !== 2) {
      this.respond(socket, line, 'ERROR : INVALID-PORT');
      return;
    }

    // The querying IRC server lists its own port second: "our local port, its port"
    const [localPortText = '', remotePortText = ''] = parts;
    const localPort = Number.parseInt(localPortText, 10);
    const remotePort = Number.parseInt(remotePortText, 10);
    if (!isValidPort(localPort) || !isValidPort(remotePort)) {
      this.respond(socket, `${localPortText} , ${remotePortText}`, 'ERROR : INVALID-PORT');
      return;
    }

    const portPair = `${localPort} , ${remotePort}`;
    const key = entryKey(localPort, remotePort, remoteHost);

    const username = this.entries.get(key)?.username;
    if (username) {
      this.respond(socket, portPair, `USERID : UNIX : ${username}`);
      return;
    }

    const retryTimer = setTimeout(() => {
      if (socket.destroyed) {
        return;
      }
      const retryUsername = this.entries.get(key)?.username;
      console.info(`[identd] ${retryUsername ? 'USER' : 'NO-USER'} for ${key}`);
      this.respond(socket, portPair, retryUsername ? `USERID : UNIX : ${retryUsername}` : 'ERROR : NO-USER');
    }, RETRY_DELAY_MS);
    socket.once('close', () => clearTimeout(retryTimer));
  }

  private expireEntries(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.createdAt > ENTRY_TTL_MS) {
        this.entries.delete(key);
        console.info(`[identd] Expired stale entry ${key}`);
      }
    }
  }

  private respond(socket: net.Socket, portPair: string, response: string): void {
    if (socket.writable) {
      socket.end(`${portPair} : ${response}\r\n`);
    }
  }
}
