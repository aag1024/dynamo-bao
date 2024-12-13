const createLogger = (name) => {
  return {
    debug: (...args) => console.log(`[${name}]`, ...args),
    info: (...args) => console.log(`[${name}]`, ...args),
    warn: (...args) => console.warn(`[${name}]`, ...args),
    error: (...args) => console.error(`[${name}]`, ...args)
  };
};

module.exports = { createLogger }; 