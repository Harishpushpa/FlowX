// server/utils/securityUtils.js

const SENSITIVE_PATTERNS = [
  /(Bearer\s+)[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/gi, // JWT Tokens
  /(api[_-]?key["':\s=]+)([A-Za-z0-9-_]{8,})/gi,                         // API Keys
  /(password["':\s=]+)([^"'\s,}&]+)/gi,                                  // Passwords
  /(secret["':\s=]+)([^"'\s,}&]+)/gi,                                    // Secrets
  /(mongodb(\+srv)?:\/\/[^"'\s]+)/gi                                     // MongoDB URIs
];

/**
 * Sanitizes strings, logs, or JSON objects to prevent API keys and tokens from leaking.
 */
export function maskSecrets(input) {
  if (!input) return input;
  let str = typeof input === "string" ? input : JSON.stringify(input);
  for (const pattern of SENSITIVE_PATTERNS) {
    str = str.replace(pattern, "$1[REDACTED_SECRET]");
  }
  return typeof input === "object" && typeof input !== "string" ? JSON.parse(str) : str;
}