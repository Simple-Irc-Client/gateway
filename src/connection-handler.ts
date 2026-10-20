import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, type WebSocketServer } from 'ws';
import { getConfig, type Config } from './config.js';
import { ircCommand, stripCRLF } from './irc-client.js';
import type { IdentdServer } from './identd.js';
import type { ClientManager, ConnectedClient, ServerConfig } from './client-manager.js';
import { isPrivateHost, privateAddressGuard } from './security.js';

const ALLOWED_ENCODINGS = new Set([
  'utf8', 'utf-8', 'ascii', 'latin1', 'iso-8859-1', 'iso-8859-2', 'iso-8859-3',
  'iso-8859-4', 'iso-8859-5', 'iso-8859-6', 'iso-8859-7', 'iso-8859-8',
  'iso-8859-9', 'iso-8859-10', 'iso-8859-13', 'iso-8859-14', 'iso-8859-15',
  'iso-8859-16', 'windows-1250', 'windows-1251', 'windows-1252', 'windows-1253',
  'windows-1254', 'windows-1255', 'windows-1256', 'windows-1257', 'windows-1258',
  'koi8-r', 'koi8-u', 'shift_jis', 'euc-jp', 'euc-kr', 'gb2312', 'gbk', 'gb18030',
  'big5', 'tis-620',
]);

// The IRC socket resumes once the browser's buffer falls below this
const WS_BUFFER_LOW_WATER_MARK = 512 * 1024;
const WS_DRAIN_POLL_MS = 50;

/** Source of the lines the gateway itself sends to the browser */
const GATEWAY_SOURCE = ':sic-gateway';
const RPL_WELCOME = '001';
/** Close code for a WebSocket whose session was resumed on a newer one */
const SESSION_REPLACED_CLOSE_CODE = 4001;

/** The browser's address; X-Forwarded-For is trusted only behind a configured proxy. */
const getClientIp = (request: IncomingMessage, trustProxy: boolean): string => {
  if (trustProxy) {
    const forwardedFor = request.headers['x-forwarded-for']?.toString().split(',')[0]?.trim();
    if (forwardedFor) {
      return forwardedFor;
    }
  }
  return request.socket.remoteAddress ?? '127.0.0.1';
};

/** Reads the target IRC server from the query string; `null` when host or port is missing or invalid. */
const parseServerConfig = (params: URLSearchParams): ServerConfig | null => {
  const host = params.get('host');
  const port = Number(params.get('port'));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  const encoding = params.get('encoding') ?? 'utf8';
  return {
    host,
    port,
    tls: params.get('tls') === 'true',
    encoding: ALLOWED_ENCODINGS.has(encoding.toLowerCase()) ? encoding : 'utf8',
  };
};

interface SessionRequest {
  /** The browser wants a session it can resume after losing its WebSocket */
  resumable: boolean;
  resumeToken: string | null;
  /** Sequence number of the last line the resuming browser received */
  lastSeenSeq: number;
  /** Session the browser can no longer resume (e.g. after a page reload) and wants ended */
  replaceToken: string | null;
}

const parseSessionRequest = (params: URLSearchParams): SessionRequest => {
  const lastSeenSeq = Number(params.get('since'));
  return {
    resumable: params.get('session') === 'true' || params.has('resume'),
    resumeToken: params.get('resume'),
    lastSeenSeq: Number.isSafeInteger(lastSeenSeq) && lastSeenSeq > 0 ? lastSeenSeq : 0,
    replaceToken: params.get('replace'),
  };
};

const isSameServer = (a: ServerConfig, b: ServerConfig): boolean =>
  a.host === b.host && a.port === b.port && a.tls === b.tls && a.encoding === b.encoding;

/**
 * Accepts browser WebSockets and relays raw IRC lines between each one and its IRC server.
 * Connection URL: ws://gateway:8667/webirc?host=irc.example.com&port=6697&tls=true&encoding=utf8
 *
 * With `session=true` the IRC connection outlives the WebSocket for `sessionLinger` seconds, and the browser
 * can come back with `resume=<token>&since=<last seq>` to receive the lines it missed.
 */
