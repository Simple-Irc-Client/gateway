/**
 * IRC Client for Gateway
 *
 * Handles TCP/TLS connections to IRC servers, including:
 * - Connection establishment (plain and TLS)
 * - IRC protocol registration (NICK, USER, CAP, PASS)
 * - Message encoding/decoding for various character sets
 * - WEBIRC support for passing real client IPs to IRC servers
 * - Automatic PING/PONG keepalive
 */

import { EventEmitter } from 'events';
import * as net from 'net';
import * as tls from 'tls';
import iconv from 'iconv-lite';

// ============================================================================
// Types
// ============================================================================

/**
 * Base socket connection options
 */
interface SocketConnectionOptions {
  /** IRC server hostname */
  host: string;
  /** IRC server port */
  port: number;
  /** Whether to use TLS encryption */
  tls?: boolean;
  /** Character encoding for messages (defaults to utf8) */
  encoding?: string;
  /** WEBIRC configuration for passing real client IP to server */
  webirc?: WebircConfig;
}

/**
 * Options for connecting to an IRC server
 */
export interface IrcConnectionOptions extends SocketConnectionOptions {
  /** Nickname to use */
  nick: string;
  /** Username (defaults to nick if not provided) */
  username?: string;
  /** Real name shown in WHOIS (defaults to nick if not provided) */
  realname?: string;
  /** Server password (sent with PASS command) */
  password?: string;
}

/**
 * Options for raw connection (client handles registration)
 */
export type IrcRawConnectionOptions = SocketConnectionOptions;

/**
 * WEBIRC configuration for identifying real client IPs to IRC servers
 *
 * WEBIRC is a protocol extension that allows gateways to pass the real
 * client's IP address to the IRC server, which is used for bans, hostname
 * display, etc.
 */
export interface WebircConfig {
  /** WEBIRC password (must match server configuration) */
  password: string;
  /** Gateway identifier name */
  gateway: string;
  /** Hostname to report for the client */
  hostname: string;
  /** IP address to report for the client */
  ip: string;
}

// ============================================================================
// Constants
// ============================================================================

/** IRC line terminator */
const IRC_LINE_ENDING = '\r\n';

/** Strip CR/LF from user-supplied values to prevent IRC protocol injection */
const stripCRLF = (input: string): string => input.replace(/[\r\n]/g, '');

/** Interval for sending PING keepalive messages (30 seconds) */
const PING_INTERVAL_MS = 30000;

/** Timeout for TCP/TLS connection establishment (30 seconds) */
const CONNECTION_TIMEOUT_MS = 30000;

/** Timeout for receiving server response after sending PING (60 seconds) */
const PONG_TIMEOUT_MS = 60000;

/**
 * Pattern to match RPL_WELCOME (001) from a server
 *
 * Format: [:server.name 001 nickname :Welcome message]
 * Or with IRCv3 tags: [@time=... :server.name 001 nickname :Welcome message]
 *
 * - Optional IRCv3 message tags (@key=value;... ) at the start
 * - Server prefix starting with :
 * - Source must not contain ! or @ (those indicate a user hostmask)
 * - Command must be exactly 001
 */
const RPL_WELCOME_PATTERN = /^(@\S+ )?:[^\s!@]+ 001 /;

// ============================================================================
// IRC Client Class
// ============================================================================

/**
 * IRC Client
 *
 * Manages a single connection to an IRC server. Handles:
 * - TCP/TLS socket management
 * - IRC protocol message framing
 * - Character encoding conversion
 * - Automatic PING response and keepalive
 *
 * Events emitted:
 * - 'socket_connected': TCP/TLS connection established
 * - 'connected': IRC registration complete (received 001)
 * - 'close': Connection closed
 * - 'error': Connection error occurred
 * - 'raw': Raw IRC message (line: string, isFromServer: boolean)
 */
export class IrcClient extends EventEmitter {
  /** TCP or TLS socket connection */
  private socket: net.Socket | tls.TLSSocket | null = null;

  /** Buffer for incomplete incoming data */
  private receiveBuffer = Buffer.alloc(0);

  /** Character encoding for this connection */
  private characterEncoding = 'utf8';

  /** Timer for periodic PING keepalive */
  private pingIntervalTimer: ReturnType<typeof setInterval> | null = null;

  /** Timer that fires if server doesn't respond after PING */
  private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  // ==========================================================================
  // Connection Management
  // ==========================================================================

