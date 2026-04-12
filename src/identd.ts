/**
 * Identd (RFC 1413) Server
 *
 * Responds to ident queries from IRC servers to verify the identity of
 * connecting clients. When the gateway proxies a TCP connection on behalf
 * of a WebSocket client, it registers the local/remote port pair so the
 * IRC server can query port 113 and receive the correct username.
 *
 * Protocol (RFC 1413):
 *   Query:    "serverPort, clientPort\r\n"
 *   Response: "serverPort, clientPort : USERID : UNIX : username\r\n"
 *   Error:    "serverPort, clientPort : ERROR : NO-USER\r\n"
 */

import * as net from 'node:net';


// ============================================================================
// Types
// ============================================================================

export interface IdentdEntry {
  localPort: number;
  remotePort: number;
  remoteHost: string;
  username: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum bytes to buffer from an ident client before closing */
const MAX_RECEIVE_BYTES = 512;

/** Delay before retrying a lookup miss (race condition mitigation) */
const RETRY_DELAY_MS = 500;

/** Maximum concurrent connections to the identd server */
const MAX_CONCURRENT_CONNECTIONS = 50;

/** Time-to-live for entries in milliseconds (safety net for missed unregister calls) */
const ENTRY_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ============================================================================
// Username Sanitization
// ============================================================================

/**
 * Sanitize a username for ident responses.
 * Strips non-ASCII, replaces spaces/colons with underscore, truncates to 64 chars.
 */
function sanitizeUsername(raw: string): string {
  return raw
    .replace(/[^\x20-\x7E]/g, '')   // strip non-printable / non-ASCII
    .replace(/[\s:]/g, '_')          // replace spaces and colons
    .slice(0, 64);
}

// ============================================================================
// IdentdServer Class
// ============================================================================

export class IdentdServer {
  private server: net.Server | null = null;
  private entries = new Map<string, { username: string; createdAt: number }>();
  private timeoutSeconds: number;
  private activeConnections = 0;
  private entryExpiryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(timeoutSeconds = 30) {
    this.timeoutSeconds = timeoutSeconds;
  }

  // ==========================================================================
  // Entry Management
  // ==========================================================================

  private makeKey(localPort: number, remotePort: number, remoteHost: string): string {
    return `${localPort},${remotePort},${remoteHost}`;
  }

  register(localPort: number, remotePort: number, remoteHost: string, username: string): void {
    const key = this.makeKey(localPort, remotePort, remoteHost);
    const sanitized = sanitizeUsername(username);
    this.entries.set(key, { username: sanitized, createdAt: Date.now() });
    console.info(`[identd] Registered ${key} → ${sanitized}`);
  }

  unregister(localPort: number, remotePort: number, remoteHost: string): void {
    const key = this.makeKey(localPort, remotePort, remoteHost);
    this.entries.delete(key);
    console.info(`[identd] Unregistered ${key}`);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  start(port: number, host = '::'): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      server.on('error', (error) => {
        console.warn(`[identd] Server error: ${error.message}`);
        reject(error);
      });

      server.listen(port, host, () => {
        this.server = server;
        this.entryExpiryTimer = setInterval(() => this.expireEntries(), ENTRY_TTL_MS);
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
      if (this.entryExpiryTimer) {
        clearInterval(this.entryExpiryTimer);
        this.entryExpiryTimer = null;
      }
      this.server.close(() => {
        this.server = null;
        this.entries.clear();
        this.activeConnections = 0;
        console.info('[identd] Stopped');
        resolve();
      });
    });
  }

  // ==========================================================================
  // Connection Handling
  // ==========================================================================

  private handleConnection(socket: net.Socket): void {
    // Reject connections over the concurrency limit
    if (this.activeConnections >= MAX_CONCURRENT_CONNECTIONS) {
      socket.destroy();
      return;
    }

    this.activeConnections++;
    const remoteAddress = socket.remoteAddress ?? '';

    const onClose = (): void => {
      this.activeConnections--;
    };
    socket.once('close', onClose);

    socket.setTimeout(this.timeoutSeconds * 1000);
    socket.on('timeout', () => {
      socket.destroy();
    });

    let buffer = '';

    socket.on('data', (data: Buffer) => {
      buffer += data.toString('ascii');

      // Guard against oversized requests
      if (buffer.length > MAX_RECEIVE_BYTES) {
        socket.destroy();
        return;
      }

      // Look for a complete line
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd === -1) return;

      // Extract the first line (strip \r if present)
      const line = buffer.slice(0, lineEnd).replace(/\r$/, '');
      this.processQuery(socket, line, remoteAddress);
    });

    socket.on('error', () => {
      // Silently ignore client errors
    });
  }

  private processQuery(socket: net.Socket, line: string, remoteAddress: string): void {
    // Normalize remoteAddress (strip ::ffff: IPv4-mapped prefix)
    const normalizedRemote = remoteAddress.replace(/^::ffff:/, '');

    const parts = line.split(',').map((s) => s.trim());
    if (parts.length !== 2) {
      this.respond(socket, line, 'ERROR : INVALID-PORT');
      return;
    }

    // RFC 1413: query is "portOnServer, portOnClient"
    // portOnServer = our local port (gateway's ephemeral port to IRC)
    // portOnClient = the IRC server's port (remote port from our perspective)
    const localPort = Number.parseInt(parts[0], 10);
    const remotePort = Number.parseInt(parts[1], 10);

    if (!this.isValidPort(localPort) || !this.isValidPort(remotePort)) {
      this.respond(socket, `${parts[0]} , ${parts[1]}`, 'ERROR : INVALID-PORT');
      return;
    }

    const portPair = `${localPort} , ${remotePort}`;

    // Try immediate lookup
    const username = this.lookup(localPort, remotePort, normalizedRemote);
    if (username) {
      this.respond(socket, portPair, `USERID : UNIX : ${username}`);
      return;
    }

    // Race condition mitigation: wait and retry once. The client may close
    // its end of the socket in the meantime — guard respond() with a
    // destroyed check so we don't write into the void and surface EPIPE.
    const retryTimer = setTimeout(() => {
      if (socket.destroyed) return;
      const retryUsername = this.lookup(localPort, remotePort, normalizedRemote);
      if (retryUsername) {
        console.info(`[identd] USER for ${this.makeKey(localPort, remotePort, normalizedRemote)}`);
        this.respond(socket, portPair, `USERID : UNIX : ${retryUsername}`);
      } else {
        console.info(`[identd] NO-USER for ${this.makeKey(localPort, remotePort, normalizedRemote)}`);
        this.respond(socket, portPair, 'ERROR : NO-USER');
      }
    }, RETRY_DELAY_MS);

    // Cancel the retry if the socket closes before it fires.
    socket.once('close', () => clearTimeout(retryTimer));
  }

  private lookup(localPort: number, remotePort: number, remoteHost: string): string | null {
    const key = this.makeKey(localPort, remotePort, remoteHost);
    const entry = this.entries.get(key);
    return entry?.username ?? null;
  }

  private isValidPort(port: number): boolean {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
  }

  /** Remove entries older than ENTRY_TTL_MS */
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
