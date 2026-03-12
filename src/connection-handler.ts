/**
 * Connection Handling for IRC Gateway
 * 
 * Manages WebSocket upgrades, validation, and connection establishment
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Duplex } from 'node:stream';
import { IncomingMessage } from 'node:http';
import { getConfig } from './config.js';
import { IrcClient } from './irc-client.js';
import { IdentdServer } from './identd.js';
import { ConnectedClient, ClientManager } from './client-manager.js';
import { isPrivateHost } from './security.js';
import { ALLOWED_ENCODINGS } from './constants.js';

// ============================================================================
// Connection Handler Class
// ============================================================================

/**
 * Connection Handler
 * 
 * Handles WebSocket upgrade requests and connection establishment
 */
export class ConnectionHandler {
  /** WebSocket server instance */
  private webSocketServer: WebSocketServer;

  /** Client manager for tracking connected clients */
  private clientManager: ClientManager;

  /** Identd server for responding to IRC ident queries */
  private identdServer: IdentdServer | null = null;

  constructor(webSocketServer: WebSocketServer, clientManager: ClientManager) {
    this.webSocketServer = webSocketServer;
    this.clientManager = clientManager;
  }

  /**
   * Set the identd server instance
   */
  setIdentdServer(identdServer: IdentdServer | null): void {
    this.identdServer = identdServer;
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
  handleWebSocketUpgrade(
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
    const port = portStr ? Number.parseInt(portStr, 10) : null;
    const tls = requestUrl.searchParams.get('tls') === 'true';
    const encodingParam = requestUrl.searchParams.get('encoding') ?? 'utf8';
    const encoding = ALLOWED_ENCODINGS.has(encodingParam.toLowerCase()) ? encodingParam : 'utf8';

    // Enforce TLS if configured (allow override for testing)
    if (config.enforceTls && !tls && requestUrl.searchParams.get('allowInsecure') !== 'true') {
      this.rejectConnection(socket, 403, 'Forbidden - TLS required for all connections');
      return;
    }

    // Validate required parameters
    if (!host || !port || Number.isNaN(port) || port < 1 || port > 65535) {
      this.rejectConnection(socket, 400, 'Bad Request - Missing or invalid host/port');
      return;
    }

    // SSRF protection: block private/reserved IP ranges
    if (config.blockPrivateHosts && isPrivateHost(host)) {
      this.rejectConnection(socket, 403, 'Forbidden - Private hosts not allowed');
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
    const currentIpConnections = this.clientManager.getIpConnectionCount(clientIp);
    if (currentIpConnections >= config.maxConnectionsPerIp) {
      this.rejectConnection(socket, 429, 'Too Many Requests');
      return;
    }

    // Check total client limit
    if (this.clientManager.getAllClients().length >= config.maxClients) {
      this.rejectConnection(socket, 503, 'Service Unavailable');
      return;
    }

    // Parse ident username from query param (may be null, resolved in handleNewClient)
    const identUsername = requestUrl.searchParams.get('ident');

    // Accept the WebSocket connection
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.handleNewClient(webSocket, clientIp, { host, port, tls, encoding }, identUsername);
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
    serverConfig: { host: string; port: number; tls: boolean; encoding: string },
    identUsername: string | null
  ): void {
    const config = getConfig();

    // Create client via client manager
    const client = this.clientManager.createClient(webSocket, clientIp, serverConfig, identUsername);

    // Create IRC client and connect immediately
    this.connectToIrc(client, config);

    // Set up WebSocket event handlers
    webSocket.on('message', (data) => {
      this.handleClientMessage(client, data.toString());
    });

    webSocket.on('close', () => {
      this.handleClientDisconnect(client, config.quitMessage);
    });

    webSocket.on('error', (error: Error) => {
      console.warn(`[${client.id}] WebSocket error: ${error.message}`);
    });

    webSocket.on('pong', () => {
      this.clientManager.clearWsPongTimer(client);
    });

    // Start WebSocket-level keepalive pings
    this.clientManager.startWsPing(client, config.wsPingInterval, config.wsPongTimeout);

    // Start registration timeout — client must send NICK/USER within the window
    this.clientManager.startRegistrationTimeout(client, config.registrationTimeout, config.quitMessage);

    // Start idle timeout — resets on meaningful IRC traffic
    this.clientManager.resetIdleTimeout(client, config.idleTimeout, config.quitMessage);
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
      encoding: client.serverConfig.encoding,
      webirc: webircConfig,
      pongTimeout: config.pongTimeout,
    });

    console.log(`[${client.id}] Connecting to ${client.serverConfig.host}:${client.serverConfig.port}`);
  }

