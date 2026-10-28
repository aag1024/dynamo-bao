const { AsyncLocalStorage } = require('async_hooks');

// Lazy getter to avoid circular dependency
let _ModelManager = null;
function getModelManager() {
  if (!_ModelManager) {
    // Use require since this is called at runtime, not module load time
    const { ModelManager } = require('./model-manager');
    _ModelManager = ModelManager;
  }
  return _ModelManager;
}

function getBatchContextStore() {
  return require('./mixins/batch-loading-mixin').getBatchContextStore();
}

/**
 * @class TenantContext
 * @description Manages tenant context for multi-tenant applications using DynamoBao.
 * Provides runtime tenant resolution and instance management with concurrency safety.
 */
class TenantContext {
  static _asyncStorage = new AsyncLocalStorage();
  static _resolvers = [];
  // Process-wide tenant, set by setCurrentTenant() outside any request
  // context (scripts and tests). Never consulted inside runWithTenant().
  static _fallbackTenant = null;

  /**
   * Sets the current tenant ID and returns the associated ModelManager instance.
   *
   * Inside runWithTenant() or runWithBatchContext() the tenant is set for that
   * context only. Outside both, it sets a process-wide tenant, which is only
   * appropriate for scripts and tests: concurrent requests that have no tenant
   * of their own would see it.
   * @param {string} tenantId - The tenant identifier
   * @returns {ModelManager} The ModelManager instance for the tenant
   */
  static setCurrentTenant(tenantId) {
    const store = this._asyncStorage.getStore();
    const batchStore = getBatchContextStore();
    if (store) {
      store.tenantId = tenantId;
    } else if (batchStore) {
      batchStore.tenantId = tenantId;
    } else {
      this._fallbackTenant = tenantId;
    }
    return this.getInstance(tenantId);
  }

  /**
   * Sets the process-wide tenant regardless of the current context. Meant for
   * scripts, jobs and tests that handle one tenant at a time; never call it
   * from request handling code.
   * @param {string|null} tenantId - The tenant identifier, or null to clear it
   * @returns {ModelManager} The ModelManager instance for the tenant
   */
  static setDefaultTenant(tenantId) {
    this._fallbackTenant = tenantId || null;
    return this.getInstance(tenantId);
  }

  /**
   * Gets the current tenant ID. Checked in order: the runWithTenant() context,
   * a tenant set inside the current batch context, resolvers, and finally the
   * process-wide tenant (only outside runWithTenant()).
   * @returns {string|null} The current tenant ID or null if not found
   */
  static getCurrentTenant() {
    const store = this._asyncStorage.getStore();
    if (store?.tenantId) {
      return store.tenantId;
    }

    const batchTenant = getBatchContextStore()?.tenantId;
    if (batchTenant) {
      return batchTenant;
    }

    for (const resolver of this._resolvers) {
      const tenantId = resolver();
      if (tenantId) {
        return tenantId;
      }
    }

    // runWithTenant() is an explicit request scope; a process-wide tenant
    // must not leak into it.
    if (store) {
      return null;
    }

    return this._fallbackTenant || null;
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
    const ModelManager = getModelManager();
    return ModelManager.forTenant(tenantId || this.getCurrentTenant());
  }

  /**
   * Clears the current tenant. Inside runWithTenant() or runWithBatchContext()
   * this clears only that context's tenant; outside both it clears the
   * process-wide tenant.
   */
  static clearTenant() {
    const store = this._asyncStorage.getStore();
    const batchStore = getBatchContextStore();
    if (store) {
      delete store.tenantId;
    }
    if (batchStore) {
      batchStore.tenantId = null;
    }
    if (!store && !batchStore) {
      this._fallbackTenant = null;
    }
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
    this._resolvers = [];
    this._fallbackTenant = null;
    
    // Clear any async storage context
    this.clearTenant();
    
    // Also clear ModelManager instances to ensure clean state
    const ModelManager = getModelManager();
    if (ModelManager._instances) {
      ModelManager._instances.clear();
    }
    ModelManager._primary = null;
  }
}

module.exports = { TenantContext };