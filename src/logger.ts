/**
 * Logger Module
 *
 * Simple colored console logging with timestamps.
 * Each log level has a distinct color for easy visual identification.
 */

// ============================================================================
// ANSI Color Codes
// ============================================================================

/**
 * ANSI escape codes for terminal colors
 */
const COLORS = {
  /** Reset all formatting */
  reset: '\x1b[0m',
  /** Gray - used for debug messages */
  gray: '\x1b[90m',
  /** Cyan - used for info messages */
  cyan: '\x1b[36m',
  /** Yellow - used for warnings */
  yellow: '\x1b[33m',
  /** Red - used for errors */
  red: '\x1b[31m',
  /** Green - used for success messages */
  green: '\x1b[32m',
} as const;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get current timestamp in ISO format
 */
function getTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Format a log message with timestamp and color
 */
function formatMessage(message: string, color: string): string {
  return `${color}${getTimestamp()} ${message}${COLORS.reset}`;
}

// ============================================================================
// Logging Functions
// ============================================================================

/**
 * Log a debug message (gray)
 *
 * Use for verbose/detailed information useful during development
 */
export function debug(message: string): void {
  console.log(formatMessage(message, COLORS.gray));
}

/**
 * Log an info message (cyan)
 *
 * Use for general informational messages
 */
export function info(message: string): void {
  console.log(formatMessage(message, COLORS.cyan));
}

/**
 * Log a warning message (yellow)
 *
 * Use for potentially problematic situations that don't prevent operation
 */
export function warn(message: string): void {
  console.warn(formatMessage(message, COLORS.yellow));
}

/**
 * Log an error message (red)
 *
 * Use for error conditions that affect operation
 */
export function error(message: string): void {
  console.error(formatMessage(message, COLORS.red));
}

/**
 * Log a success message (green)
 *
 * Use for successful operations (e.g., server started)
 */
export function success(message: string): void {
  console.log(formatMessage(message, COLORS.green));
}
