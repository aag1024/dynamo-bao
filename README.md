# DynamoBao

DynamoBao is a simple lightweight library for building DynamoDB models in JavaScript.

### Principles

- Don't break DynamoDB's superpower of infinite scale with consistent fast performance.
- Expose just enough of Dynamo's features to make it easy to model many common types of data.
- Use single table design to minimize ops overhead, without adding complexity for the developer.

### Key features

- Model 1:1, 1:N, N:M relationships between objects
- Efficiently load data: load related objects in parallel, cache data within a loading context
- Minimize race conditions: optimistic locking, version checks, atomic counters, saving diffs
- Enforce and look up by unique constraints
- Return total read/write consumed capacity (even when multiple operations were performed)

### Simple Example

Let's take a look at a simple YAML model definition.

```
models:
  User: {
    modelPrefix: u,
    fields: {
      userId: {type: UlidField, autoAssign: true, required: true},
      name: {type: StringField, required: true},
      email: {type: EmailField, required: true}
    },
    primaryKey: {partitionKey: userId}
  }
```

Based on this definition, the code generator will create a `User` model (in models/user) that you can use like this:

```
const { User } = require("./models/user");
const userConfig = require("./config");
const dynamoBao = require("dynamo-bao");
async function testUserModel() {
  try {
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
}

testUserModel();
```

### A more interesting example: relationships and unique constraints

```
models:
  User: {
    modelPrefix: u,
    fields: {
      userId: {type: UlidField, autoAssign: true, required: true},
      name: {type: StringField, required: true},
      email: {type: EmailField, required: true}
    },
    primaryKey: {partitionKey: userId},
    uniqueConstraints: {uniqueEmail: {field: email, uniqueConstraintId: uc1}}
  }
  Post: {
    modelPrefix: p,
    fields: {
      postId: {type: UlidField, autoAssign: true},
      userId: {type: RelatedField, model: User, required: true},
      title: {type: StringField, required: true},
      content: {type: StringField, required: true}
    },
    primaryKey: {partitionKey: postId},
    indexes: {postsForUser: {partitionKey: userId, sortKey: postId, indexId: gsi2}}
  }
```

```
const { User } = require("./models/user");
const { Post } = require("./models/post");
const userConfig = require("./config");
const dynamoBao = require("dynamo-bao");
async function testUserModel() {
  try {
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
    const userPosts = await user.queryPosts(null, {filter: {content: {$contains: "another"}}});
    console.log("User posts matching filter:", userPosts.items.length);

  }
}

testUserModel();
```

### model-codegen

```
model-codegen test/codegen/definitions test/codegen/generated
```
