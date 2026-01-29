type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const colors = {
  reset: '\x1b[0m',
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  success: '\x1b[32m',
};

let currentLevel: LogLevel = 'info';

const levels: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function timestamp(): string {
  return new Date().toISOString();
}

function shouldLog(level: LogLevel): boolean {
  return levels[level] >= levels[currentLevel];
}

export function debug(message: string, ...args: unknown[]): void {
  if (shouldLog('debug')) {
    console.log(`${colors.debug}${timestamp()} [DEBUG] ${message}${colors.reset}`, ...args);
  }
}

export function info(message: string, ...args: unknown[]): void {
  if (shouldLog('info')) {
    console.log(`${colors.info}${timestamp()} [INFO] ${message}${colors.reset}`, ...args);
  }
}

export function warn(message: string, ...args: unknown[]): void {
  if (shouldLog('warn')) {
    console.warn(`${colors.warn}${timestamp()} [WARN] ${message}${colors.reset}`, ...args);
  }
}

export function error(message: string, ...args: unknown[]): void {
  if (shouldLog('error')) {
    console.error(`${colors.error}${timestamp()} [ERROR] ${message}${colors.reset}`, ...args);
  }
}

export function success(message: string, ...args: unknown[]): void {
  if (shouldLog('info')) {
    console.log(`${colors.success}${timestamp()} [OK] ${message}${colors.reset}`, ...args);
  }
}

export function irc(direction: 'in' | 'out', clientId: string, line: string): void {
  if (shouldLog('debug')) {
    const arrow = direction === 'in' ? '>>' : '<<';
    const color = direction === 'in' ? colors.info : colors.success;
    console.log(`${color}${timestamp()} [${clientId}] ${arrow} ${line.trim()}${colors.reset}`);
  }
}
