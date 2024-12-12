const { defaultLogger: logger } = require('./utils/logger');

class PluginManager {
  constructor() {
    this.plugins = new Map(); // modelName -> plugins[]
  }

  registerPlugin(modelName, plugin) {
    if (!this.plugins.has(modelName)) {
      this.plugins.set(modelName, []);
    }
    logger.debug(`Registering plugin for model ${modelName}`, plugin);
    this.plugins.get(modelName).push(plugin);
  }

  async executeHooks(modelName, hookName, ...args) {
    const plugins = this.plugins.get(modelName) || [];
    for (const plugin of plugins) {
      if (typeof plugin[hookName] === 'function') {
        logger.debug(`Executing ${hookName} hook for ${modelName}`);
        await plugin[hookName](...args);
      }
    }
  }
}

// Singleton instance
const pluginManager = new PluginManager();
module.exports = { pluginManager }; 