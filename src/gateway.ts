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
 * - rejectUnauthorized: Validate TLS certificates (true/false, default: true)
 * - encoding: Character encoding (default: utf8)
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Duplex } from 'stream';
import { createServer, type IncomingMessage } from 'http';
import { getConfig } from './config.js';
import { IrcClient } from './irc-client.js';
import * as logger from './logger.js';

const ALLOWED_ENCODINGS = new Set([
  'utf8', 'utf-8', 'ascii', 'latin1', 'iso-8859-1', 'iso-8859-2', 'iso-8859-3',
  'iso-8859-4', 'iso-8859-5', 'iso-8859-6', 'iso-8859-7', 'iso-8859-8',
  'iso-8859-9', 'iso-8859-10', 'iso-8859-13', 'iso-8859-14', 'iso-8859-15',
  'iso-8859-16', 'windows-1250', 'windows-1251', 'windows-1252', 'windows-1253',
  'windows-1254', 'windows-1255', 'windows-1256', 'windows-1257', 'windows-1258',
  'koi8-r', 'koi8-u', 'shift_jis', 'euc-jp', 'euc-kr', 'gb2312', 'gbk', 'gb18030',
  'big5', 'tis-620',
]);

// ============================================================================
// Types
// ============================================================================

/**
 * Represents a connected web client with their associated IRC connection
 */
/** Maximum WebSocket messages allowed per rate limit window */
const RATE_LIMIT_MAX_MESSAGES = 50;

/** Rate limit window duration in milliseconds (5 seconds) */
const RATE_LIMIT_WINDOW_MS = 5000;

