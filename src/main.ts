import { Gateway } from './gateway.js';
import { loadConfig, type Config } from './config.js';
import * as log from './logger.js';

export { Gateway } from './gateway.js';
export { loadConfig, getConfig, type Config } from './config.js';

export function startGateway(config: Partial<Config> = {}): Gateway {
  loadConfig(config);
  const gateway = new Gateway();
  gateway.start();
  return gateway;
}

// Auto-start when run directly
if (process.argv[1]?.includes('gateway') || process.argv[1]?.includes('server')) {
  const gateway = startGateway({
    port: parseInt(process.env.PORT ?? '8667'),
    host: process.env.HOST,
    path: process.env.PATH_PREFIX,
    webircPassword: process.env.WEBIRC_PASSWORD,
    webircGateway: process.env.WEBIRC_GATEWAY,
    allowedServers: process.env.ALLOWED_SERVERS?.split(','),
  });

  const shutdown = (): void => { log.info('Shutting down...'); gateway.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
