const { defaultLogger: logger } = require('./utils/logger');

class PluginManager {
  constructor() {
    this.plugins = new Map(); // modelName -> plugins[]
    this.methods = new Map(); // modelName -> Map<methodName, function>
  }

  registerPlugin(modelName, plugin) {
    if (!this.plugins.has(modelName)) {
      this.plugins.set(modelName, []);
    }
    logger.debug(`Registering plugin for model ${modelName}`, plugin);
    this.plugins.get(modelName).push(plugin);

    // Register methods if they exist
    if (plugin.methods) {
      this.registerPluginMethods(modelName, plugin.methods);
    }
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

  applyMethodsToInstance(modelName, instance) {
    const modelMethods = this.methods.get(modelName);
    if (!modelMethods) return;

    for (const [methodName, methodFn] of modelMethods) {
      // Bind the method to the instance
      instance[methodName] = methodFn.bind(instance);
    }
  }

  registerPluginMethods(modelName, methods) {
    if (!this.methods.has(modelName)) {
      this.methods.set(modelName, new Map());
    }
    
    const modelMethods = this.methods.get(modelName);
    Object.entries(methods).forEach(([methodName, methodFn]) => {
      if (modelMethods.has(methodName)) {
        logger.warn(`Method ${methodName} already exists for model ${modelName}. It will be overwritten.`);
      }
      modelMethods.set(methodName, methodFn);
    });
  }
}

// Singleton instance
const pluginManager = new PluginManager();
module.exports = { pluginManager }; 