export class ConnectionHandler {
  private readonly webSocketServer: WebSocketServer;
  private readonly clientManager: ClientManager;
  private identdServer: IdentdServer | null = null;

  constructor(webSocketServer: WebSocketServer, clientManager: ClientManager) {
    this.webSocketServer = webSocketServer;
    this.clientManager = clientManager;
  }

  setIdentdServer(identdServer: IdentdServer | null): void {
    this.identdServer = identdServer;
  }

  handleWebSocketUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const config = getConfig();
    const url = new URL(request.url ?? '/', 'http://localhost');
    const clientIp = getClientIp(request, config.trustProxy);

    if (url.pathname !== config.path) {
      this.rejectConnection(socket, 404, 'Not Found');
      return;
    }

    if (config.allowedOrigins?.length) {
      const origin = request.headers.origin;
      if (!origin || !config.allowedOrigins.includes(origin)) {
        this.rejectConnection(socket, 403, 'Forbidden - Origin not allowed');
        return;
      }
    }

    if (config.enforceTls && url.searchParams.get('tls') !== 'true') {
      this.rejectConnection(socket, 403, 'Forbidden - TLS required for all connections');
      return;
    }

    const serverConfig = parseServerConfig(url.searchParams);
    if (!serverConfig) {
      this.rejectConnection(socket, 400, 'Bad Request - Missing or invalid host/port');
      return;
    }

    if (config.blockPrivateHosts && isPrivateHost(serverConfig.host)) {
      console.warn(`[gateway] SSRF blocked: ${clientIp} tried to connect to private host ${serverConfig.host}`);
      this.rejectConnection(socket, 403, 'Forbidden - Private hosts not allowed');
      return;
    }

    if (config.allowedServers?.length && !config.allowedServers.includes(`${serverConfig.host}:${serverConfig.port}`)) {
      this.rejectConnection(socket, 403, 'Forbidden - Server not allowed');
      return;
    }

