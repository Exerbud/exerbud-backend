// api/utils/logger.js

const isDev = process.env.NODE_ENV !== "production";

/**
 * Internal log function. Always logs JSON so it's easy to filter in Vercel.
 */
function log(level, message, meta = {}) {
  const entry = {
    level,
    message,
    ...meta,
    timestamp: new Date().toISOString(),
  };

  // Single line JSON for each log entry
  const line = JSON.stringify(entry);

  // We just use console.log so Vercel can capture it.
  // (No secrets or tokens should EVER be logged.)
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }

  // In dev you could also pretty-print if you want, but JSON is fine.
}

/**
 * Info-level log (normal behaviour, metrics, etc.)
 */
function logInfo(message, meta) {
  log("info", message, meta);
}

/**
 * Error-level log (exceptions, API failures, etc.)
 */
function logError(message, meta) {
  log("error", message, meta);
}

module.exports = {
  logInfo,
  logError,
};
