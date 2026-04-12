/**
 * WebSocket Gateway for Simple IRC Client
 *
 * This gateway acts as a bridge between web browsers and IRC servers.
 * Web clients connect via WebSocket using direct IRC protocol (raw IRC lines).
 *
 * Architecture:
 * [Browser] <--WebSocket (raw IRC)--> [Gateway] <--TCP/TLS--> [IRC Server]
 *
 * Connection URL format:
 * ws://gateway:port/webirc?host=irc.example.com&port=6697&tls=true&encoding=utf8
 *
 * Required query parameters:
 * - host: IRC server hostname
 * - port: IRC server port
 *
 * Optional query parameters:
 * - tls: Use TLS (true/false, default: false)
 * - encoding: Character encoding (default: utf8)
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { getConfig } from './config.js';
import { IdentdServer } from './identd.js';
import { ClientManager } from './client-manager.js';
import { ConnectionHandler } from './connection-handler.js';

/** Maximum time to wait for in-flight sockets to drain during shutdown */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5000;

// ============================================================================
// Gateway Class
// ============================================================================

/**
 * WebSocket Gateway Server
 *
 * Manages WebSocket connections from web clients and creates IRC connections
 * to servers on their behalf. Uses direct IRC protocol (raw IRC lines) instead
 * of JSON wrapping.
 */
export class Gateway {
  /** HTTP server for handling WebSocket upgrades */
  private httpServer = createServer((_request, response) => {
    response.end('Simple IRC Client Gateway');
  });

  /** WebSocket server instance */
  private webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  /** Client manager for tracking connected clients */
  private clientManager = new ClientManager();

  /** Connection handler for WebSocket upgrades */
  private connectionHandler: ConnectionHandler;

  /** Identd server for responding to IRC ident queries */
  private identdServer: IdentdServer | null = null;

  constructor() {
    this.connectionHandler = new ConnectionHandler(this.webSocketServer, this.clientManager);

    // Handle WebSocket upgrade requests
    this.httpServer.on('upgrade', (request, socket, head) => {
      this.connectionHandler.handleWebSocketUpgrade(request, socket, head);
    });

    // Surface listen errors (EADDRINUSE, EACCES, etc.) — without this, a
    // failed bind resolves silently and the process looks healthy.
    this.httpServer.on('error', (error: NodeJS.ErrnoException) => {
      console.error(`[gateway] HTTP server error${error.code ? ` (${error.code})` : ''}: ${error.message}`);
    });
  }

  // ==========================================================================
  // Server Lifecycle
  // ==========================================================================

  /**
   * Start the gateway server
   */
  start(): void {
    const config = getConfig();

    // Start identd server if enabled
    if (config.identdEnabled) {
      this.identdServer = new IdentdServer(config.identdTimeout);
      this.identdServer.start(config.identdPort).catch((error) => {
        console.warn(`[identd] Failed to start: ${(error as Error).message}`);
        this.identdServer = null;
      });

      // Set identd server in connection handler
      this.connectionHandler.setIdentdServer(this.identdServer);
    }

    this.httpServer.listen(config.port, config.host, () => {
      console.log(`Gateway started on ${config.host}:${config.port}${config.path}`);
    });
  }

  /**
   * Stop the gateway server and disconnect all clients.
   *
   * Resolves after HTTP + WebSocket servers have closed. Clients are given
   * a short drain window to flush in-flight sends (IRC ERROR, QUIT acks)
   * before being forcibly terminated.
   */
  async stop(): Promise<void> {
    const config = getConfig();

    // Send QUIT to IRC and begin WebSocket close handshake for every client.
    const clients = this.clientManager.getAllClients();
    for (const client of clients) {
      if (client.ircClient) {
        client.ircClient.quit(config.quitMessage);
      }
      if (client.webSocket.readyState === WebSocket.OPEN) {
        client.webSocket.close();
      }
    }

    // Wait for clients to finish closing, with a hard timeout fallback.
    // Without this, the WebSocketServer.close() call below can hang if any
    // client has buffered data that hasn't flushed yet.
    await this.waitForClientsToClose(clients, SHUTDOWN_DRAIN_TIMEOUT_MS);

    // Stop identd server
    if (this.identdServer) {
      await this.identdServer.stop();
      this.identdServer = null;
    }

    // Close servers
    await new Promise<void>((resolve) => {
      this.webSocketServer.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
    });

    console.log('Gateway stopped');
  }

  /**
   * Wait for all provided clients' WebSockets to reach CLOSED state, or
   * force-terminate any that miss the deadline. Returning without force-closing
   * stragglers is worse: httpServer.close() hangs forever waiting for them.
   */
  private waitForClientsToClose(
    clients: ReturnType<ClientManager['getAllClients']>,
    timeoutMs: number
  ): Promise<void> {
    return new Promise((resolve) => {
      const outstanding = clients.filter(
        (c) => c.webSocket.readyState !== WebSocket.CLOSED
      );
      if (outstanding.length === 0) {
        resolve();
        return;
      }

      let remaining = outstanding.length;
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      for (const client of outstanding) {
        client.webSocket.once('close', () => {
          remaining--;
          if (remaining === 0) done();
        });
      }

      const timer = setTimeout(() => {
        // Deadline hit — force-terminate anything still open so close() below doesn't hang.
        for (const client of outstanding) {
          if (client.webSocket.readyState !== WebSocket.CLOSED) {
            client.webSocket.terminate();
          }
        }
        done();
      }, timeoutMs);
    });
  }
}