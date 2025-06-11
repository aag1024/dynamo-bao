{@tutorial 08-multi-tenancy}

# Multi-Tenancy in DynamoBao

DynamoBao provides built-in support for multi-tenancy using a pool model approach, where all tenants share the same DynamoDB table with tenant-prefixed keys for complete data isolation.

## Overview

Multi-tenancy in DynamoBao allows you to:
- Isolate data between different tenants in the same DynamoDB table
- Maintain a single codebase for all tenants
- Ensure complete data separation with no cross-tenant data access
- Leverage existing test isolation patterns for production use

## Enabling Multi-Tenancy

To enable multi-tenancy, update your configuration:

```javascript
// dynamo-bao.config.js
module.exports = {
  aws: {
    region: "us-east-1",
  },
  db: {
    tableName: "my-app-table",
  },
  tenancy: {
    enabled: true,  // Enable multi-tenancy
  },
  // ... other config
};
```

## Setting Tenant Context

When tenancy is enabled, you must provide a tenant context before performing any database operations. DynamoBao provides concurrency-safe tenant management using Node.js AsyncLocalStorage.

### 1. Recommended: Using runWithTenant (Concurrency-Safe)

```javascript
const { TenantContext } = require("dynamo-bao");

// Run operations within a tenant context (concurrency-safe)
await TenantContext.runWithTenant("tenant-123", async () => {
  const users = await User.queryByIndex("byStatus", "active");
  const user = await User.create({
    name: "John Doe",
    email: "john@tenant123.com"
  });
});
```

### 2. Cross-Tenant Operations

```javascript
// Safely switch tenant context for admin operations
const adminService = {
  async getTenantStats(tenantId) {
    return await TenantContext.withTenant(tenantId, async () => {
      const activeUsers = await User.queryByIndex("byStatus", "active");
      return {
        tenantId,
        userCount: activeUsers.items.length
      };
    });
  }
};
```

### 3. Direct Tenant Setting (Backward Compatibility)

```javascript
const { TenantContext } = require("dynamo-bao");

// Set tenant for the current context (simple use cases)
TenantContext.setCurrentTenant("tenant-123");

// Now all operations will be scoped to tenant-123
const users = await User.queryByIndex("byStatus", "active");
```

### 4. Tenant Resolvers

For applications where tenant context can be determined automatically:

```javascript
const { TenantContext } = require("dynamo-bao");

// Add resolvers that will be tried in order
TenantContext.addResolver(() => {
  // Try to get tenant from request headers
  return getCurrentRequest()?.headers['x-tenant-id'];
});

TenantContext.addResolver(() => {
  // Fall back to user's tenant
  const user = getCurrentUser();
  return user?.tenantId;
});

// Tenant will be resolved automatically
await TenantContext.runWithTenant(null, async () => {
  const users = await User.queryByIndex("byStatus", "active");
});
```

## Integration Examples

### Express.js Middleware (Concurrency-Safe)

```javascript
const express = require('express');
const { TenantContext, initModels } = require('dynamo-bao');

const app = express();

// Initialize models once at startup
const manager = initModels({
  tenancy: { enabled: true }
});

// Set up tenant resolvers for automatic resolution
TenantContext.addResolver(() => {
  return getCurrentRequest()?.headers['x-tenant-id'];
});

TenantContext.addResolver(() => {
  return getCurrentUser()?.tenantId;
});

// Middleware to run each request in tenant context
app.use((req, res, next) => {
  setCurrentRequest(req);
  
  const tenantId = req.headers['x-tenant-id'] || req.user?.tenantId;
  
  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context required' });
  }
  
  // Run the entire request within tenant context (concurrency-safe)
  TenantContext.runWithTenant(tenantId, () => {
    next();
  });
});

// Routes automatically use correct tenant context
app.get('/api/users', async (req, res) => {
  // This will see the correct tenant even with concurrent requests
  const users = await User.queryByIndex('byStatus', 'active');
  res.json(users.items);
});

// No need to clear tenant - AsyncLocalStorage handles cleanup automatically
```

### AWS Lambda (Async Context Safe)

