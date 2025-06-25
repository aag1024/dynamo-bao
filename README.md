# DynamoBao

[![GitHub stars](https://img.shields.io/github/stars/aag1024/dynamo-bao.svg?style=social&label=Star)](https://github.com/aag1024/dynamo-bao)
[![npm version](https://badge.fury.io/js/dynamo-bao.svg)](https://badge.fury.io/js/dynamo-bao)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

DynamoBao is a simple lightweight library for building DynamoDB models in JavaScript. I've used
DynamoDB for years and generally love it, but find getting started difficult and repetitive.
DynamoBao is the tool I wish I had when I started.

## Principles

- Expose just enough of Dynamo's features to make it easy to model many common types of data.
- Don't break DynamoDB's superpower of infinite scale with consistent fast performance.
- Use single table design to minimize ops overhead, without adding complexity for the developer.

## Key features

- Model 1:1, 1:N, N:M relationships between objects
- Efficiently load data: load related objects in parallel, cache data using loading contexts
- Minimize race conditions: save diffs, version checks on save, atomic counters
- Enforce unique constraints and use them for lookups
- Built-in multi-tenancy support with complete data isolation and concurrency safety
- Return total read/write consumed capacity (even when multiple operations were performed)
- Easily iterate over all items in a model for batch processing or migrations
- ESM (ECMAScript Modules) support for modern JavaScript projects

## Requirements

- **Node.js 12.17.0+** (for AsyncLocalStorage support in multi-tenant features)
  - Node.js 14+ recommended for native ESM support
- AWS credentials configured for DynamoDB access

## Example 1: Simple model

Step 1 is to define your models in a yaml file. Here's a simple example.

```
models:
  User: {
    modelPrefix: u
    fields:
      userId: {type: UlidField, autoAssign: true, required: true}
      name: {type: StringField, required: true}
      email: {type: EmailField, required: true}
    primaryKey: {partitionKey: userId}
  }
```

Based on this definition, the code generator will create a `User` model in the models directory that you can use like this:

```
const { User } = require("./models/user");
const userConfig = require("./config");
const dynamoBao = require("dynamo-bao");
async function testUserModel() {
  dynamoBao.initModels(userConfig);

  // Create a new user
  const user = new User({
    name: "Test User",
    email: "test@example.com",
  });

  await user.save();
  console.log("Created user:", user);
  console.log("Consumed capacity:", user.getNumericConsumedCapacity());
}

testUserModel();
```

## Example 2: Relationships and unique constraints

```
models:
  User:
    modelPrefix: u    # required short string to identify the model
    fields:
      userId: {type: UlidField, autoAssign: true, required: true}
      name: {type: StringField, required: true}
      email: {type: EmailField, required: true}
    primaryKey: {partitionKey: userId}  # required
    # Add up to 3 unique constraints each with a unique id: uc1, uc2, uc3
    uniqueConstraints: {uniqueEmail: {field: email, uniqueConstraintId: uc1}}
  Post:
    modelPrefix: p
    fields:
      postId: {type: UlidField, autoAssign: true}
      # Enables getUser on a Post object / load related data
      userId: {type: RelatedField, model: User, required: true}
      title: {type: StringField, required: true}
      content: {type: StringField, required: true}
    primaryKey: {partitionKey: postId}
    indexes:
      # Add up to 3 indexes; make sure each index has a unique id: gsi1, gsi2, gsi3
      # Enables user.queryPosts() to query posts for a user
      postsForUser: {partitionKey: userId, sortKey: postId, indexId: gsi2}
```

```
const { User } = require("./models/user");
const { Post } = require("./models/post");
const userConfig = require("./config");
const dynamoBao = require("dynamo-bao");
async function testUserModel() {
  dynamoBao.initModels(userConfig);

  // Create a new user
  const user = new User({
    name: "Test User",
    email: "test@example.com",
  });

  await user.save();
  console.log("Created user:", user.userId);

  // Find user by unique constraint
  const foundUser = await User.findByEmail("test@example.com");
  console.log("Found user by email:", foundUser);


  // Create some test posts for the user
  const post1 = new Post({
    userId: user.userId,
    title: "Test Post 1",
    content: "This is a test post",
  });

  const post2 = new Post({
    userId: user.userId,
    title: "Test Post 2",
    content: "This is another test post",
  });

  await Promise.all([post1.save(), post2.save()]);

  // User now has a queryPosts method (via the postsForUser index)
  const userPosts = await user.queryPosts();
  console.log("User posts:", userPosts.items.length);

  // Or add a filter condition to the query
  const filteredPosts = await user.queryPosts(null, {
    filter: {
      content: {
        $contains: "another"
      }
    }
  });
  console.log("User posts matching filter:", filteredPosts.items.length);
}

testUserModel();
```

### Cloudflare Workers Support

DynamoBao supports Cloudflare Workers with request-scoped batching to ensure proper isolation between concurrent requests. To use DynamoBao in Cloudflare Workers, you'll need to enable Node.js compatibility and wrap your request handlers with the batch context:

```javascript
// wrangler.toml
compatibility_flags = ["nodejs_compat"];
compatibility_date = "2024-09-23";

// worker.js
import { runWithBatchContext } from "dynamo-bao";
import { User } from "./models/user.js";

export default {
  async fetch(request, env, ctx) {
    return runWithBatchContext(async () => {
      // All batching operations are now request-scoped
      const user = await User.find(userId);
      // Additional database operations...
      return new Response(JSON.stringify(user));
    });
  },
};
```

**Request Isolation**:

- **With `runWithBatchContext`**: Each request gets its own isolated batch context with optimal batching performance
- **Without `runWithBatchContext`**: Batching is automatically disabled for safety to prevent cross-request interference, with a warning logged. While this ensures request isolation, you'll lose batching efficiency benefits.

For production Cloudflare Workers deployments, always use `runWithBatchContext` to get both safety and performance.

### Iterating over all items

DynamoBao makes it easy to iterate over all items in a model, which is useful for tasks like data migration, backfills, or reporting.

By default, all models are created with `iterable: true`. This automatically sets up a dedicated index that allows you to use the `iterateAll()` method on the model class.

```javascript
// Iterate over all posts, 100 at a time
for await (const batch of Post.iterateAll({ batchSize: 100 })) {
  for (const post of batch) {
    console.log(post.title);
  }
}
```

**Cost and Performance**

This convenience comes at a cost: every `create`, `update`, or `delete` operation on an iterable model requires a second write to the database to maintain the iteration index. This doubles the write cost for every item.

To prevent "hot partitions" on large models, the iteration index is automatically split into 10 "buckets" or partitions. The `iterateAll()` method handles fetching from all buckets seamlessly.

**Opting Out**

For high-volume, write-heavy models where you know you will never need to iterate (e.g., logging tables), you can disable this feature to save costs:

```yaml
models:
  AnalyticsEvent:
    modelPrefix: "ae"
    iterable: false # Disabling iteration for this write-heavy model
    fields:
      # ...
```

## Installation / Quick Start

Make sure you have [AWS credentials setup in your environment](https://medium.com/@simonazhangzy/installing-and-configuring-the-aws-cli-7d33796e4a7c). You'll also need [node and npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm) installed.

Create a project and setup some models. You'll also need to install DynamoBao locally in your project.

```
mkdir your-project
cd your-project
npm install dynamo-bao
```

Create a new Dynamo table for your project. You should have one table per project.

```
npx bao-init
```

This creates a `config.js` which contains settings for your project like AWS region and the table name.

It also creates a `models.yaml` file with a simple example model, and a `models` directory where
the generated models will be stored.

Edit your `models.yaml` file to define these models.

```
models:
  User:
    modelPrefix: u   # required short string to identify the model
    fields:
      userId: { type: UlidField, autoAssign: true, required: true }
      name: { type: StringField, required: true }
      email: { type: StringField, required: true }
      profilePictureUrl: { type: StringField }
      createdAt: { type: CreateDateField }
      modifiedAt: { type: ModifiedDateField }
      role: { type: StringField }
    primaryKey:
      partitionKey: userId
    uniqueConstraints:
      # Enforces unique constraint on email field and enables User.findByEmail()
      uniqueEmail: { field: email, uniqueConstraintId: uc1 }

  Post:
    modelPrefix: p   # required short string to identify the model
    fields:
      postId: { type: UlidField, autoAssign: true }
      userId: { type: RelatedField, model: User, required: true }
      title: { type: StringField, required: true }
      content: { type: StringField, required: true }
      createdAt: { type: CreateDateField }
      version: { type: VersionField }
    primaryKey:
      partitionKey: postId
    indexes:
      # Enables user.queryPosts() to query posts for a user
      postsForUser: { partitionKey: userId, sortKey: createdAt, indexId: gsi2 }
```

Run the code generator to create the models. You can also run `npx bao-watch` to automatically regenerate the models when you make changes.

```
npx bao-codegen
```

You should now have generated models in the `models` directory.

### ESM Support

DynamoBao supports generating models as ESM (ECMAScript Modules) for modern JavaScript projects. To enable ESM code generation, add the `codegen` configuration to your `config.js`:

```javascript
// config.js
module.exports = {
  aws: {
    region: "us-west-2",
  },
  db: {
    tableName: "your-table-name",
  },
  codegen: {
    moduleSystem: "esm", // Options: 'commonjs' (default) or 'esm'
  },
  // ... other config
};
```

When ESM is enabled, generated models will use:

- `import` / `export` syntax instead of `require` / `module.exports`
- `.js` extensions in import paths for ESM compatibility

For ESM config files, you can use `.mjs` extension:

```javascript
// dynamo-bao.config.mjs
export default {
  codegen: {
    moduleSystem: "esm",
  },
  // ... other config
};
```

Then use the generated ESM models:

```javascript
// With ESM enabled
import { User } from "./models/user.js";
import { Post } from "./models/post.js";
```

Let's try using the models. Add the following code to a file called `example.js`.

```
// example.js
const { User } = require("./models/user");
const { Post } = require("./models/post");
const userConfig = require("./config");
const dynamoBao = require("dynamo-bao");
async function testUserModel() {
  dynamoBao.initModels(userConfig);

  // Find user by email
  const existingUser = await User.findByEmail("test@example.com");
  console.log("Found user by email:", existingUser.exists());
  if (existingUser.exists()) {
    await User.delete(existingUser.getPrimaryId());
    console.log("Deleted existing user");
    await new Promise((resolve) => setTimeout(resolve, 100)); // 100ms
  }

  // Create a new user
  const user = new User({
    name: "Test User",
    email: "test@example.com",
    role: "user",
    profilePictureUrl: "https://example.com/profile.jpg",
  });

  await user.save();
  console.log("Created user:", user.getPrimaryId());

  // Find user by email
  const foundUser = await User.findByEmail("test@example.com");
  console.log("Found user by email:", foundUser.getPrimaryId());

  // Create some test posts for the user
  const post1 = new Post({
    userId: user.userId,
    title: "Test Post 1",
    content: "This is a test post",
  });

  const post2 = new Post({
    userId: user.userId,
    title: "Test Post 2",
    content: "This is another test post",
  });

  await Promise.all([post1.save(), post2.save()]);

  // Query user posts
  const userPosts = await user.queryPosts();
  console.log("User posts:", userPosts.items.length);

  // Or add a filter condition to the query
  const filteredPosts = await user.queryPosts(null, {
    filter: { content: { $contains: "another" } },
  });
  console.log("User posts matching filter:", filteredPosts.items.length);
}

// Run the test
testUserModel();
```

Run the example.

```
node example.js
```

You should see something similar to this:

```
% node example.js
Found user by email: false
Created user: 01JFGMRH7XACZ8GKB81DZ5YWNH
Found user by email: 01JFGMRH7XACZ8GKB81DZ5YWNH
User posts: 2
User posts matching filter: 1
```

Congratulations! You're now harnessing the power of DynamoDB.

It's worth noting that you didn't have to:

- Configure or create a new table when adding a new model
- Install a database (either locally or on a server)
- Understand how to generate keys and indexes using single table design princples
- Manually configure transactions and items to support unique constraints
