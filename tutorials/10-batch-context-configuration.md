# Batch Context Configuration

DynamoBao provides flexible batch context behavior that can be configured based on your application's needs. This tutorial covers how to configure and use the batch context system for optimal performance and safety.

## Overview

The batch context system in DynamoBao enables:

- **Efficient batching**: Multiple database operations are combined into fewer requests
- **Automatic caching**: Results are cached within the same request context
- **Request isolation**: Ensures data doesn't leak between concurrent requests
- **Flexible enforcement**: Configure whether batch context is required or optional

## Configuration Options

Add the `batchContext` configuration to your config file:

```javascript
// config.js or dynamo-bao.config.js
module.exports = {
  aws: {
    region: "us-west-2",
  },
  db: {
    tableName: "your-table-name",
  },
  batchContext: {
    requireBatchContext: false, // Default: allow fallback behavior
  },
  // ... other config
};
```

## Behavior Modes

### Default Mode (`requireBatchContext: false`)

**Best for**: Production environments, gradual migration, maximum flexibility

```javascript
const manager = initModels({
  batchContext: { requireBatchContext: false },
});

// Works with direct execution (no batching/caching)
const user = await User.find("user123");

// Also works with batching + caching
await runWithBatchContext(async () => {
  const user = await User.find("user123");
});
```

**Behavior**:

- Operations inside `runWithBatchContext`: Full batching and caching enabled
- Operations outside `runWithBatchContext`: Direct execution without batching or caching
- No errors thrown, maximum backward compatibility

### Strict Mode (`requireBatchContext: true`)

**Best for**: Development, testing, ensuring consistent batch context usage

```javascript
const manager = initModels({
  batchContext: { requireBatchContext: true },
});

// This throws an error
await User.find("user123");
// Error: Batch operations must be executed within runWithBatchContext()

// This works
await runWithBatchContext(async () => {
  const user = await User.find("user123"); // ✅
});
```

**Behavior**:

- Operations inside `runWithBatchContext`: Full batching and caching enabled
- Operations outside `runWithBatchContext`: Throws an error
- Ensures all database operations use proper batch context

## Context Detection API

You can check if code is currently running within a batch context:

```javascript
const { User } = require("./models/user");

// Check if inside batch context
const isInBatchContext = User.isInsideBatchContext();

if (isInBatchContext) {
  console.log("Running with batching enabled");
  // Can use advanced batching features
} else {
  console.log("Running in direct execution mode");
  // Operations will be direct database calls
}
```

## Environment Variable Support

Configure batch context behavior via environment variables:

```bash
# Enable strict mode globally
export DYNAMO_BAO_REQUIRE_BATCH_CONTEXT=true

# Your application will now require runWithBatchContext for all operations
node your-app.js
```

This is particularly useful for:

- **Development/Testing**: Use strict mode to catch missing batch contexts early
- **Production**: Use default mode for maximum flexibility
- **CI/CD**: Different environments can have different enforcement levels

## Usage Patterns

### Web Application with Express.js

```javascript
const express = require("express");
const { runWithBatchContext, initModels } = require("dynamo-bao");

const app = express();

// Initialize with development-friendly strict mode
const manager = initModels({
  batchContext: {
    requireBatchContext: process.env.NODE_ENV === "development",
  },
});

// Middleware to wrap requests in batch context
app.use((req, res, next) => {
  runWithBatchContext(() => {
    next();
  });
});

// Routes automatically benefit from batching
app.get("/api/users/:id/dashboard", async (req, res) => {
  const { User, Post } = manager.models;

  // These operations will be batched and cached
  const user = await User.find(req.params.id);
  const posts = await user.queryPosts();

  // Load related data efficiently
  await Promise.all(
    posts.items.map((post) => post.loadRelatedData(["userId"])),
  );

  res.json({ user, posts: posts.items });
});
```

### AWS Lambda Functions

