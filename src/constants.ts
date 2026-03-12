/**
 * Global Constants for IRC Gateway
 *
 * Centralized constants used across the application
 */

// ============================================================================
// Gateway Constants
// ============================================================================

/** Maximum WebSocket messages allowed per rate limit window */
export const RATE_LIMIT_MAX_MESSAGES = 50;

/** Rate limit window duration in milliseconds (5 seconds) */
export const RATE_LIMIT_WINDOW_MS = 5000;

// ============================================================================
// IRC Protocol Constants
// ============================================================================

/** IRC line terminator */
export const IRC_LINE_ENDING = '\r\n';

/** Strip CR/LF from user-supplied values to prevent IRC protocol injection */
export const stripCRLF = (input: string): string => input.replace(/[\r\n]/g, '');

/** Interval for sending PING keepalive messages (30 seconds) */
export const PING_INTERVAL_MS = 30000;

/** Timeout for TCP/TLS connection establishment (30 seconds) */
export const CONNECTION_TIMEOUT_MS = 30000;

/** Default timeout for receiving server response after sending PING (120 seconds) */
export const DEFAULT_PONG_TIMEOUT_MS = 120000;

/** Maximum receive buffer size before dropping the connection (2MB) */
export const MAX_RECEIVE_BUFFER_SIZE = 2 * 1024 * 1024;

/**
 * Pattern to match RPL_WELCOME (001) from a server
 *
 * Format: [:server.name 001 nickname :Welcome message]
 * Or with IRCv3 tags: [@time=... :server.name 001 nickname :Welcome message]
 *
 * - Optional IRCv3 message tags (@key=value;... ) at the start
 * - Server prefix starting with :
 * - Source must not contain ! or @ (those indicate a user hostmask)
 * - Command must be exactly 001
 */
export const RPL_WELCOME_PATTERN = /^(@\S+ )?:[^\s!@]+ 001 /;

// ============================================================================
// Character Encodings
// ============================================================================

/**
 * Allowed character encodings for IRC connections
 */
export const ALLOWED_ENCODINGS = new Set([
  'utf8', 'utf-8', 'ascii', 'latin1', 'iso-8859-1', 'iso-8859-2', 'iso-8859-3',
  'iso-8859-4', 'iso-8859-5', 'iso-8859-6', 'iso-8859-7', 'iso-8859-8',
  'iso-8859-9', 'iso-8859-10', 'iso-8859-13', 'iso-8859-14', 'iso-8859-15',
  'iso-8859-16', 'windows-1250', 'windows-1251', 'windows-1252', 'windows-1253',
  'windows-1254', 'windows-1255', 'windows-1256', 'windows-1257', 'windows-1258',
  'koi8-r', 'koi8-u', 'shift_jis', 'euc-jp', 'euc-kr', 'gb2312', 'gbk', 'gb18030',
  'big5', 'tis-620',
]);