interface ConnectedClient {
  /** Unique identifier for this client (e.g., "c1", "c2") */
  id: string;
  /** Client's IP address (may be from X-Forwarded-For header) */
  ipAddress: string;
  /** WebSocket connection to the browser */
  webSocket: WebSocket;
  /** IRC connection to the server (null if not connected to IRC) */
  ircClient: IrcClient | null;
  /** Message count in the current rate limit window */
  messageCount: number;
  /** Timestamp when the current rate limit window started */
  rateLimitWindowStart: number;
  /** Server configuration from query parameters */
  serverConfig: {
    host: string;
    port: number;
    tls: boolean;
    rejectUnauthorized: boolean;
    encoding: string;
  } | null;
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
 * to servers on their behalf. Uses direct IRC protocol (raw IRC lines) instead
 * of JSON wrapping.
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
   * Validates the request path, parses server configuration from query params,
   * checks rate limits, and establishes the WebSocket connection if all checks pass.
   */
  private handleWebSocketUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void {
    const config = getConfig();

    // Parse the request URL to get the path and query parameters
    const requestUrl = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? 'localhost'}`
    );
    const requestPath = requestUrl.pathname;

    // Get client IP address — only trust X-Forwarded-For when behind a configured proxy
    const clientIp = (() => {
      if (config.trustProxy) {
        const forwardedFor = request.headers['x-forwarded-for']?.toString();
        if (forwardedFor) {
          return forwardedFor.split(',')[0].trim();
        }
      }
      return request.socket.remoteAddress ?? '127.0.0.1';
    })();

    // Validate request path
    if (requestPath !== config.path) {
      this.rejectConnection(socket, 404, 'Not Found');
      return;
    }

    // Validate Origin header against allowlist (if configured)
    if (config.allowedOrigins?.length) {
      const origin = request.headers.origin;
      if (!origin || !config.allowedOrigins.includes(origin)) {
        this.rejectConnection(socket, 403, 'Forbidden - Origin not allowed');
        return;
      }
    }

    // Parse server configuration from query parameters
    const host = requestUrl.searchParams.get('host');
    const portStr = requestUrl.searchParams.get('port');
    const port = portStr ? parseInt(portStr, 10) : null;
    const tls = requestUrl.searchParams.get('tls') === 'true';
    const rejectUnauthorized = requestUrl.searchParams.get('rejectUnauthorized') !== 'false';
    const encodingParam = requestUrl.searchParams.get('encoding') ?? 'utf8';
    const encoding = ALLOWED_ENCODINGS.has(encodingParam.toLowerCase()) ? encodingParam : 'utf8';

    // Validate required parameters
    if (!host || !port || isNaN(port) || port < 1 || port > 65535) {
      this.rejectConnection(socket, 400, 'Bad Request - Missing or invalid host/port');
      return;
    }

    // Check if server is in allowed list (if configured)
    if (config.allowedServers?.length) {
      const serverAddress = `${host}:${port}`;
      if (!config.allowedServers.includes(serverAddress)) {
        this.rejectConnection(socket, 403, 'Forbidden - Server not allowed');
        return;
      }
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
      this.handleNewClient(webSocket, clientIp, { host, port, tls, rejectUnauthorized, encoding });
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
  private handleNewClient(
    webSocket: WebSocket,
    clientIp: string,
    serverConfig: { host: string; port: number; tls: boolean; rejectUnauthorized: boolean; encoding: string }
  ): void {
    const config = getConfig();

    // Generate unique client ID
    const clientId = `c${++clientIdCounter}`;

    // Create client record
    const client: ConnectedClient = {
      id: clientId,
      ipAddress: clientIp,
      webSocket: webSocket,
      ircClient: null,
      messageCount: 0,
      rateLimitWindowStart: Date.now(),
      serverConfig: serverConfig,
    };

    // Track the client
    this.connectedClients.set(clientId, client);
    this.incrementIpConnectionCount(clientIp);

    logger.info(
      `[${clientId}] Client connected from ${clientIp}, target: ${serverConfig.host}:${serverConfig.port} ` +
      `(${this.connectedClients.size} total clients)`
    );

    // Create IRC client and connect immediately
    this.connectToIrc(client, config);

    // Set up WebSocket event handlers
    webSocket.on('message', (data) => {
      this.handleClientMessage(client, data.toString());
    });

    webSocket.on('close', () => {
      this.handleClientDisconnect(client, config.quitMessage);
    });
  }

  /**
   * Connect to IRC server for a client
   */
  private connectToIrc(client: ConnectedClient, config: ReturnType<typeof getConfig>): void {
    if (!client.serverConfig) return;

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

    // Connect to IRC server (but don't send NICK/USER - client will do that)
    ircClient.connectRaw({
      host: client.serverConfig.host,
      port: client.serverConfig.port,
      tls: client.serverConfig.tls,
      rejectUnauthorized: client.serverConfig.rejectUnauthorized,
      encoding: client.serverConfig.encoding,
      webirc: webircConfig,
    });

    logger.info(`[${client.id}] Connecting to ${client.serverConfig.host}:${client.serverConfig.port}`);
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
   * Messages are raw IRC commands (e.g., "NICK user", "PRIVMSG #channel :hello")
   * which are forwarded directly to the IRC server.
   */
  private handleClientMessage(client: ConnectedClient, rawMessage: string): void {
    // Per-connection rate limiting (sliding window)
    const now = Date.now();
    if (now - client.rateLimitWindowStart > RATE_LIMIT_WINDOW_MS) {
      client.messageCount = 0;
      client.rateLimitWindowStart = now;
    }
    client.messageCount++;
    if (client.messageCount > RATE_LIMIT_MAX_MESSAGES) {
      logger.warn(`[${client.id}] Rate limit exceeded, dropping message`);
      return;
    }

    // Forward raw IRC command to IRC server
    if (client.ircClient) {
      // Handle multiple lines (some clients might batch)
      const lines = rawMessage.split(/\r?\n/).filter(line => line.length > 0);
      for (const line of lines) {
        client.ircClient.send(line);
      }
    }
  }

  /**
   * Set up event handlers for an IRC client connection
   */
  private setupIrcEventHandlers(client: ConnectedClient, ircClient: IrcClient): void {
    // Raw IRC message from server - forward to client
    ircClient.on('raw', (line: string, isFromServer: boolean) => {
      if (isFromServer) {
        const direction = '>>';
        logger.debug(`[${client.id}] ${direction} ${line}`);

        // Send raw IRC line to WebSocket client
        this.sendRawToClient(client.webSocket, line);
      } else {
        const direction = '<<';
        logger.debug(`[${client.id}] ${direction} ${line}`);
      }
    });

    // Connection closed
    ircClient.on('close', () => {
      // Close WebSocket connection when IRC connection closes
      client.webSocket.close();
    });

    // Connection error
    ircClient.on('error', (error: Error) => {
      logger.warn(`[${client.id}] IRC error: ${error.message}`);
      // Send error as IRC ERROR message
      this.sendRawToClient(client.webSocket, `ERROR :${error.message}`);
    });
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Send a raw IRC line to a web client via WebSocket
   */
  private sendRawToClient(webSocket: WebSocket, line: string): void {
    if (webSocket.readyState === WebSocket.OPEN) {
      webSocket.send(line);
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
