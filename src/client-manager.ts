/**
 * Client Management for IRC Gateway
 * 
 * Handles WebSocket client connections, rate limiting, and client lifecycle
 */

import { WebSocket } from 'ws';
import { IrcClient } from './irc-client.js';
import { RATE_LIMIT_MAX_MESSAGES, RATE_LIMIT_WINDOW_MS } from './constants.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Represents a connected web client with their associated IRC connection
 */
export interface ConnectedClient {
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
    encoding: string;
  } | null;
  /** Timer for periodic WebSocket ping */
  wsPingTimer: ReturnType<typeof setInterval> | null;
  /** Timer for WebSocket pong response timeout */
  wsPongTimer: ReturnType<typeof setTimeout> | null;
  /** Timer for registration timeout (NICK/USER must be sent within this period) */
  registrationTimer: ReturnType<typeof setTimeout> | null;
  /** Whether the client has completed IRC registration (sent NICK or USER) */
  isRegistered: boolean;
  /** Timer for idle connection timeout (no meaningful IRC traffic) */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Username for identd responses */
  identUsername: string;
}

// ============================================================================
// Client Management Class
// ============================================================================

/** Counter for generating unique client IDs */
let clientIdCounter = 0;

/**
 * Client Manager
 * 
 * Manages WebSocket client connections and their lifecycle
 */
export class ClientManager {
  /** Map of connected clients by their ID */
  private connectedClients = new Map<string, ConnectedClient>();

  /** Track number of connections per IP address for rate limiting */
  private connectionsPerIp = new Map<string, number>();

  // ==========================================================================
  // Client Lifecycle
  // ==========================================================================

  /**
   * Create a new client and add it to the manager
   */
  createClient(
    webSocket: WebSocket,
    clientIp: string,
    serverConfig: { host: string; port: number; tls: boolean; encoding: string },
    identUsername: string | null
  ): ConnectedClient {
    // Generate unique client ID
    const clientId = `c${++clientIdCounter}`;

    // Resolve ident username: use provided value or generate from client ID
    const resolvedIdentUsername = identUsername ?? `simple_irc_client_webchat_${clientIdCounter}`;

    // Create client record
    const client: ConnectedClient = {
      id: clientId,
      ipAddress: clientIp,
      webSocket: webSocket,
      ircClient: null,
      messageCount: 0,
      rateLimitWindowStart: Date.now(),
      serverConfig: serverConfig,
      wsPingTimer: null,
      wsPongTimer: null,
      registrationTimer: null,
      isRegistered: false,
      idleTimer: null,
      identUsername: resolvedIdentUsername,
    };

    // Track the client
    this.connectedClients.set(clientId, client);
    this.incrementIpConnectionCount(clientIp);

    console.log(
      `[${clientId}] Client connected from ${clientIp}, target: ${serverConfig.host}:${serverConfig.port} ` +
      `(${this.connectedClients.size} total clients)`
    );

    return client;
  }

  /**
   * Remove a client from the manager
   */
  removeClient(client: ConnectedClient): void {
    // Stop all timers
    this.stopWsPing(client);
    this.clearRegistrationTimeout(client);
    this.clearIdleTimeout(client);

    // Remove client from tracking
    this.connectedClients.delete(client.id);
    this.decrementIpConnectionCount(client.ipAddress);

    console.log(
      `[${client.id}] Client disconnected ` +
      `(${this.connectedClients.size} total clients)`
    );
  }

  /**
   * Get a client by ID
   */
  getClient(clientId: string): ConnectedClient | undefined {
    return this.connectedClients.get(clientId);
  }

  /**
   * Get all connected clients
   */
  getAllClients(): ConnectedClient[] {
    return Array.from(this.connectedClients.values());
  }

  // ==========================================================================
  // IP Connection Tracking
  // ==========================================================================

  /**
   * Increment the connection count for an IP address
   */
  incrementIpConnectionCount(ipAddress: string): void {
    const currentCount = this.connectionsPerIp.get(ipAddress) ?? 0;
    this.connectionsPerIp.set(ipAddress, currentCount + 1);
  }

  /**
   * Decrement the connection count for an IP address
   */
  decrementIpConnectionCount(ipAddress: string): void {
    const currentCount = this.connectionsPerIp.get(ipAddress) ?? 1;
    const newCount = currentCount - 1;

    if (newCount <= 0) {
      this.connectionsPerIp.delete(ipAddress);
    } else {
      this.connectionsPerIp.set(ipAddress, newCount);
    }
  }

  /**
   * Get the current connection count for an IP address
   */
  getIpConnectionCount(ipAddress: string): number {
    return this.connectionsPerIp.get(ipAddress) ?? 0;
  }

  // ==========================================================================
  // Message Handling
  // ==========================================================================

