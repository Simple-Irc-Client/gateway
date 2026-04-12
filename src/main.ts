/**
 * Gateway Entry Point
 *
 * Main entry point for the IRC gateway server.
 * Handles initialization, configuration from environment variables,
 * and graceful shutdown.
 */

import { Gateway } from './gateway.js';
import { loadConfig, type Config } from './config.js';

// ============================================================================
// Exports
// ============================================================================

export { Gateway } from './gateway.js';
export { loadConfig, getConfig, type Config } from './config.js';
export { IdentdServer } from './identd.js';

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
    allowedOrigins: parseAllowedServers(process.env.ALLOWED_ORIGINS),
    trustProxy: process.env.TRUST_PROXY === 'true',
    pongTimeout: parseIntOrUndefined(process.env.PONG_TIMEOUT),
    wsPingInterval: parseIntOrUndefined(process.env.WS_PING_INTERVAL),
    wsPongTimeout: parseIntOrUndefined(process.env.WS_PONG_TIMEOUT),
    registrationTimeout: parseIntOrUndefined(process.env.REGISTRATION_TIMEOUT),
    idleTimeout: parseIntOrUndefined(process.env.IDLE_TIMEOUT),
    identdEnabled: process.env.IDENTD_ENABLED === 'true' ? true : undefined,
    identdPort: parseIntOrUndefined(process.env.IDENTD_PORT),
    identdTimeout: parseIntOrUndefined(process.env.IDENTD_TIMEOUT),
  };
}

/**
 * Parse a string to integer, returning undefined if invalid
 */
function parseIntOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
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
  let shuttingDown = false;
  const handleShutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info('Received shutdown signal, draining...');
    gateway
      .stop()
      .then(() => {
        process.exit(0);
      })
      .catch((error: Error) => {
        console.error(`Shutdown error: ${error.message}`);
        process.exit(1);
      });
  };

  // Handle Ctrl+C
  process.on('SIGINT', handleShutdown);

  // Handle termination signal (e.g., from systemd)
  process.on('SIGTERM', handleShutdown);
}

/**
 * Set up process-level safety nets. A stray promise rejection or synchronous
 * throw inside an event handler would otherwise take down the gateway without
 * a log — we want structured output and a clean exit so the supervisor can
 * restart us instead of leaving the process in a half-broken state.
 */
function setupProcessSafetyNets(): void {
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);
    console.error(`[gateway] Unhandled rejection: ${msg}`);
  });

  process.on('uncaughtException', (error) => {
    console.error(`[gateway] Uncaught exception: ${error.message}\n${error.stack ?? ''}`);
    // Exceptions leave the process state undefined — exit so we can be restarted.
    process.exit(1);
  });
}

// ============================================================================
// Auto-start when run directly
// ============================================================================

if (isRunDirectly()) {
  setupProcessSafetyNets();
  const config = getConfigFromEnvironment();
  const gateway = startGateway(config);
  setupShutdownHandlers(gateway);
}