  /**
   * Connect to an IRC server
   *
   * Establishes a TCP or TLS connection and performs IRC registration:
   * 1. Sends WEBIRC (if configured)
   * 2. Sends PASS (if password provided)
   * 3. Sends CAP LS 302 to negotiate capabilities
   * 4. Sends NICK and USER to complete registration
   */
  connect(options: IrcConnectionOptions): void {
    // Clean up any existing connection
    this.destroy();

    // Initialize connection state
    this.characterEncoding = options.encoding ?? 'utf8';
    this.receiveBuffer = Buffer.alloc(0);

    // Create socket (TLS or plain TCP)
    const socket = this.createSocket(options);
    this.socket = socket;

    // Handle successful connection
    socket.once('connect', () => {
      this.handleSocketConnected(options);
    });

    // Handle incoming data
    socket.on('data', (data: Buffer) => {
      this.handleIncomingData(data);
    });

    // Handle connection close
    socket.on('close', () => {
      this.handleSocketClosed();
    });

    // Handle connection errors
    socket.on('error', (error: Error) => {
      this.emit('error', error);
    });
  }

  /**
   * Connect to an IRC server in raw mode
   *
   * Establishes a TCP or TLS connection but does NOT perform IRC registration.
   * The client is expected to send NICK, USER, CAP, etc. themselves.
   * Only WEBIRC is sent if configured (must be first command per IRC spec).
   */
  connectRaw(options: IrcRawConnectionOptions): void {
    // Clean up any existing connection
    this.destroy();

    // Initialize connection state
    this.characterEncoding = options.encoding ?? 'utf8';
    this.receiveBuffer = Buffer.alloc(0);

    // Create socket (TLS or plain TCP)
    const socket = this.createSocket(options);
    this.socket = socket;

    // Handle successful connection
    socket.once('connect', () => {
      this.handleRawSocketConnected(options);
    });

    // Handle incoming data
    socket.on('data', (data: Buffer) => {
      this.handleIncomingData(data);
    });

    // Handle connection close
    socket.on('close', () => {
      this.handleSocketClosed();
    });

    // Handle connection errors
    socket.on('error', (error: Error) => {
      this.emit('error', error);
    });
  }

  /**
   * Handle successful socket connection in raw mode
   *
   * Only sends WEBIRC if configured, then lets client handle registration
   */
  private handleRawSocketConnected(options: IrcRawConnectionOptions): void {
    // Handshake succeeded — disable the connection establishment timeout
    this.socket?.setTimeout(0);

    this.emit('socket_connected');

    // Send WEBIRC command if configured (must be first)
    if (options.webirc) {
      this.send(
        `WEBIRC ${stripCRLF(options.webirc.password)} ${stripCRLF(options.webirc.gateway)} ` +
        `${stripCRLF(options.webirc.hostname)} ${stripCRLF(options.webirc.ip)}`
      );
    }

    // Start keepalive ping timer
    this.startPingTimer();
  }

  /**
   * Create a TCP or TLS socket based on connection options
   */
  private createSocket(options: SocketConnectionOptions): net.Socket | tls.TLSSocket {
    const connectionConfig = {
      host: options.host,
      port: options.port,
    };

    let socket: net.Socket | tls.TLSSocket;

    if (options.tls) {
      // TLS connection - disable certificate validation for self-signed certs
      socket = tls.connect({
        ...connectionConfig,
        rejectUnauthorized: false,
      });
    } else {
      // Plain TCP connection
      socket = net.connect(connectionConfig);
    }

    // Connection establishment timeout — destroy socket if handshake
    // doesn't complete within the allowed time
    socket.setTimeout(CONNECTION_TIMEOUT_MS);
    socket.once('timeout', () => {
      socket.destroy(new Error('Connection timed out'));
    });

    return socket;
  }

  /**
   * Handle successful socket connection
   *
   * Performs IRC registration sequence
   */
  private handleSocketConnected(options: IrcConnectionOptions): void {
    // Handshake succeeded — disable the connection establishment timeout
    this.socket?.setTimeout(0);

    this.emit('socket_connected');

    // Send WEBIRC command if configured (must be first)
    if (options.webirc) {
      this.send(
        `WEBIRC ${stripCRLF(options.webirc.password)} ${stripCRLF(options.webirc.gateway)} ` +
        `${stripCRLF(options.webirc.hostname)} ${stripCRLF(options.webirc.ip)}`
      );
    }

    // Send server password if provided
    if (options.password) {
      this.send(`PASS ${stripCRLF(options.password)}`);
    }

    // Request IRCv3 capability negotiation
    this.send('CAP LS 302');

    // Send nickname
    this.send(`NICK ${stripCRLF(options.nick)}`);

    // Send user information
    const username = stripCRLF(options.username ?? options.nick);
    const realname = stripCRLF(options.realname ?? options.nick);
    this.send(`USER ${username} 0 * :${realname}`);

    // Start keepalive ping timer
    this.startPingTimer();
  }

