const colors = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  green: '\x1b[32m',
};

const ts = () => new Date().toISOString();

export const debug = (msg: string) => console.log(`${colors.gray}${ts()} ${msg}${colors.reset}`);
export const info = (msg: string) => console.log(`${colors.cyan}${ts()} ${msg}${colors.reset}`);
export const warn = (msg: string) => console.warn(`${colors.yellow}${ts()} ${msg}${colors.reset}`);
export const error = (msg: string) => console.error(`${colors.red}${ts()} ${msg}${colors.reset}`);
export const success = (msg: string) => console.log(`${colors.green}${ts()} ${msg}${colors.reset}`);
