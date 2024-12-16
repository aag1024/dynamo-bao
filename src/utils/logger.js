require("dotenv").config();

const LOG_LEVELS = {
  OFF: -1,
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

class Logger {
  constructor(context) {
    this.context = context;
    this.currentLevel = (process.env.LOG_LEVEL || "ERROR").toUpperCase();
  }

  log(level, ...args) {
    if (
      this.currentLevel !== "OFF" &&
      LOG_LEVELS[level] <= LOG_LEVELS[this.currentLevel]
    ) {
      const prefix = `[${level}] ${this.context}:`;
      console.log(prefix, ...args);
    }
  }

  debug(...args) {
    this.log("DEBUG", ...args);
  }
  info(...args) {
    this.log("INFO", ...args);
  }
  warn(...args) {
    this.log("WARN", ...args);
  }
  error(...args) {
    this.log("ERROR", ...args);
  }

  // Create a logger instance with a fixed context
  static getLogger(context) {
    return new Logger(context);
  }
}

// Export a default logger with a generic context
const defaultLogger = new Logger("Default");

module.exports = {
  Logger,
  defaultLogger,
};
