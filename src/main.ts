/**
 * Gateway Entry Point
 *
 * Main entry point for the IRC gateway server.
 * Handles initialization, configuration from environment variables,
 * and graceful shutdown.
 */

import { Gateway } from './gateway.js';
import { loadConfig, type Config } from './config.js';
import * as logger from './logger.js';

// ============================================================================
// Exports
// ============================================================================

export { Gateway } from './gateway.js';
export { loadConfig, getConfig, type Config } from './config.js';

// ============================================================================
// Gateway Factory
// ============================================================================

/**
 * Create and start a gateway server with the given configuration
 *
 * @param config - Partial configuration (will be merged with defaults)
 * @returns The running gateway instance
 */
export function startGateway(config: Partial<Config> = {}): Gateway {
  loadConfig(config);
  const gateway = new Gateway();
  gateway.start();
  return gateway;
}

// ============================================================================
// CLI Entry Point
// ============================================================================

/**
 * Check if this module is being run directly (not imported)
 */
function isRunDirectly(): boolean {
  const scriptPath = process.argv[1] ?? '';
  return scriptPath.includes('gateway') || scriptPath.includes('server');
}

/**
 * Parse configuration from environment variables
 */
function getConfigFromEnvironment(): Partial<Config> {
  return {
    port: parseIntOrUndefined(process.env.PORT),
    host: process.env.HOST,
    path: process.env.PATH_PREFIX,
    webircPassword: process.env.WEBIRC_PASSWORD,
    webircGateway: process.env.WEBIRC_GATEWAY,
    allowedServers: parseAllowedServers(process.env.ALLOWED_SERVERS),
    trustProxy: process.env.TRUST_PROXY === 'true',
  };
}

/**
 * Parse a string to integer, returning undefined if invalid
 */
function parseIntOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? undefined : parsed;
}

/**
 * Parse comma-separated server list
 */
function parseAllowedServers(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  return value.split(',').map((server) => server.trim()).filter(Boolean);
}

/**
 * Set up graceful shutdown handlers
 */
function setupShutdownHandlers(gateway: Gateway): void {
  const handleShutdown = (): void => {
    logger.info('Received shutdown signal...');
    gateway.stop();
    process.exit(0);
  };

  // Handle Ctrl+C
  process.on('SIGINT', handleShutdown);

  // Handle termination signal (e.g., from systemd)
  process.on('SIGTERM', handleShutdown);
}

// ============================================================================
// Auto-start when run directly
// ============================================================================

if (isRunDirectly()) {
  const config = getConfigFromEnvironment();
  const gateway = startGateway(config);
  setupShutdownHandlers(gateway);
}