```javascript
const { TenantContext, initModels } = require('dynamo-bao');

// Initialize outside handler for reuse
const manager = initModels({
  tenancy: { enabled: true }
});

exports.handler = async (event) => {
  const tenantId = event.requestContext.authorizer?.tenantId || 
                   event.headers['x-tenant-id'];
  
  if (!tenantId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Tenant context required' })
    };
  }
  
  // Run entire handler within tenant context (concurrency-safe)
  return TenantContext.runWithTenant(tenantId, async () => {
    try {
      const users = await User.queryByIndex('byStatus', 'active');
      
      return {
        statusCode: 200,
        body: JSON.stringify(users.items)
      };
    } catch (error) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: error.message })
      };
    }
  });
  // No need to manually clear tenant - AsyncLocalStorage handles cleanup
};
```

### Background Jobs / Cron

```javascript
const { TenantContext } = require('dynamo-bao');

async function processTenantData(tenantId) {
  try {
    TenantContext.setCurrentTenant(tenantId);
    
    // Process data for this tenant
    const expiredSubscriptions = await Subscription.queryByIndex(
      'byStatus', 
      'expired'
    );
    
    for (const sub of expiredSubscriptions.items) {
      await sub.delete();
    }
    
  } finally {
    TenantContext.clearTenant();
  }
}

// Process multiple tenants
async function processAllTenants() {
  const tenants = ['tenant-1', 'tenant-2', 'tenant-3'];
  
  for (const tenantId of tenants) {
    await processTenantData(tenantId);
  }
}
```

## Cross-Tenant Operations

For operations across multiple tenants (e.g., admin functions), use `withTenant()` for safe tenant context switching:

```javascript
const adminService = {
  async getTenantStats(tenantId) {
    // Safe cross-tenant operation - doesn't affect current request context
    return await TenantContext.withTenant(tenantId, async () => {
      const userCount = await User.count();
      const activeSubscriptions = await Subscription.queryByIndex(
        'byStatus', 
        'active', 
        null, 
        { countOnly: true }
      );
      
      return {
        tenantId,
        userCount: userCount.count,
        activeSubscriptions: activeSubscriptions.count
      };
    });
  },
  
  async compareTenants(tenant1Id, tenant2Id) {
    // Multiple tenant operations in parallel (concurrency-safe)
    const [tenant1Stats, tenant2Stats] = await Promise.all([
      TenantContext.withTenant(tenant1Id, async () => {
        const users = await User.queryByIndex('byStatus', 'active');
        return { tenantId: tenant1Id, userCount: users.items.length };
      }),
      TenantContext.withTenant(tenant2Id, async () => {
        const users = await User.queryByIndex('byStatus', 'active');
        return { tenantId: tenant2Id, userCount: users.items.length };
      })
    ]);

    return { tenant1Stats, tenant2Stats };
  },
  
  async getAllTenantsStats() {
    const tenants = await this.getAllTenantIds();
    
    // Process tenants in parallel safely
    const stats = await Promise.all(
      tenants.map(tenantId => this.getTenantStats(tenantId))
    );
    
    return stats;
  }
};

// Usage in request handler
app.get('/admin/tenant-comparison', async (req, res) => {
  const { tenant1, tenant2 } = req.query;
  
  // This operation won't interfere with the current request's tenant context
  const comparison = await adminService.compareTenants(tenant1, tenant2);
  
  res.json(comparison);
});
```

## Testing with Multi-Tenancy

The test utilities have been updated to support tenant-based isolation:

```javascript
const { initTestModelsWithTenant, cleanupTestData } = require('./test/utils/test-utils');
const { ulid } = require('ulid');

describe('User Service', () => {
  let tenantId;
  
  beforeEach(async () => {
    // Use a unique tenant ID for test isolation
    tenantId = ulid();
    
    // Initialize models with tenant context
    const manager = initTestModelsWithTenant(testConfig, tenantId);
    
    // Clean up any existing test data
    await cleanupTestData(tenantId);
    
    User = manager.getModel('User');
  });
  
  afterEach(async () => {
    TenantContext.clearTenant();
    await cleanupTestData(tenantId);
  });
  
  test('should create user in tenant context', async () => {
    const user = await User.create({
      name: 'Test User',
      email: 'test@example.com'
    });
    
    expect(user.exists()).toBe(true);
    
    // User is automatically scoped to the test tenant
  });
});
```

## Concurrency Safety

DynamoBao's multi-tenancy uses Node.js AsyncLocalStorage to ensure tenant isolation in concurrent environments. This prevents race conditions that could cause tenant data leakage.

