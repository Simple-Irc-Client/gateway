/**
 * WebSocket Gateway for Simple IRC Client
 *
 * This gateway acts as a bridge between web browsers and IRC servers.
 * Web clients connect via WebSocket, and the gateway manages TCP/TLS
 * connections to IRC servers on their behalf.
 *
 * Architecture:
 * [Browser] <--WebSocket--> [Gateway] <--TCP/TLS--> [IRC Server]
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Duplex } from 'stream';
import { createServer, type IncomingMessage } from 'http';
import { getConfig } from './config.js';
import { IrcClient } from './irc-client.js';
import * as logger from './logger.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Represents a connected web client with their associated IRC connection
 */
interface ConnectedClient {
  /** Unique identifier for this client (e.g., "c1", "c2") */
  id: string;
  /** Client's IP address (may be from X-Forwarded-For header) */
  ipAddress: string;
  /** WebSocket connection to the browser */
  webSocket: WebSocket;
  /** IRC connection to the server (null if not connected to IRC) */
  ircClient: IrcClient | null;
}

/**
 * Message format received from the web client
 */
interface ClientMessage {
  event?: string;
  data?: {
    type?: string;
    event?: {
      nick?: string;
      username?: string;
      realname?: string;
      password?: string;
      quitReason?: string;
      rawData?: string;
      server?: {
        host?: string;
        port?: number;
        tls?: boolean;
        encoding?: string;
      };
    };
  };
}

// ============================================================================
// Gateway Class
// ============================================================================

/** Counter for generating unique client IDs */
let clientIdCounter = 0;

/**
 * WebSocket Gateway Server
 *
 * Manages WebSocket connections from web clients and creates IRC connections
 * to servers on their behalf. Handles rate limiting, connection management,
 * and message routing between clients and IRC servers.
 */
export class Gateway {
  /** HTTP server for handling WebSocket upgrades */
  private httpServer = createServer((_request, response) => {
    response.end('Simple IRC Client Gateway');
  });

  /** WebSocket server instance */
  private webSocketServer = new WebSocketServer({ noServer: true });

  /** Map of connected clients by their ID */
  private connectedClients = new Map<string, ConnectedClient>();

  /** Track number of connections per IP address for rate limiting */
  private connectionsPerIp = new Map<string, number>();

  constructor() {
    // Handle WebSocket upgrade requests
    this.httpServer.on('upgrade', (request, socket, head) => {
      this.handleWebSocketUpgrade(request, socket, head);
    });
  }

  // ==========================================================================
  // Connection Handling
  // ==========================================================================

