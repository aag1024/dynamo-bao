// import("dotenv").then(dotenv => dotenv.config());

const userConfig = require("../config");

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
    this.currentLevel = userConfig.logging.level.toUpperCase();
  }

  /**
   * Whether a message at `level` would be printed. Check this before
   * building a log argument that is expensive to compute (a JSON dump, a
   * mapped array), so the cost is only paid when the output is wanted.
   * @param {"ERROR"|"WARN"|"INFO"|"DEBUG"} level
   * @returns {boolean}
   */
  isLevelEnabled(level) {
    return (
      this.currentLevel !== "OFF" &&
      LOG_LEVELS[level] <= LOG_LEVELS[this.currentLevel]
    );
  }

  isDebugEnabled() {
    return this.isLevelEnabled("DEBUG");
  }

  log(level, ...args) {
    if (this.isLevelEnabled(level)) {
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

module.exports = { Logger, defaultLogger };
