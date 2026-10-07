// Entry point: configures the gateway from environment variables and runs it until SIGINT/SIGTERM

import { Gateway } from './gateway.js';
import { loadConfig, type Config } from './config.js';

const parseInteger = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const parseList = (value: string | undefined): string[] | undefined =>
  value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);

// Unset or invalid values stay undefined, so the defaults apply
function configFromEnvironment(env: NodeJS.ProcessEnv): Partial<Config> {
  return {
    port: parseInteger(env.PORT),
    host: env.HOST,
    path: env.PATH_PREFIX,
    webircPassword: env.WEBIRC_PASSWORD,
    webircGateway: env.WEBIRC_GATEWAY,
    allowedServers: parseList(env.ALLOWED_SERVERS),
    allowedOrigins: parseList(env.ALLOWED_ORIGINS),
    trustProxy: env.TRUST_PROXY === 'true',
    pongTimeout: parseInteger(env.PONG_TIMEOUT),
    wsPingInterval: parseInteger(env.WS_PING_INTERVAL),
    wsPongTimeout: parseInteger(env.WS_PONG_TIMEOUT),
    registrationTimeout: parseInteger(env.REGISTRATION_TIMEOUT),
    identdEnabled: env.IDENTD_ENABLED === 'true' ? true : undefined,
    identdPort: parseInteger(env.IDENTD_PORT),
    identdTimeout: parseInteger(env.IDENTD_TIMEOUT),
  };
}

process.on('unhandledRejection', (reason) => {
  console.error(`[gateway] Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

process.on('uncaughtException', (error) => {
  console.error(`[gateway] Uncaught exception: ${error.stack ?? error.message}`);
  // The process state is undefined now; exit so the supervisor restarts it
  process.exit(1);
});

loadConfig(configFromEnvironment(process.env));
const gateway = new Gateway();

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.info('Received shutdown signal, draining...');
  gateway.stop().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(`Shutdown error: ${(error as Error).message}`);
      process.exit(1);
    }
  );
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Without a bound port the process is useless, so exit and let the supervisor retry
gateway.start().catch((error: unknown) => {
  const { code, message } = error as NodeJS.ErrnoException;
  console.error(`[gateway] Failed to start${code ? ` (${code})` : ''}: ${message}`);
  process.exit(1);
});