  /**
   * Handle socket close event
   */
  private handleSocketClosed(): void {
    this.stopPingTimer();
    this.emit('close');
  }

  // ==========================================================================
  // Data Handling
  // ==========================================================================

  /**
   * Handle incoming data from the socket
   *
   * IRC messages are terminated by \r\n, but data may arrive in chunks
   * that don't align with message boundaries. This method buffers
   * incoming data and processes complete lines.
   */
  private handleIncomingData(data: Buffer): void {
    // Append new data to buffer
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);

    // Process complete lines
    let lineEndIndex: number;
    while ((lineEndIndex = this.receiveBuffer.indexOf(IRC_LINE_ENDING)) !== -1) {
      // Extract the line (without \r\n)
      const lineBuffer = this.receiveBuffer.subarray(0, lineEndIndex);
      const line = this.decodeBuffer(lineBuffer);

      // Remove processed data from buffer (including \r\n)
      this.receiveBuffer = this.receiveBuffer.subarray(lineEndIndex + 2);

      // Process the line
      if (line) {
        this.handleIrcLine(line);
      }
    }
  }

  /**
   * Handle a complete IRC line
   */
  private handleIrcLine(line: string): void {
    // Any data from server proves it's alive — clear the PONG timeout
    this.clearPongTimeout();

    // Emit raw line for logging and forwarding to client
    this.emit('raw', line, true);

    // Respond to server PING to maintain connection
    if (line.startsWith('PING ')) {
      const pingData = line.slice(5);
      this.send(`PONG ${pingData}`);
    }
    // Detect successful registration (numeric 001 from server)
    else if (RPL_WELCOME_PATTERN.test(line)) {
      this.emit('connected');
    }
  }

  // ==========================================================================
  // Sending Messages
  // ==========================================================================

  /**
   * Send a raw IRC command to the server
   *
   * Automatically appends \r\n line terminator
   */
  send(line: string): void {
    if (this.socket?.writable) {
      const encodedLine = this.encodeString(`${line}${IRC_LINE_ENDING}`);
      this.socket.write(encodedLine);

      // Emit raw line for logging (isFromServer = false)
      this.emit('raw', line, false);
    }
  }

  /**
   * Send QUIT command and gracefully close the connection
   */
  quit(message?: string): void {
    if (this.socket?.writable) {
      // Send QUIT with optional message
      const quitCommand = message ? `QUIT :${message}` : 'QUIT';
      this.send(quitCommand);

      // Gracefully close the socket
      this.socket.end();
    }

    this.stopPingTimer();
  }

  /**
   * Forcefully destroy the connection
   *
   * Use this when you need to immediately close without
   * waiting for graceful shutdown
   */
  destroy(): void {
    this.stopPingTimer();

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  // ==========================================================================
  // Keepalive
  // ==========================================================================

  /**
   * Start the periodic PING keepalive timer
   *
   * Sends PING messages to detect dead connections
   */
  private startPingTimer(): void {
    this.pingIntervalTimer = setInterval(() => {
      // Use timestamp as PING data for debugging
      this.send(`PING :${Date.now()}`);

      // Start a PONG timeout — if the server doesn't send anything
      // before this fires, consider the connection dead
      this.clearPongTimeout();
      this.pongTimeoutTimer = setTimeout(() => {
        this.socket?.destroy(new Error('PONG timeout: server unresponsive'));
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  /**
   * Clear the PONG response timeout (called when server sends any data)
   */
  private clearPongTimeout(): void {
    if (this.pongTimeoutTimer) {
      clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
    }
  }

  /**
   * Stop the PING keepalive timer and PONG timeout
   */
  private stopPingTimer(): void {
    if (this.pingIntervalTimer) {
      clearInterval(this.pingIntervalTimer);
      this.pingIntervalTimer = null;
    }
    this.clearPongTimeout();
  }

  // ==========================================================================
  // Character Encoding
  // ==========================================================================

  /**
   * Decode a buffer to string using the connection's character encoding
   */
  private decodeBuffer(buffer: Buffer): string {
    if (this.characterEncoding === 'utf8') {
      return buffer.toString('utf8');
    }
    return iconv.decode(buffer, this.characterEncoding);
  }

  /**
   * Encode a string to buffer using the connection's character encoding
   */
  private encodeString(text: string): Buffer {
    if (this.characterEncoding === 'utf8') {
      return Buffer.from(text, 'utf8');
    }
    return iconv.encode(text, this.characterEncoding);
  }

  // ==========================================================================
  // State
  // ==========================================================================

  /**
   * Check if the connection is currently active and writable
   */
  get connected(): boolean {
    return this.socket?.writable ?? false;
  }
}