```javascript
const { runWithBatchContext, initModels } = require("dynamo-bao");

// Configure based on environment
const manager = initModels({
  batchContext: {
    requireBatchContext: process.env.STAGE === "dev", // Strict in dev, flexible in prod
  },
});

exports.handler = async (event) => {
  return runWithBatchContext(async () => {
    const { User, Order } = manager.models;

    // Efficient batch operations
    const userId = event.pathParameters.userId;
    const user = await User.find(userId);
    const orders = await user.queryOrders();

    return {
      statusCode: 200,
      body: JSON.stringify({ user, orders: orders.items }),
    };
  });
};
```

### Background Jobs

```javascript
const { runWithBatchContext } = require("dynamo-bao");

async function processUserEmails() {
  await runWithBatchContext(async () => {
    const { User } = manager.models;

    // Iterate through users efficiently
    for await (const batch of User.iterateAll({ batchSize: 100 })) {
      await Promise.all(
        batch.map(async (user) => {
          if (user.emailPreferences.notifications) {
            await sendNotificationEmail(user);
          }
        }),
      );
    }
  });
}
```

## Migration Strategies

### Gradual Migration from Direct Calls

**Step 1**: Start with default mode (no errors)

```javascript
// config.js
module.exports = {
  batchContext: { requireBatchContext: false }, // Start permissive
};
```

**Step 2**: Wrap critical paths

```javascript
// Start with high-traffic endpoints
app.get("/api/dashboard", async (req, res) => {
  await runWithBatchContext(async () => {
    // Your existing code here - now with batching!
  });
});
```

**Step 3**: Enable detection and monitoring

```javascript
app.use((req, res, next) => {
  const isInBatch = User.isInsideBatchContext();
  if (!isInBatch) {
    console.warn(`Route ${req.path} not using batch context`);
  }
  next();
});
```

**Step 4**: Gradually enable strict mode

```javascript
// config.js
module.exports = {
  batchContext: {
    requireBatchContext: process.env.NODE_ENV === "development",
  },
};
```

## Performance Considerations

### With Batch Context (Recommended)

```javascript
await runWithBatchContext(async () => {
  // These 10 finds become 1 DynamoDB BatchGet operation
  const users = await Promise.all([
    User.find("user1"),
    User.find("user2"),
    // ... 8 more
  ]);

  // Subsequent finds for same users return cached instances
  const user1Again = await User.find("user1"); // Returns same object
  expect(user1Again).toBe(users[0]); // Same object reference
});
```

### Without Batch Context (Direct Mode)

```javascript
// These become 10 separate DynamoDB Get operations
const users = await Promise.all([
  User.find("user1"), // Individual DynamoDB call
  User.find("user2"), // Individual DynamoDB call
  // ... 8 more individual calls
]);

// No caching - each find creates a new request
const user1Again = await User.find("user1"); // Another DynamoDB call
expect(user1Again).not.toBe(users[0]); // Different object instances
```

## Best Practices

1. **Use strict mode in development** to catch missing batch contexts early
2. **Use default mode in production** for maximum deployment flexibility
3. **Always wrap request handlers** with `runWithBatchContext` for optimal performance
4. **Monitor batch context usage** in production to identify optimization opportunities
5. **Use environment variables** to configure behavior per environment
6. **Gradually migrate** existing codebases using the permissive default mode

## Error Handling

When `requireBatchContext: true`, operations outside batch context throw descriptive errors:

```javascript
try {
  await User.find("user123"); // Outside batch context
} catch (error) {
  console.log(error.message);
  // "Batch operations must be executed within runWithBatchContext().
  //  Wrap your database operations in runWithBatchContext() to enable batching and caching."
}
```

## Integration with Other Features

### Multi-Tenancy

Batch context works seamlessly with multi-tenancy:

```javascript
await TenantContext.runWithTenant("tenant-123", async () => {
  await runWithBatchContext(async () => {
    // Operations are both tenant-scoped AND batched
    const users = await User.queryByIndex("byStatus", "active");
  });
});
```

### Testing

Batch context is perfect for test isolation:

```javascript
// Each test gets its own isolated batch context
test("user creation", async () => {
  await runWithBatchContext(async () => {
    const user = await User.create({ name: "Test User" });
    expect(user.name).toBe("Test User");
  });
});
```
