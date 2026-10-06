import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, type WebSocketServer } from 'ws';
import { getConfig, type Config } from './config.js';
import { ircCommand, stripCRLF, type SocketMeta } from './irc-client.js';
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

const isKeepalive = (line: string): boolean => {
  const command = ircCommand(line);
  return command === 'PING' || command === 'PONG';
};

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

/**
 * Accepts browser WebSockets and relays raw IRC lines between each one and its IRC server.
 * Connection URL: ws://gateway:8667/webirc?host=irc.example.com&port=6697&tls=true&encoding=utf8
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

    const ipConnections = this.clientManager.getIpConnectionCount(clientIp);
    if (ipConnections >= config.maxConnectionsPerIp) {
      console.warn(`[gateway] Per-IP limit reached: ${clientIp} (${ipConnections} connections)`);
      this.rejectConnection(socket, 429, 'Too Many Requests');
      return;
    }

    if (this.clientManager.clientCount >= config.maxClients) {
      this.rejectConnection(socket, 503, 'Service Unavailable');
      return;
    }

    const identUsername = url.searchParams.get('ident');
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.handleNewClient(webSocket, clientIp, serverConfig, identUsername, config);
    });
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
    config: Config
  ): void {
    const client = this.clientManager.createClient(webSocket, clientIp, serverConfig, identUsername);
    const { ircClient } = client;

    // Kept from 'socket connected', since the identd entry must be removed by whichever side closes first
    let identEntry: SocketMeta | null = null;
    const unregisterIdent = (): void => {
      if (identEntry) {
        this.identdServer?.unregister(identEntry.localPort, identEntry.remotePort, identEntry.remoteAddress);
        identEntry = null;
      }
    };

    ircClient.on('socket connected', (meta) => {
      identEntry = meta;
      this.identdServer?.register(meta.localPort, meta.remotePort, meta.remoteAddress, client.identUsername);
    });
    ircClient.on('line', (line) => this.forwardToBrowser(client, line, config));
    ircClient.on('error', (error) => {
      console.warn(`[${client.id}] IRC error: ${error.message}`);
      this.clientManager.sendRawToClient(webSocket, `ERROR :${stripCRLF(error.message)}`);
    });
    ircClient.on('close', () => {
      unregisterIdent();
      webSocket.close();
    });

    webSocket.on('message', (data) => this.forwardToServer(client, data.toString(), config));
    webSocket.on('pong', () => this.clientManager.clearWsPongTimer(client));
    webSocket.on('error', (error) => console.warn(`[${client.id}] WebSocket error: ${error.message}`));
    webSocket.on('close', () => {
      unregisterIdent();
      ircClient.quit(config.quitMessage);
      this.clientManager.removeClient(client);
    });

    this.clientManager.startWsPing(client, config.wsPingInterval, config.wsPongTimeout);
    this.clientManager.startRegistrationTimeout(client, config.registrationTimeout);
    this.clientManager.resetIdleTimeout(client, config.idleTimeout);

    this.connectToIrc(client, config);
  }

  private connectToIrc(client: ConnectedClient, config: Config): void {
    const { host, port, tls, encoding } = client.serverConfig;

    // WEBIRC carries a password, so it never goes over plaintext
    if (config.webircPassword && !tls) {
      console.warn(`[${client.id}] Rejected non-TLS connection while WEBIRC is configured`);
      this.clientManager.sendRawToClient(client.webSocket, 'ERROR :Connection rejected — TLS required');
      client.webSocket.close();
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
  private forwardToServer(client: ConnectedClient, message: string, config: Config): void {
    const { ircClient, webSocket } = client;

    for (const line of message.split(/[\r\n]+/)) {
      if (line.length === 0) {
        continue;
      }
      if (!this.clientManager.allowMessage(client)) {
        return;
      }
      this.clientManager.checkRegistration(client, line);
      if (!isKeepalive(line)) {
        this.clientManager.resetIdleTimeout(client, config.idleTimeout);
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

  private forwardToBrowser(client: ConnectedClient, line: string, config: Config): void {
    if (!isKeepalive(line)) {
      this.clientManager.resetIdleTimeout(client, config.idleTimeout);
    }

    const drained = this.clientManager.sendRawToClient(client.webSocket, line);
    if (!drained && client.webSocket.readyState === WebSocket.OPEN) {
      console.info(`[${client.id}] WebSocket backpressure, pausing IRC reads`);
      client.ircClient.pause();
      this.resumeIrcWhenDrained(client);
    }
  }

  // `ws` has no drain event, so the buffered amount is polled
  private resumeIrcWhenDrained(client: ConnectedClient): void {
    const poll = (): void => {
      if (client.webSocket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (client.webSocket.bufferedAmount < WS_BUFFER_LOW_WATER_MARK) {
        console.info(`[${client.id}] WebSocket drained, resuming IRC reads`);
        client.ircClient.resume();
        return;
      }
      setTimeout(poll, WS_DRAIN_POLL_MS);
    };
    setTimeout(poll, WS_DRAIN_POLL_MS);
  }
}