### Why AsyncLocalStorage?

```javascript
// ❌ UNSAFE: Static variables cause race conditions
static _currentTenant = 'tenant-a';  // Request 1 sets this
// ... async operation ...
static _currentTenant = 'tenant-b';  // Request 2 overwrites it!
// Request 1 now sees tenant-b data! 🐛

// ✅ SAFE: AsyncLocalStorage maintains per-request context
TenantContext.runWithTenant('tenant-a', async () => {
  // Request 1 operations - always sees tenant-a
  await someAsyncOperation();
  const users = await User.find(); // Always tenant-a data
});

TenantContext.runWithTenant('tenant-b', async () => {
  // Request 2 operations - always sees tenant-b  
  await someAsyncOperation();
  const users = await User.find(); // Always tenant-b data
});
```

### Requirements

- **Node.js 12.17.0+** for AsyncLocalStorage support
- Use `runWithTenant()` for production applications with concurrent requests
- Use `setCurrentTenant()` for simple use cases and tests

## Best Practices

### 1. Use runWithTenant for Production

Always use `runWithTenant()` for concurrent applications to ensure tenant safety:

```javascript
// ✅ Recommended for production
app.use((req, res, next) => {
  const tenantId = getTenantFromRequest(req);
  TenantContext.runWithTenant(tenantId, () => {
    next();
  });
});
```

### 2. Backward Compatibility Support

`setCurrentTenant()` still works for simple use cases and maintains backward compatibility:

```javascript
// ✅ OK for tests and simple scripts
TenantContext.setCurrentTenant(tenantId);
const users = await User.find();
TenantContext.clearTenant();
```

### 3. Validate Tenant Context Early

When tenancy is enabled, operations will fail if no tenant context is set. Validate early in your request pipeline:

```javascript
// This will throw if tenancy.enabled: true but no tenant is set
const manager = initModels(config);
```

### 4. Use Tenant Resolvers for Complex Apps

For applications with complex authentication, use resolvers to automatically determine tenant context:

```javascript
// Add multiple resolvers for fallback
TenantContext.addResolver(() => getFromAuthToken());
TenantContext.addResolver(() => getFromRequestHeader());
TenantContext.addResolver(() => getFromUserSession());
```

### 5. Secure Tenant IDs

Never trust client-provided tenant IDs without validation. Always verify the tenant ID against the authenticated user's permissions:

```javascript
app.use(async (req, res, next) => {
  const requestedTenant = req.headers['x-tenant-id'];
  const userTenants = await getUserTenants(req.user.id);
  
  if (!userTenants.includes(requestedTenant)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  TenantContext.runWithTenant(requestedTenant, () => {
    next();
  });
});
```

## Migration from testId

If you're already using `testId` for test isolation, the migration to tenant-based isolation is straightforward:

**Before:**
```javascript
const manager = dynamoBao.initModels({
  ...config,
  testId: testId,
});
```

**After:**
```javascript
TenantContext.setCurrentTenant(tenantId);
const manager = dynamoBao.initModels({
  ...config,
  tenancy: { enabled: true }
});
```

The key formatting remains the same - `[testId]#modelPrefix#value` becomes `[tenantId]#modelPrefix#value`.

## Limitations and Considerations

1. **Single Table Design**: Multi-tenancy in DynamoBao uses a pool model where all tenants share the same table. This is ideal for most SaaS applications but may not suit applications requiring physical isolation.

2. **Tenant ID in Keys**: Tenant IDs are prefixed to all keys, so choose tenant IDs wisely. They should be:
   - Unique and immutable
   - Reasonably short to minimize storage
   - Safe for use in DynamoDB keys (no special characters)

3. **No Cross-Tenant Queries**: By design, you cannot query across tenants in a single operation. This ensures complete isolation but means admin operations must iterate through tenants.

4. **GSI Considerations**: All Global Secondary Indexes are also tenant-scoped, ensuring complete isolation across all access patterns.

## Summary

DynamoBao's multi-tenancy support provides:
- Complete data isolation between tenants
- Flexible tenant resolution strategies  
- Easy integration with web frameworks and serverless
- Reuse of existing test isolation patterns
- Zero configuration changes to models

By leveraging the same patterns used for test isolation, DynamoBao makes it simple to add multi-tenancy to your application while maintaining complete data separation and security.