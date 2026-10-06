import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { getConfig } from './config.js';
import { IdentdServer } from './identd.js';
import { ClientManager, type ConnectedClient } from './client-manager.js';
import { ConnectionHandler } from './connection-handler.js';

const MAX_WS_PAYLOAD_BYTES = 64 * 1024;

/** How long clients get to flush their last lines (IRC ERROR, QUIT replies) on shutdown */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5000;

/** WebSocket gateway between browsers and IRC servers: [Browser] <-raw IRC over WebSocket-> [Gateway] <-TCP/TLS-> [IRC server] */
export class Gateway {
  private httpServer = createServer((_request, response) => {
    response.end('Simple IRC Client Gateway');
  });

  private webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
  private clientManager = new ClientManager();
  private connectionHandler = new ConnectionHandler(this.webSocketServer, this.clientManager);
  private identdServer: IdentdServer | null = null;

  constructor() {
    this.httpServer.on('upgrade', (request, socket, head) => {
      this.connectionHandler.handleWebSocketUpgrade(request, socket, head);
    });
  }

  /** Resolves once listening; rejects if the port can't be bound. A failed identd only logs a warning. */
  async start(): Promise<void> {
    const config = getConfig();

    if (config.identdEnabled) {
      const identdServer = new IdentdServer(config.identdTimeout);
      try {
        await identdServer.start(config.identdPort);
        this.identdServer = identdServer;
        this.connectionHandler.setIdentdServer(identdServer);
      } catch (error) {
        console.warn(`[identd] Failed to start: ${(error as Error).message}`);
      }
    }

    await new Promise<void>((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(config.port, config.host, () => {
        this.httpServer.off('error', reject);
        // Errors after listening (e.g. EMFILE on accept) would otherwise crash the process
        this.httpServer.on('error', (error: NodeJS.ErrnoException) => {
          console.error(`[gateway] HTTP server error${error.code ? ` (${error.code})` : ''}: ${error.message}`);
        });
        console.log(`Gateway started on ${config.host}:${config.port}${config.path}`);
        resolve();
      });
    });
  }

  /** Quits every IRC connection, gives clients a bounded time to close, then stops the servers. */
  async stop(): Promise<void> {
    const config = getConfig();

    const clients = this.clientManager.getAllClients();
    for (const client of clients) {
      client.ircClient.quit(config.quitMessage);
      if (client.webSocket.readyState === WebSocket.OPEN) {
        client.webSocket.close();
      }
    }
    await this.waitForClientsToClose(clients, SHUTDOWN_DRAIN_TIMEOUT_MS);

    if (this.identdServer) {
      await this.identdServer.stop();
      this.identdServer = null;
      this.connectionHandler.setIdentdServer(null);
    }

    await new Promise<void>((resolve) => this.webSocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));

    console.log('Gateway stopped');
  }

  /** Terminates clients still open at the deadline, otherwise httpServer.close() would wait for them forever. */
  private waitForClientsToClose(clients: ConnectedClient[], timeoutMs: number): Promise<void> {
    const open = clients.filter((client) => client.webSocket.readyState !== WebSocket.CLOSED);
    if (open.length === 0) {
      return Promise.resolve();
    }

    const allClosed = Promise.all(
      open.map((client) => new Promise<void>((resolve) => client.webSocket.once('close', () => resolve())))
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        for (const client of open) {
          if (client.webSocket.readyState !== WebSocket.CLOSED) {
            client.webSocket.terminate();
          }
        }
        resolve();
      }, timeoutMs);
    });

    return Promise.race([allClosed, deadline]).then(() => clearTimeout(timer));
  }
}