    const sessionRequest = parseSessionRequest(url.searchParams);
    const resumable = this.findSession(sessionRequest.resumeToken, serverConfig);
    if (resumable && this.canResume(resumable)) {
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.resumeSession(resumable, webSocket, sessionRequest.lastSeenSeq, config);
      });
      return;
    }

    const replaced = this.findSession(sessionRequest.replaceToken, serverConfig);
    if (replaced) {
      console.info(`[${replaced.id}] Ending session replaced by a new connection`);
      this.endSession(replaced);
    }

    const ipConnections = this.clientManager.getIpConnectionCount(clientIp);
    if (ipConnections >= config.maxConnectionsPerIp && !this.endOldestDetached(clientIp)) {
      console.warn(`[gateway] Per-IP limit reached: ${clientIp} (${ipConnections} connections)`);
      this.rejectConnection(socket, 429, 'Too Many Requests');
      return;
    }

    if (this.clientManager.clientCount >= config.maxClients && !this.endOldestDetached()) {
      this.rejectConnection(socket, 503, 'Service Unavailable');
      return;
    }

    const identUsername = url.searchParams.get('ident');
    const sessionBufferSize = sessionRequest.resumable && config.sessionLinger > 0 ? config.sessionBufferSize : undefined;
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.handleNewClient(webSocket, clientIp, serverConfig, identUsername, sessionBufferSize, config);
    });
  }

  /** Quits the IRC connection, closes the browser's WebSocket if attached and forgets the client. */
  endSession(client: ConnectedClient): void {
    if (client.removed) {
      return;
    }
    if (client.identEntry) {
      const { localPort, remotePort, remoteAddress } = client.identEntry;
      this.identdServer?.unregister(localPort, remotePort, remoteAddress);
      client.identEntry = null;
    }
    client.ircClient.quit(getConfig().quitMessage);
    const { webSocket } = client;
    this.clientManager.removeClient(client);
    webSocket?.close();
  }

  private rejectConnection(socket: Duplex, statusCode: number, message: string): void {
    socket.write(`HTTP/1.1 ${statusCode} ${message}\r\n\r\n`);
    socket.destroy();
  }

  private handleNewClient(
    webSocket: WebSocket,
    clientIp: string,
    serverConfig: ServerConfig,
    identUsername: string | null,
    sessionBufferSize: number | undefined,
    config: Config
  ): void {
    const client = this.clientManager.createClient(webSocket, clientIp, serverConfig, identUsername, sessionBufferSize);
    const { ircClient } = client;

    ircClient.on('socket connected', (meta) => {
      client.identEntry = meta;
      this.identdServer?.register(meta.localPort, meta.remotePort, meta.remoteAddress, client.identUsername);
    });
    ircClient.on('line', (line) => this.forwardToBrowser(client, line));
    ircClient.on('error', (error) => {
      console.warn(`[${client.id}] IRC error: ${error.message}`);
      if (client.webSocket) {
        this.clientManager.sendRawToClient(client.webSocket, `ERROR :${stripCRLF(error.message)}`);
      }
    });
    ircClient.on('close', () => this.endSession(client));

    this.attachWebSocket(client, webSocket, config);
    if (client.session) {
      this.clientManager.sendRawToClient(webSocket, `${GATEWAY_SOURCE} SESSION ${client.session.token}`);
    }
    this.clientManager.startRegistrationTimeout(client, config.registrationTimeout);

    this.connectToIrc(client, webSocket, config);
  }

  /** Relays the WebSocket's lines while it is the client's current one, and decides what its close means. */
  private attachWebSocket(client: ConnectedClient, webSocket: WebSocket, config: Config): void {
    const isCurrent = (): boolean => !client.removed && client.webSocket === webSocket;

    webSocket.on('message', (data) => {
      if (isCurrent()) {
        this.forwardToServer(client, webSocket, data.toString());
      }
    });
    webSocket.on('pong', () => {
      if (isCurrent()) {
        this.clientManager.clearWsPongTimer(client);
      }
    });
    webSocket.on('error', (error) => console.warn(`[${client.id}] WebSocket error: ${error.message}`));
    webSocket.on('close', () => {
      if (!isCurrent()) {
        return;
      }
      if (this.canLinger(client)) {
        this.detach(client, config);
      } else {
        this.endSession(client);
      }
    });

    this.clientManager.startWsPing(client, config.wsPingInterval, config.wsPongTimeout);
  }

  private findSession(token: string | null, serverConfig: ServerConfig): ConnectedClient | undefined {
    if (!token) {
      return undefined;
    }
    const client = this.clientManager.findByToken(token);
    return client && isSameServer(client.serverConfig, serverConfig) ? client : undefined;
  }

  /** Only a registered session can be handed over: the browser skips registration when it resumes. */
  private canResume(client: ConnectedClient): boolean {
    return client.isWelcomed && !client.quitRequested && client.ircClient.writable;
  }

  private canLinger(client: ConnectedClient): boolean {
    return client.session !== null && this.canResume(client);
  }

  private detach(client: ConnectedClient, config: Config): void {
    this.clientManager.detach(client, config.sessionLinger, () => {
      console.info(`[${client.id}] Browser did not come back, ending session`);
      this.endSession(client);
    });
    // Reads may still be paused for the closed WebSocket's backpressure
    client.ircClient.resume();
    console.info(`[${client.id}] Browser disconnected, keeping the IRC session for ${config.sessionLinger}s`);
  }

  private resumeSession(client: ConnectedClient, webSocket: WebSocket, lastSeenSeq: number, config: Config): void {
    const { session } = client;
    if (!session) {
      return;
    }
    const replaced = client.webSocket;
    this.clientManager.attach(client, webSocket);
    replaced?.close(SESSION_REPLACED_CLOSE_CODE, 'Session resumed elsewhere');
    this.attachWebSocket(client, webSocket, config);

    const { lines, complete } = session.playback.since(lastSeenSeq);
    this.clientManager.sendRawToClient(webSocket, `${GATEWAY_SOURCE} RESUMED ${complete ? 'complete' : 'partial'}`);
    for (const line of lines) {
      this.clientManager.sendRawToClient(webSocket, line);
    }
    console.info(`[${client.id}] Browser resumed the session, replayed ${lines.length} lines`);
  }

  /** Makes room by ending the session that has waited longest for its browser; false when there is none. */
  private endOldestDetached(ipAddress?: string): boolean {
    const oldest = this.clientManager.findOldestDetached(ipAddress);
    if (!oldest) {
      return false;
    }
    console.info(`[${oldest.id}] Ending detached session to make room for a new connection`);
    this.endSession(oldest);
    return true;
  }

  private connectToIrc(client: ConnectedClient, webSocket: WebSocket, config: Config): void {
    const { host, port, tls, encoding } = client.serverConfig;

    // WEBIRC carries a password, so it never goes over plaintext
    if (config.webircPassword && !tls) {
      console.warn(`[${client.id}] Rejected non-TLS connection while WEBIRC is configured`);
      this.clientManager.sendRawToClient(webSocket, 'ERROR :Connection rejected — TLS required');
      webSocket.close();
      return;
    }

    const webirc = config.webircPassword
      ? {
          password: config.webircPassword,
          gateway: config.webircGateway ?? 'gateway',
          hostname: `${client.ipAddress}.web`,
          ip: client.ipAddress,
        }
      : undefined;

    client.ircClient.connect({
      host,
      port,
      tls,
      encoding,
      webirc,
      pongTimeout: config.pongTimeout,
      lookup: config.blockPrivateHosts ? privateAddressGuard : undefined,
    });
    console.log(`[${client.id}] Connecting to ${host}:${port}`);
  }

  /** Lines from the browser; rate limited per line, so one large frame can't carry a flood. */
  private forwardToServer(client: ConnectedClient, webSocket: WebSocket, message: string): void {
    const { ircClient } = client;

    for (const line of message.split(/[\r\n]+/)) {
      if (line.length === 0) {
        continue;
      }
      if (!this.clientManager.allowMessage(client)) {
        return;
      }
      this.clientManager.checkRegistration(client, line);
      if (ircCommand(line) === 'QUIT') {
        client.quitRequested = true;
      }

      const drained = ircClient.send(line);
      if (!drained && ircClient.writable && webSocket.readyState === WebSocket.OPEN) {
        console.info(`[${client.id}] IRC backpressure, pausing WebSocket reads`);
        webSocket.pause();
        const resume = (): void => {
          if (webSocket.readyState === WebSocket.OPEN) {
            webSocket.resume();
          }
        };
        ircClient.waitForDrain().then(resume, resume);
      }
    }
  }

  private forwardToBrowser(client: ConnectedClient, line: string): void {
    if (!client.isWelcomed && ircCommand(line) === RPL_WELCOME) {
      client.isWelcomed = true;
    }
    const outgoing = client.session ? client.session.playback.record(line) : line;

    const { webSocket } = client;
    if (!webSocket) {
      return;
    }
    const drained = this.clientManager.sendRawToClient(webSocket, outgoing);
    if (!drained && webSocket.readyState === WebSocket.OPEN) {
      console.info(`[${client.id}] WebSocket backpressure, pausing IRC reads`);
      client.ircClient.pause();
      this.resumeIrcWhenDrained(client);
    }
  }

  // `ws` has no drain event, so the buffered amount is polled
  private resumeIrcWhenDrained(client: ConnectedClient): void {
    const poll = (): void => {
      const { webSocket } = client;
      if (webSocket?.readyState !== WebSocket.OPEN) {
        return;
      }
      if (webSocket.bufferedAmount < WS_BUFFER_LOW_WATER_MARK) {
        console.info(`[${client.id}] WebSocket drained, resuming IRC reads`);
        client.ircClient.resume();
        return;
      }
      setTimeout(poll, WS_DRAIN_POLL_MS);
    };
    setTimeout(poll, WS_DRAIN_POLL_MS);
  }
}
