import { WebSocket } from 'ws';
import { IrcClient, ircCommand } from './irc-client.js';

export const RATE_LIMIT_MAX_MESSAGES = 50;
export const RATE_LIMIT_WINDOW_MS = 5000;

// Above this many buffered bytes the browser counts as falling behind
const WS_BUFFER_HIGH_WATER_MARK = 1024 * 1024;

export interface ServerConfig {
  host: string;
  port: number;
  tls: boolean;
  encoding: string;
}

/** A browser and its IRC connection. */
export interface ConnectedClient {
  /** "c1", "c2", ... for log lines */
  id: string;
  ipAddress: string;
  webSocket: WebSocket;
  ircClient: IrcClient;
  serverConfig: ServerConfig;
  identUsername: string;
  /** Lines in the current rate-limit window */
  messageCount: number;
  rateLimitWindowStart: number;
  /** Set once the browser sends NICK or USER */
  isRegistered: boolean;
  wsPingTimer: ReturnType<typeof setInterval> | null;
  wsPongTimer: ReturnType<typeof setTimeout> | null;
  registrationTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  // clearTimeout can't stop a callback already queued, so every timer checks this first
  removed: boolean;
}

let clientIdCounter = 0;

export class ClientManager {
  private clients = new Map<string, ConnectedClient>();
  private connectionsPerIp = new Map<string, number>();

  createClient(webSocket: WebSocket, clientIp: string, serverConfig: ServerConfig, identUsername: string | null): ConnectedClient {
    clientIdCounter++;
    const client: ConnectedClient = {
      id: `c${clientIdCounter}`,
      ipAddress: clientIp,
      webSocket,
      ircClient: new IrcClient(),
      serverConfig,
      identUsername: identUsername ?? `simple_irc_client_webchat_${clientIdCounter}`,
      messageCount: 0,
      rateLimitWindowStart: Date.now(),
      isRegistered: false,
      wsPingTimer: null,
      wsPongTimer: null,
      registrationTimer: null,
      idleTimer: null,
      removed: false,
    };

    this.clients.set(client.id, client);
    this.connectionsPerIp.set(clientIp, this.getIpConnectionCount(clientIp) + 1);

    console.log(
      `[${client.id}] Client connected from ${clientIp}, target: ${serverConfig.host}:${serverConfig.port} (${this.clients.size} total clients)`
    );
    return client;
  }

  removeClient(client: ConnectedClient): void {
    if (client.removed) {
      return;
    }
    client.removed = true;

    this.stopWsPing(client);
    this.clearRegistrationTimeout(client);
    this.clearIdleTimeout(client);

    this.clients.delete(client.id);
    const remaining = this.getIpConnectionCount(client.ipAddress) - 1;
    if (remaining > 0) {
      this.connectionsPerIp.set(client.ipAddress, remaining);
    } else {
      this.connectionsPerIp.delete(client.ipAddress);
    }

    console.log(`[${client.id}] Client disconnected (${this.clients.size} total clients)`);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  getAllClients(): ConnectedClient[] {
    return Array.from(this.clients.values());
  }

  getIpConnectionCount(ipAddress: string): number {
    return this.connectionsPerIp.get(ipAddress) ?? 0;
  }

  /** Counts one line against the client's fixed-window rate limit; `false` means drop it. */
  allowMessage(client: ConnectedClient): boolean {
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

  /** Marks the client registered on its first NICK or USER; returns whether this line did that. */
  checkRegistration(client: ConnectedClient, line: string): boolean {
    if (client.isRegistered) {
      return false;
    }
    const command = ircCommand(line);
    if (command !== 'NICK' && command !== 'USER') {
      return false;
    }
    client.isRegistered = true;
    this.clearRegistrationTimeout(client);
    return true;
  }

  /** Disconnects the client unless it sends NICK or USER in time; 0 disables. */
  startRegistrationTimeout(client: ConnectedClient, timeoutSeconds: number): void {
    if (timeoutSeconds <= 0) {
      return;
    }
    client.registrationTimer = setTimeout(() => {
      if (client.removed || client.isRegistered) {
        return;
      }
      console.info(`[${client.id}] Registration timeout, no NICK/USER received`);
      this.sendRawToClient(client.webSocket, 'ERROR :Registration timeout');
      client.webSocket.close();
    }, timeoutSeconds * 1000);
  }

  /** Restarts the idle countdown; called on traffic other than PING/PONG. 0 disables. */
  resetIdleTimeout(client: ConnectedClient, timeoutSeconds: number): void {
    if (timeoutSeconds <= 0) {
      return;
    }
    this.clearIdleTimeout(client);
    client.idleTimer = setTimeout(() => {
      if (client.removed) {
        return;
      }
      console.info(`[${client.id}] Idle timeout, no IRC traffic for ${timeoutSeconds}s`);
      this.sendRawToClient(client.webSocket, `ERROR :Idle timeout (${timeoutSeconds}s)`);
      client.webSocket.close();
    }, timeoutSeconds * 1000);
  }

  /** Pings the browser every interval and terminates it if a pong takes longer than the timeout. */
  startWsPing(client: ConnectedClient, intervalSeconds: number, timeoutSeconds: number): void {
    client.wsPingTimer = setInterval(() => {
      if (client.removed || client.webSocket.readyState !== WebSocket.OPEN) {
        this.stopWsPing(client);
        return;
      }
      if (client.wsPongTimer !== null) {
        return;
      }

      try {
        client.webSocket.ping();
      } catch (error) {
        // Can throw on a socket that is half-closed
        console.warn(`[${client.id}] ping failed: ${(error as Error).message}`);
        return;
      }

      client.wsPongTimer = setTimeout(() => {
        if (client.removed) {
          return;
        }
        console.info(`[${client.id}] WebSocket pong timeout, terminating connection`);
        client.webSocket.terminate();
      }, timeoutSeconds * 1000);
    }, intervalSeconds * 1000);
  }

  clearWsPongTimer(client: ConnectedClient): void {
    if (client.wsPongTimer !== null) {
      clearTimeout(client.wsPongTimer);
      client.wsPongTimer = null;
    }
  }

  stopWsPing(client: ConnectedClient): void {
    if (client.wsPingTimer !== null) {
      clearInterval(client.wsPingTimer);
      client.wsPingTimer = null;
    }
    this.clearWsPongTimer(client);
  }

  /** `false` means the line wasn't sent or the browser is falling behind; a failed send never throws. */
  sendRawToClient(webSocket: WebSocket, line: string): boolean {
    if (webSocket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      webSocket.send(line);
    } catch (error) {
      console.warn(`[client-manager] ws.send failed: ${(error as Error).message}`);
      return false;
    }
    return webSocket.bufferedAmount < WS_BUFFER_HIGH_WATER_MARK;
  }

  private clearRegistrationTimeout(client: ConnectedClient): void {
    if (client.registrationTimer !== null) {
      clearTimeout(client.registrationTimer);
      client.registrationTimer = null;
    }
  }

  private clearIdleTimeout(client: ConnectedClient): void {
    if (client.idleTimer !== null) {
      clearTimeout(client.idleTimer);
      client.idleTimer = null;
    }
  }
}
