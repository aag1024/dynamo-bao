const { AsyncLocalStorage } = require('async_hooks');

/**
 * @class TenantContext
 * @description Manages tenant context for multi-tenant applications using DynamoBao.
 * Provides runtime tenant resolution and instance management with concurrency safety.
 */
class TenantContext {
  static _asyncStorage = new AsyncLocalStorage();
  static _instances = new Map(); // tenantId -> ModelManager
  static _resolvers = [];
  static _fallbackTenant = null; // For backward compatibility when not in async context

  /**
   * Sets the current tenant ID and returns the associated ModelManager instance.
   * For backward compatibility and simple use cases (like tests).
   * @param {string} tenantId - The tenant identifier
   * @returns {ModelManager} The ModelManager instance for the tenant
   */
  static setCurrentTenant(tenantId) {
    const store = this._asyncStorage.getStore();
    if (store) {
      // We're inside an async context, set the tenant there
      store.tenantId = tenantId;
    } else {
      // We're not in an async context, use fallback
      this._fallbackTenant = tenantId;
    }
    return this.getInstance(tenantId);
  }

  /**
   * Gets the current tenant ID using async context or resolver chain.
   * Concurrency-safe using AsyncLocalStorage.
   * @returns {string|null} The current tenant ID or null if not found
   */
  static getCurrentTenant() {
    // 1. Check async context first (for concurrent request safety)
    const store = this._asyncStorage.getStore();
    if (store?.tenantId) {
      return store.tenantId;
    }

    // 2. Check fallback tenant (for backward compatibility)
    if (this._fallbackTenant) {
      return this._fallbackTenant;
    }

    // 3. Try resolvers in order (for request-scoped resolution)
    for (const resolver of this._resolvers) {
      const tenantId = resolver();
      if (tenantId) {
        return tenantId;
      }
    }

    return null;
  }

  /**
   * Adds a resolver function to determine tenant context.
   * Resolvers are tried in the order they were added.
   * @param {Function} resolver - Function that returns a tenant ID or null
   */
  static addResolver(resolver) {
    if (typeof resolver !== 'function') {
      throw new Error('Resolver must be a function');
    }
    this._resolvers.push(resolver);
  }

  /**
   * Runs a callback function with a specific tenant context.
   * Ensures concurrency safety by using AsyncLocalStorage.
   * @param {string} tenantId - The tenant identifier
   * @param {Function} callback - The function to run with tenant context
   * @returns {Promise} The result of the callback
   */
  static runWithTenant(tenantId, callback) {
    return this._asyncStorage.run({ tenantId }, callback);
  }

  /**
   * Explicit tenant override for cross-tenant operations.
   * Alias for runWithTenant for better readability in cross-tenant scenarios.
   * @param {string} tenantId - The tenant identifier
   * @param {Function} operation - The operation to run with tenant context
   * @returns {Promise} The result of the operation
   */
  static withTenant(tenantId, operation) {
    return this.runWithTenant(tenantId, operation);
  }

  /**
   * Gets or creates a ModelManager instance for the specified tenant.
   * @param {string|null} tenantId - The tenant identifier or null for default
   * @returns {ModelManager} The ModelManager instance
   */
  static getInstance(tenantId = null) {
    const { ModelManager } = require('./model-manager');
    const effectiveTenantId = tenantId || this.getCurrentTenant();
    const key = effectiveTenantId || "default";
    
    if (!this._instances.has(key)) {
      const manager = ModelManager.getInstance(effectiveTenantId);
      this._instances.set(key, manager);
    }
    
    return this._instances.get(key);
  }

  /**
   * Clears the current tenant context.
   * For test cleanup and simple use cases.
   */
  static clearTenant() {
    const store = this._asyncStorage.getStore();
    if (store) {
      delete store.tenantId;
    }
    this._fallbackTenant = null;
  }

  /**
   * Clears all resolver functions.
   */
  static clearResolvers() {
    this._resolvers = [];
  }

  /**
   * Validates that tenant context is available when required by configuration.
   * @param {Object} config - The configuration object
   * @throws {Error} If tenancy is enabled but no tenant context is found
   */
  static validateTenantRequired(config) {
    if (config.tenancy?.enabled && !this.getCurrentTenant()) {
      throw new Error(
        'Tenant context is required when tenancy is enabled. ' +
        'Use TenantContext.runWithTenant(tenantId, callback) or add tenant resolvers.'
      );
    }
  }

  /**
   * Resets all tenant context state (for testing).
   */
  static reset() {
    this._instances.clear();
    this._resolvers = [];
    this._fallbackTenant = null;
    
    // Clear any async storage context
    this.clearTenant();
    
    // Also clear ModelManager instances to ensure clean state
    const { ModelManager } = require('./model-manager');
    if (ModelManager._instances) {
      ModelManager._instances.clear();
    }
  }
}

module.exports = { TenantContext };