  /**
   * Handle incoming WebSocket upgrade requests
   *
   * Validates the request path, checks rate limits, and establishes
   * the WebSocket connection if all checks pass.
   */
  private handleWebSocketUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void {
    const config = getConfig();

    // Parse the request URL to get the path
    const requestUrl = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? 'localhost'}`
    );
    const requestPath = requestUrl.pathname;

    // Get client IP address (check X-Forwarded-For for reverse proxy setups)
    const forwardedFor = request.headers['x-forwarded-for']?.toString();
    const clientIp = (
      forwardedFor?.split(',')[0] ??
      request.socket.remoteAddress ??
      '127.0.0.1'
    ).trim();

    // Validate request path
    if (requestPath !== config.path) {
      this.rejectConnection(socket, 404, 'Not Found');
      return;
    }

    // Check per-IP connection limit
    const currentIpConnections = this.connectionsPerIp.get(clientIp) ?? 0;
    if (currentIpConnections >= config.maxConnectionsPerIp) {
      this.rejectConnection(socket, 429, 'Too Many Requests');
      return;
    }

    // Check total client limit
    if (this.connectedClients.size >= config.maxClients) {
      this.rejectConnection(socket, 503, 'Service Unavailable');
      return;
    }

    // Accept the WebSocket connection
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.handleNewClient(webSocket, clientIp);
    });
  }

  /**
   * Reject a WebSocket upgrade with an HTTP error response
   */
  private rejectConnection(socket: Duplex, statusCode: number, message: string): void {
    socket.write(`HTTP/1.1 ${statusCode} ${message}\r\n\r\n`);
    socket.destroy();
  }

  /**
   * Handle a newly connected WebSocket client
   */
  private handleNewClient(webSocket: WebSocket, clientIp: string): void {
    const config = getConfig();

    // Generate unique client ID
    const clientId = `c${++clientIdCounter}`;

    // Create client record
    const client: ConnectedClient = {
      id: clientId,
      ipAddress: clientIp,
      webSocket: webSocket,
      ircClient: null,
    };

    // Track the client
    this.connectedClients.set(clientId, client);
    this.incrementIpConnectionCount(clientIp);

    logger.info(
      `[${clientId}] Client connected from ${clientIp} ` +
      `(${this.connectedClients.size} total clients)`
    );

    // Set up WebSocket event handlers
    webSocket.on('message', (data) => {
      this.handleClientMessage(client, data.toString());
    });

    webSocket.on('close', () => {
      this.handleClientDisconnect(client, config.quitMessage);
    });
  }

  /**
   * Handle client disconnection
   */
  private handleClientDisconnect(client: ConnectedClient, quitMessage: string): void {
    // Disconnect from IRC if connected
    if (client.ircClient) {
      client.ircClient.quit(quitMessage);
    }

    // Remove client from tracking
    this.connectedClients.delete(client.id);
    this.decrementIpConnectionCount(client.ipAddress);

    logger.info(
      `[${client.id}] Client disconnected ` +
      `(${this.connectedClients.size} total clients)`
    );
  }

  // ==========================================================================
  // IP Connection Tracking
  // ==========================================================================

  /**
   * Increment the connection count for an IP address
   */
  private incrementIpConnectionCount(ipAddress: string): void {
    const currentCount = this.connectionsPerIp.get(ipAddress) ?? 0;
    this.connectionsPerIp.set(ipAddress, currentCount + 1);
  }

  /**
   * Decrement the connection count for an IP address
   */
  private decrementIpConnectionCount(ipAddress: string): void {
    const currentCount = this.connectionsPerIp.get(ipAddress) ?? 1;
    const newCount = currentCount - 1;

    if (newCount <= 0) {
      this.connectionsPerIp.delete(ipAddress);
    } else {
      this.connectionsPerIp.set(ipAddress, newCount);
    }
  }

  // ==========================================================================
  // Message Handling
  // ==========================================================================

  /**
   * Handle incoming message from a web client
   *
   * Parses the message and routes it to the appropriate handler based on type:
   * - connect: Establish IRC connection
   * - disconnect: Close IRC connection
   * - raw: Send raw IRC command
   */
  private handleClientMessage(client: ConnectedClient, rawMessage: string): void {
    const config = getConfig();

    // Parse the JSON message
    let message: ClientMessage;
    try {
      message = JSON.parse(rawMessage) as ClientMessage;
    } catch {
      // Invalid JSON, ignore the message
      return;
    }

    // Validate message format
    if (message.event !== 'sic-client-event' || !message.data) {
      return;
    }

    const messageType = message.data.type;
    const eventData = message.data.event ?? {};
    const serverData = eventData.server ?? {};

    // Route message to appropriate handler
    switch (messageType) {
      case 'disconnect':
        this.handleDisconnectCommand(client, eventData.quitReason, config.quitMessage);
        break;

      case 'raw':
        this.handleRawCommand(client, eventData.rawData);
        break;

      case 'connect':
        this.handleConnectCommand(client, eventData, serverData, config);
        break;
    }
  }

  /**
   * Handle disconnect command from client
   */
  private handleDisconnectCommand(
    client: ConnectedClient,
    quitReason: string | undefined,
    defaultQuitMessage: string
  ): void {
    if (client.ircClient) {
      client.ircClient.quit(quitReason ?? defaultQuitMessage);
      client.ircClient = null;
    }
  }

  /**
   * Handle raw IRC command from client
   */
  private handleRawCommand(client: ConnectedClient, rawData: string | undefined): void {
    if (rawData && client.ircClient) {
      client.ircClient.send(rawData);
    }
  }

  /**
   * Handle connect command from client
   *
   * Creates a new IRC connection to the specified server
   */
  private handleConnectCommand(
    client: ConnectedClient,
    eventData: NonNullable<ClientMessage['data']>['event'],
    serverData: NonNullable<NonNullable<ClientMessage['data']>['event']>['server'],
    config: ReturnType<typeof getConfig>
  ): void {
    // Validate required fields
    const host = serverData?.host;
    const port = serverData?.port;
    const nick = eventData?.nick;

    if (!host || !port || !nick) {
      return;
    }

    // Check if server is in allowed list (if configured)
    if (config.allowedServers?.length) {
      const serverAddress = `${host}:${port}`;
      if (!config.allowedServers.includes(serverAddress)) {
        this.sendToClient(client.webSocket, 'sic-gateway-event', {
          type: 'error',
          message: 'Server not allowed',
        });
        return;
      }
    }

    // Destroy existing IRC connection if any
    if (client.ircClient) {
      client.ircClient.destroy();
    }

    // Create new IRC client
    const ircClient = new IrcClient();
    client.ircClient = ircClient;

    // Set up IRC event handlers
    this.setupIrcEventHandlers(client, ircClient);

    // Build WEBIRC configuration if password is set
    const webircConfig = config.webircPassword
      ? {
          password: config.webircPassword,
          gateway: config.webircGateway ?? 'gateway',
          hostname: `${client.ipAddress}.web`,
          ip: client.ipAddress,
        }
      : undefined;

    // Connect to IRC server
    ircClient.connect({
      host,
      port,
      nick,
      username: eventData?.username,
      realname: eventData?.realname ?? config.realname,
      password: eventData?.password,
      tls: serverData?.tls,
      encoding: serverData?.encoding,
      webirc: webircConfig,
    });

    logger.info(`[${client.id}] Connecting to ${host}:${port} as ${nick}`);
  }

  /**
   * Set up event handlers for an IRC client connection
   */
  private setupIrcEventHandlers(client: ConnectedClient, ircClient: IrcClient): void {
    // Socket connected (TCP/TLS handshake complete)
    ircClient.on('socket_connected', () => {
      this.sendToClient(client.webSocket, 'sic-irc-event', {
        type: 'socket_connected',
      });
    });

    // IRC registration complete (received 001)
    ircClient.on('connected', () => {
      this.sendToClient(client.webSocket, 'sic-irc-event', {
        type: 'connected',
      });
    });

    // Connection closed
    ircClient.on('close', () => {
      this.sendToClient(client.webSocket, 'sic-irc-event', {
        type: 'close',
      });
    });

    // Connection error
    ircClient.on('error', (error: Error) => {
      this.sendToClient(client.webSocket, 'sic-irc-event', {
        type: 'error',
        error: error.message,
      });
    });

    // Raw IRC message (both incoming and outgoing)
    ircClient.on('raw', (line: string, isFromServer: boolean) => {
      const direction = isFromServer ? '>>' : '<<';
      logger.debug(`[${client.id}] ${direction} ${line}`);

      const eventType = isFromServer ? 'sic-irc-event' : 'sic-server-event';
      this.sendToClient(client.webSocket, eventType, {
        type: 'raw',
        line,
      });
    });
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Send a message to a web client via WebSocket
   */
  private sendToClient(
    webSocket: WebSocket,
    event: string,
    data: Record<string, unknown>
  ): void {
    if (webSocket.readyState === WebSocket.OPEN) {
      const message = JSON.stringify({ event, data });
      webSocket.send(message);
    }
  }

  // ==========================================================================
  // Server Lifecycle
  // ==========================================================================

  /**
   * Start the gateway server
   */
  start(): void {
    const config = getConfig();
    this.httpServer.listen(config.port, config.host, () => {
      logger.success(`Gateway started on ${config.host}:${config.port}${config.path}`);
    });
  }

  /**
   * Stop the gateway server and disconnect all clients
   */
  stop(): void {
    const config = getConfig();

    // Disconnect all clients
    for (const client of this.connectedClients.values()) {
      if (client.ircClient) {
        client.ircClient.quit(config.quitMessage);
      }
      client.webSocket.close();
    }

    // Clear tracking maps
    this.connectedClients.clear();
    this.connectionsPerIp.clear();

    // Close servers
    this.webSocketServer.close();
    this.httpServer.close();

    logger.info('Gateway stopped');
  }
}
