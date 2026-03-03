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

import * as net from 'net';
import * as logger from './logger.js';

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
  private entries = new Map<string, string>();
  private timeoutSeconds: number;

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
    this.entries.set(key, sanitized);
    logger.debug(`[identd] Registered ${key} → ${sanitized}`);
  }

  unregister(localPort: number, remotePort: number, remoteHost: string): void {
    const key = this.makeKey(localPort, remotePort, remoteHost);
    this.entries.delete(key);
    logger.debug(`[identd] Unregistered ${key}`);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  start(port: number, host = '0.0.0.0'): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      server.on('error', (error) => {
        logger.warn(`[identd] Server error: ${error.message}`);
        reject(error);
      });

      server.listen(port, host, () => {
        this.server = server;
        logger.success(`[identd] Listening on ${host}:${port}`);
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
      this.server.close(() => {
        this.server = null;
        this.entries.clear();
        logger.info('[identd] Stopped');
        resolve();
      });
    });
  }

  // ==========================================================================
  // Connection Handling
  // ==========================================================================

  private handleConnection(socket: net.Socket): void {
    const remoteAddress = socket.remoteAddress ?? '';

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
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length !== 2) {
      this.respond(socket, line, 'ERROR : INVALID-PORT');
      return;
    }

    const serverPort = parseInt(parts[0], 10);
    const clientPort = parseInt(parts[1], 10);

    if (!this.isValidPort(serverPort) || !this.isValidPort(clientPort)) {
      this.respond(socket, `${parts[0]} , ${parts[1]}`, 'ERROR : INVALID-PORT');
      return;
    }

    const portPair = `${serverPort} , ${clientPort}`;

    // Normalize remoteAddress for lookup (strip ::ffff: IPv4-mapped prefix)
    const normalizedRemote = remoteAddress.replace(/^::ffff:/, '');

    // Try immediate lookup
    const lookupKey = this.makeKey(clientPort, serverPort, normalizedRemote);
    logger.debug(`[identd] Query from ${normalizedRemote}: ${serverPort},${clientPort} (key: ${lookupKey})`);
    logger.debug(`[identd] Current entries: ${[...this.entries.keys()].join(', ') || '(empty)'}`);
    const username = this.lookup(clientPort, serverPort, normalizedRemote);
    if (username) {
      this.respond(socket, portPair, `USERID : UNIX : ${username}`);
      return;
    }

    // Race condition mitigation: wait and retry once
    setTimeout(() => {
      const retryUsername = this.lookup(clientPort, serverPort, normalizedRemote);
      if (retryUsername) {
        this.respond(socket, portPair, `USERID : UNIX : ${retryUsername}`);
      } else {
        logger.debug(`[identd] NO-USER for key ${lookupKey}, entries: ${[...this.entries.keys()].join(', ') || '(empty)'}`);
        this.respond(socket, portPair, 'ERROR : NO-USER');
      }
    }, RETRY_DELAY_MS);
  }

  private lookup(localPort: number, remotePort: number, remoteHost: string): string | null {
    const key = this.makeKey(localPort, remotePort, remoteHost);
    return this.entries.get(key) ?? null;
  }

  private isValidPort(port: number): boolean {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
  }

  private respond(socket: net.Socket, portPair: string, response: string): void {
    if (socket.writable) {
      socket.end(`${portPair} : ${response}\r\n`);
    }
  }
}
