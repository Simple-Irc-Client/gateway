import { Gateway } from './gateway.js';
import { loadConfig, type GatewayConfig } from './config.js';
import { initEncryption } from './encryption.js';
import * as logger from './logger.js';

export { Gateway } from './gateway.js';
export { loadConfig, getConfig, type GatewayConfig } from './config.js';
export { generateKey } from './encryption.js';
export { setLogLevel } from './logger.js';

export async function startGateway(userConfig: Partial<GatewayConfig> = {}): Promise<Gateway> {
  const config = loadConfig(userConfig);

  if (config.encryption.enabled && config.encryption.key) {
    await initEncryption(config.encryption.key);
    logger.success('Encryption enabled');
  }

  const gateway = new Gateway();
  gateway.start();

  return gateway;
}

// Auto-start if run directly
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('server.ts') ||
  process.argv[1]?.endsWith('main.ts') ||
  process.argv[1]?.endsWith('main.js');

if (isMainModule) {
  const config: Partial<GatewayConfig> = {};

  // Load from environment variables
  if (process.env.GATEWAY_PORT) {
    config.port = parseInt(process.env.GATEWAY_PORT, 10);
  }
  if (process.env.GATEWAY_HOST) {
    config.host = process.env.GATEWAY_HOST;
  }
  if (process.env.GATEWAY_PATH) {
    config.path = process.env.GATEWAY_PATH;
  }
  if (process.env.GATEWAY_ORIGINS) {
    config.allowedOrigins = process.env.GATEWAY_ORIGINS.split(',');
  }
  if (process.env.GATEWAY_ENCRYPTION_KEY) {
    config.encryption = {
      enabled: true,
      key: process.env.GATEWAY_ENCRYPTION_KEY,
    };
  }
  if (process.env.GATEWAY_WEBIRC_PASSWORD) {
    config.webirc = {
      enabled: true,
      password: process.env.GATEWAY_WEBIRC_PASSWORD,
      gateway: process.env.GATEWAY_WEBIRC_NAME ?? 'sic-gateway',
    };
  }
  if (process.env.GATEWAY_LOG_LEVEL) {
    logger.setLogLevel(process.env.GATEWAY_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error');
  }

  const gateway = await startGateway(config);

  process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down...');
    gateway.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down...');
    gateway.stop();
    process.exit(0);
  });
}
