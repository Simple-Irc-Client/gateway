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

import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { getConfig } from './config.js';
import { IdentdServer } from './identd.js';
import { ClientManager } from './client-manager.js';
import { ConnectionHandler } from './connection-handler.js';

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
   * Stop the gateway server and disconnect all clients
   */
  stop(): void {
    const config = getConfig();

    // Disconnect all clients
    for (const client of this.clientManager.getAllClients()) {
      if (client.ircClient) {
        client.ircClient.quit(config.quitMessage);
      }
      client.webSocket.close();
    }

    // Stop identd server
    if (this.identdServer) {
      this.identdServer.stop();
      this.identdServer = null;
    }

    // Close servers
    this.webSocketServer.close();
    this.httpServer.close();

    console.log('Gateway stopped');
  }
}