  /**
   * Handle client disconnection
   */
  private handleClientDisconnect(client: ConnectedClient, quitMessage: string): void {
    // Unregister identd entry and disconnect from IRC
    if (client.ircClient) {
      const meta = client.ircClient.socketMeta;
      if (meta && this.identdServer) {
        this.identdServer.unregister(meta.localPort, meta.remotePort, meta.remoteAddress);
      }
      client.ircClient.quit(quitMessage);
    }

    // Remove client from manager
    this.clientManager.removeClient(client);
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
    // Apply rate limiting
    if (!this.clientManager.handleClientMessage(client, rawMessage)) {
      return;
    }

    // Forward raw IRC command to IRC server
    if (client.ircClient) {
      // Handle multiple lines (some clients might batch)
      const lines = rawMessage.split(/[\r\n]+/).filter(line => line.length > 0);
      for (const line of lines) {
        // Check for registration commands (NICK/USER/CAP/PASS)
        this.clientManager.checkRegistration(client, line);

        // Reset idle timeout on meaningful traffic (not PING/PONG)
        const command = line.split(' ')[0]?.toUpperCase();
        if (command !== 'PING' && command !== 'PONG') {
          this.clientManager.resetIdleTimeout(client, getConfig().idleTimeout, getConfig().quitMessage);
        }

        client.ircClient.send(line);
      }
    }
  }

  /**
   * Set up event handlers for an IRC client connection
   */
  private setupIrcEventHandlers(client: ConnectedClient, ircClient: IrcClient): void {
    // Register identd entry when TCP socket connects to IRC server
    ircClient.on('socket connected', (meta: { localPort: number; localAddress: string; remotePort: number; remoteAddress: string } | null) => {
      if (meta && this.identdServer) {
        this.identdServer.register(meta.localPort, meta.remotePort, meta.remoteAddress, client.identUsername);
      }
    });

    // Raw IRC message from server - forward to client
    ircClient.on('raw', (line: string, isFromServer: boolean) => {
      if (isFromServer) {
        const direction = '>>';
        console.debug(`[${client.id}] ${direction} ${line}`);

        // Reset idle timeout on meaningful server traffic (not PING/PONG)
        const command = line.startsWith(':')
          ? line.split(' ')[1]?.toUpperCase()
          : line.split(' ')[0]?.toUpperCase();
        if (command !== 'PING' && command !== 'PONG') {
          this.clientManager.resetIdleTimeout(client, getConfig().idleTimeout, getConfig().quitMessage);
        }

        // Send raw IRC line to WebSocket client
        this.clientManager.sendRawToClient(client.webSocket, line);
      } else {
        const direction = '<<';
        console.debug(`[${client.id}] ${direction} ${line}`);
      }
    });

    // Connection closed
    ircClient.on('close', () => {
      // Unregister identd entry
      const meta = ircClient.socketMeta;
      if (meta && this.identdServer) {
        this.identdServer.unregister(meta.localPort, meta.remotePort, meta.remoteAddress);
      }

      // Close WebSocket connection when IRC connection closes
      client.webSocket.close();
    });

    // Connection error
    ircClient.on('error', (error: Error) => {
      console.warn(`[${client.id}] IRC error: ${error.message}`);
      // Send error as IRC ERROR message
      this.clientManager.sendRawToClient(client.webSocket, `ERROR :${error.message}`);
    });
  }
}