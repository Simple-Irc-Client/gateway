/**
 * Gateway Configuration
 *
 * Manages configuration settings for the IRC gateway server.
 * Supports both programmatic configuration and environment variables.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Gateway configuration options
 */
export interface Config {
  /** Port to listen on (default: 8667) */
  port: number;

  /** Host/IP to bind to (default: 0.0.0.0 for all interfaces) */
  host: string;

  /** WebSocket path for client connections (default: /webirc) */
  path: string;

  /** Maximum number of simultaneous client connections (default: 1000) */
  maxClients: number;

  /** Maximum connections allowed per IP address (default: 10) */
  maxConnectionsPerIp: number;

  /** WEBIRC password for authenticating with IRC servers */
  webircPassword?: string;

  /** WEBIRC gateway name identifier */
  webircGateway?: string;

  /** List of allowed IRC servers (format: "host:port"). Empty = allow all */
  allowedServers?: string[];

  /** Trust X-Forwarded-For header for client IP (enable only behind a reverse proxy) */
  trustProxy: boolean;

  /** Default quit message when clients disconnect */
  quitMessage: string;

  /** Default realname for IRC connections */
  realname: string;
}

// ============================================================================
// Default Configuration
// ============================================================================

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Config = {
  port: 8667,
  host: '0.0.0.0',
  path: '/webirc',
  maxClients: 1000,
  maxConnectionsPerIp: 10,
  trustProxy: false,
  quitMessage: 'Simple IRC Client',
  realname: 'Simple IRC Client user',
};

// ============================================================================
// Configuration State
// ============================================================================

/** Current active configuration */
let currentConfig: Config = { ...DEFAULT_CONFIG };

// ============================================================================
// Configuration Functions
// ============================================================================

/**
 * Load configuration from partial config object
 *
 * Merges provided values with defaults. Only non-undefined values
 * from the input will override defaults.
 *
 * @param partialConfig - Partial configuration to merge
 * @returns The merged configuration
 */
export function loadConfig(partialConfig: Partial<Config> = {}): Config {
  // Filter out undefined values to prevent them from overwriting defaults
  const definedEntries = Object.entries(partialConfig).filter(
    ([, value]) => value !== undefined
  );
  const definedValues = Object.fromEntries(definedEntries) as Partial<Config>;

  currentConfig = { ...DEFAULT_CONFIG, ...definedValues };
  return currentConfig;
}

/**
 * Get the current configuration
 *
 * @returns The current active configuration
 */
export function getConfig(): Config {
  return currentConfig;
}
