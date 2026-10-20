import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { IrcClient, ircCommand, type SocketMeta } from './irc-client.js';
import { PlaybackBuffer } from './playback.js';

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

/** Lets a browser that lost its WebSocket reattach to the same IRC connection. */
export interface ResumableSession {
  /** Secret the browser presents to resume; never logged */
  token: string;
  playback: PlaybackBuffer;
  /** Set while no browser is attached */
  detachedAt: number | null;
  lingerTimer: ReturnType<typeof setTimeout> | null;
}

/** An IRC connection and the browser currently attached to it. */
export interface ConnectedClient {
  /** "c1", "c2", ... for log lines */
  id: string;
  ipAddress: string;
  /** Null while a resumable session waits for its browser to come back */
  webSocket: WebSocket | null;
  ircClient: IrcClient;
  /** Null unless the browser asked for a resumable session */
  session: ResumableSession | null;
  serverConfig: ServerConfig;
  identUsername: string;
  /** Lines in the current rate-limit window */
  messageCount: number;
  rateLimitWindowStart: number;
  /** Set once the browser sends NICK or USER */
  isRegistered: boolean;
  /** Set once the IRC server accepts the registration (RPL_WELCOME) */
  isWelcomed: boolean;
  /** Set once the browser sends QUIT, so its disconnect ends the session */
  quitRequested: boolean;
  /** Kept from 'socket connected' so the identd entry can be removed whichever side closes first */
  identEntry: SocketMeta | null;
  wsPingTimer: ReturnType<typeof setInterval> | null;
  wsPongTimer: ReturnType<typeof setTimeout> | null;
  registrationTimer: ReturnType<typeof setTimeout> | null;
  // clearTimeout can't stop a callback already queued, so every timer checks this first
  removed: boolean;
}

let clientIdCounter = 0;

export class ClientManager {
  private clients = new Map<string, ConnectedClient>();
  private clientsByToken = new Map<string, ConnectedClient>();
  private connectionsPerIp = new Map<string, number>();

  /** A `sessionBufferSize` makes the session resumable, keeping that many bytes of recent lines. */
  createClient(
    webSocket: WebSocket,
    clientIp: string,
    serverConfig: ServerConfig,
    identUsername: string | null,
    sessionBufferSize?: number
  ): ConnectedClient {
    clientIdCounter++;
    const session: ResumableSession | null =
      sessionBufferSize === undefined
        ? null
        : {
            token: randomBytes(16).toString('base64url'),
            playback: new PlaybackBuffer(sessionBufferSize),
            detachedAt: null,
            lingerTimer: null,
          };
    const client: ConnectedClient = {
      id: `c${clientIdCounter}`,
      ipAddress: clientIp,
      webSocket,
      ircClient: new IrcClient(),
      session,
      serverConfig,
      identUsername: identUsername ?? `simple_irc_client_webchat_${clientIdCounter}`,
      messageCount: 0,
      rateLimitWindowStart: Date.now(),
      isRegistered: false,
      isWelcomed: false,
      quitRequested: false,
      identEntry: null,
      wsPingTimer: null,
      wsPongTimer: null,
      registrationTimer: null,
      removed: false,
    };

    this.clients.set(client.id, client);
    if (session) {
      this.clientsByToken.set(session.token, client);
    }
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
    if (client.session) {
      this.clearLingerTimer(client.session);
      this.clientsByToken.delete(client.session.token);
    }

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

  findByToken(token: string): ConnectedClient | undefined {
    return this.clientsByToken.get(token);
  }

  /** The session that has waited longest for its browser, optionally only among those from `ipAddress`. */
  findOldestDetached(ipAddress?: string): ConnectedClient | undefined {
    let oldest: ConnectedClient | undefined;
    let oldestDetachedAt = Infinity;
    for (const client of this.clientsByToken.values()) {
      const detachedAt = client.session?.detachedAt ?? null;
      if (detachedAt === null || (ipAddress !== undefined && client.ipAddress !== ipAddress)) {
        continue;
      }
      if (detachedAt < oldestDetachedAt) {
        oldest = client;
        oldestDetachedAt = detachedAt;
      }
    }
    return oldest;
  }

  /** Keeps the IRC connection without a browser; `onExpire` runs if none reattaches in time. */
  detach(client: ConnectedClient, lingerSeconds: number, onExpire: () => void): void {
    const { session } = client;
    if (!session) {
      return;
    }
    this.stopWsPing(client);
    client.webSocket = null;
    session.detachedAt = Date.now();
    session.lingerTimer = setTimeout(() => {
      if (!client.removed) {
        onExpire();
      }
    }, lingerSeconds * 1000);
  }

  /** Hands the session to `webSocket`; the caller closes any WebSocket it replaces. */
  attach(client: ConnectedClient, webSocket: WebSocket): void {
    const { session } = client;
    if (!session) {
      return;
    }
    this.stopWsPing(client);
    this.clearLingerTimer(session);
    session.detachedAt = null;
    client.webSocket = webSocket;
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
      if (client.webSocket) {
        this.sendRawToClient(client.webSocket, 'ERROR :Registration timeout');
        client.webSocket.close();
      }
    }, timeoutSeconds * 1000);
  }

  /** Pings the browser every interval and terminates it if a pong takes longer than the timeout. */
  startWsPing(client: ConnectedClient, intervalSeconds: number, timeoutSeconds: number): void {
    const { webSocket } = client;
    if (!webSocket) {
      return;
    }
    client.wsPingTimer = setInterval(() => {
      if (client.removed || webSocket.readyState !== WebSocket.OPEN) {
        this.stopWsPing(client);
        return;
      }
      if (client.wsPongTimer !== null) {
        return;
      }

      try {
        webSocket.ping();
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
        webSocket.terminate();
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

  private clearLingerTimer(session: ResumableSession): void {
    if (session.lingerTimer !== null) {
      clearTimeout(session.lingerTimer);
      session.lingerTimer = null;
    }
  }

}
