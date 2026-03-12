/**
 * IRC Client Types and Constants
 *
 * Common types and constants used across IRC client modules
 */

import { EventEmitter } from 'node:events';

// ============================================================================
// Types
// ============================================================================

/**
 * Base socket connection options
 */
export interface SocketConnectionOptions {
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
  /** Timeout in seconds for server to respond after PING (default: 120) */
  pongTimeout?: number;
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
// Base IRC Client Class
// ============================================================================

/**
 * Base IRC Client
 *
 * Abstract base class for IRC client implementations
 */
export abstract class BaseIrcClient extends EventEmitter {
  /**
   * Connect to an IRC server
   */
  abstract connect(options: IrcConnectionOptions): void;

  /**
   * Connect to an IRC server in raw mode
   */
  abstract connectRaw(options: IrcRawConnectionOptions): void;

  /**
   * Send a raw IRC command to the server
   */
  abstract send(line: string): void;

  /**
   * Send QUIT command and gracefully close the connection
   */
  abstract quit(message?: string): void;

  /**
   * Forcefully destroy the connection
   */
  abstract destroy(): void;

  /**
   * Get socket metadata (local/remote ports and addresses)
   */
  abstract get socketMeta(): {
    localPort: number;
    localAddress: string;
    remotePort: number;
    remoteAddress: string;
  } | null;

  /**
   * Check if the connection is currently active and writable
   */
  abstract get connected(): boolean;
}