  /**
   * Handle incoming message from a web client with rate limiting
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  handleClientMessage(client: ConnectedClient, _rawMessage: string): boolean {
    // Per-connection rate limiting (sliding window)
    const now = Date.now();
    if (now - client.rateLimitWindowStart >= RATE_LIMIT_WINDOW_MS) {
      client.messageCount = 0;
      client.rateLimitWindowStart = now;
    }
    client.messageCount++;
    if (client.messageCount > RATE_LIMIT_MAX_MESSAGES) {
      console.warn(`[${client.id}] Rate limit exceeded, dropping message`);
      return false;
    }

    return true;
  }

  /**
   * Check if a client is registered (has sent NICK/USER)
   */
  checkRegistration(client: ConnectedClient, line: string): boolean {
    if (!client.isRegistered) {
      const command = line.split(' ')[0]?.toUpperCase();
      if (command === 'NICK' || command === 'USER') {
        this.completeRegistration(client);
        return true;
      }
    }
    return false;
  }

  // ==========================================================================
  // Registration Timeout
  // ==========================================================================

  /**
   * Start registration timeout. If the client doesn't send NICK or USER
   * within the configured window, the connection is terminated.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  startRegistrationTimeout(client: ConnectedClient, timeoutSeconds: number, _quitMessage: string): void {
    if (timeoutSeconds <= 0) return;

    client.registrationTimer = setTimeout(() => {
      if (!client.isRegistered) {
        console.info(`[${client.id}] Registration timeout, no NICK/USER received`);
        this.sendRawToClient(client.webSocket, 'ERROR :Registration timeout');
        client.webSocket.close();
      }
    }, timeoutSeconds * 1000);
  }

  /**
   * Clear the registration timeout (called when NICK/USER is received)
   */
  clearRegistrationTimeout(client: ConnectedClient): void {
    if (client.registrationTimer !== null) {
      clearTimeout(client.registrationTimer);
      client.registrationTimer = null;
    }
  }

  /**
   * Mark the client as registered and clear the registration timeout
   */
  completeRegistration(client: ConnectedClient): void {
    client.isRegistered = true;
    this.clearRegistrationTimeout(client);
  }

  // ==========================================================================
  // Idle Timeout
  // ==========================================================================

  /**
   * Reset the idle timeout. Called on meaningful IRC traffic (not PING/PONG).
   * If no meaningful traffic occurs within the configured window, the
   * connection is terminated.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  resetIdleTimeout(client: ConnectedClient, timeoutSeconds: number, _quitMessage: string): void {
    if (timeoutSeconds <= 0) return;

    this.clearIdleTimeout(client);

    client.idleTimer = setTimeout(() => {
      console.info(`[${client.id}] Idle timeout, no IRC traffic for ${timeoutSeconds}s`);
      this.sendRawToClient(client.webSocket, `ERROR :Idle timeout (${timeoutSeconds}s)`);
      client.webSocket.close();
    }, timeoutSeconds * 1000);
  }

  /**
   * Clear the idle timeout
   */
  clearIdleTimeout(client: ConnectedClient): void {
    if (client.idleTimer !== null) {
      clearTimeout(client.idleTimer);
      client.idleTimer = null;
    }
  }

  // ==========================================================================
  // WebSocket Keepalive (Ping/Pong)
  // ==========================================================================

  /**
   * Start periodic WebSocket pings for a client.
   * If the client doesn't respond with a pong within the timeout,
   * the connection is terminated to free resources.
   */
  startWsPing(client: ConnectedClient, intervalSeconds: number, timeoutSeconds: number): void {
    const intervalMs = intervalSeconds * 1000;
    const timeoutMs = timeoutSeconds * 1000;

    client.wsPingTimer = setInterval(() => {
      if (client.webSocket.readyState !== WebSocket.OPEN) {
        this.stopWsPing(client);
        return;
      }

      // Skip ping if still waiting for a pong from the previous one
      if (client.wsPongTimer !== null) return;

      client.webSocket.ping();

      client.wsPongTimer = setTimeout(() => {
        console.info(`[${client.id}] WebSocket pong timeout, terminating connection`);
        client.webSocket.terminate();
      }, timeoutMs);
    }, intervalMs);
  }

  /**
   * Clear the pong response timeout (called when pong is received)
   */
  clearWsPongTimer(client: ConnectedClient): void {
    if (client.wsPongTimer !== null) {
      clearTimeout(client.wsPongTimer);
      client.wsPongTimer = null;
    }
  }

  /**
   * Stop all WebSocket keepalive timers for a client
   */
  stopWsPing(client: ConnectedClient): void {
    if (client.wsPingTimer !== null) {
      clearInterval(client.wsPingTimer);
      client.wsPingTimer = null;
    }
    this.clearWsPongTimer(client);
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Send a raw IRC line to a web client via WebSocket
   */
  sendRawToClient(webSocket: WebSocket, line: string): void {
    if (webSocket.readyState === WebSocket.OPEN) {
      webSocket.send(line);
    }
  }
}