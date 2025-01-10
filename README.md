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
- Return total read/write consumed capacity (even when multiple operations were performed)

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
      # Enables Post.queryAllPosts() to query all posts
      allPosts: { partitionKey: modelPrefix, sortKey: postId, indexId: gsi1 }
      # Enables user.queryPosts() to query posts for a user
      postsForUser: { partitionKey: userId, sortKey: createdAt, indexId: gsi2 }
```

Run the code generator to create the models. You can also run `npx bao-watch` to automatically regenerate the models when you make changes.

```
npx bao-codegen
```

You should now have generated models in the `models` directory.

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
