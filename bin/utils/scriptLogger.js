const DEBUG = process.env.DEBUG === 'true';

class ScriptLogger {
  constructor(context) {
    this.context = context;
  }

  debug(...args) {
    if (DEBUG) {
      console.log(`[${this.context}]`, ...args);
    }
  }

  warn(...args) {
    console.warn(`[${this.context}]`, ...args);
  }

  error(...args) {
    console.error(`[${this.context}]`, ...args);
  }
}

module.exports = {
  createLogger: (context) => new ScriptLogger(context)
}; 