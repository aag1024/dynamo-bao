DynamoBao provides powerful querying capabilities through indexes, key conditions, and filter expressions. This guide explains how to effectively query your data using these features.

### Basic Querying

To query data, use the `queryByIndex` method (see {@link BaoModel.queryByIndex}):

```javascript
const results = await MyModel.queryByIndex(
  indexName,     // String: The named index (or primary key) from the model definition
  partitionKey,  // Any: The partition key value to query
  sortKeyCondition?, // Object?: Optional conditions for the sort key
  options?: {    // Object?: Optional query parameters
    limit?: number,        // Maximum number of items to return
    startKey?: any,        // Key to start from (for pagination)
    direction?: 'ASC' | 'DESC', // Sort direction, defaults to ASC
    filter?: Object,       // Additional filter expressions
    loadRelated?: boolean, // Whether to load related models
    relatedFields?: string[], // Specific related fields to load
  }
);

// Return type:
{
  items: MyModel[],           // Array of model instances
  count: number,              // Number of items returned
  lastEvaluatedKey?: any,     // Key for pagination (if more results exist)
  scannedCount: number        // Total number of items evaluated
}
```

Querying involves two steps:

1. **Key Conditions**: Refine the query using the sort key of an index.
2. **Filter Expressions**: Further refine the query results.

Whenever possible, use a key condition over a filter expression. Key conditions are more efficient and can be used to filter out items before they are returned. Filter expressions are applied after the query is executed and will read all items that match the key conditions, even if they are not returned.

However, for infrequent queries, it may be more efficient to use a filter expression than create a new index and use a key condition, so don't assume that key conditions are always more efficient. It's best to test the simplest approach first, and only add an index if it's necessary.

### Auto-Generated Query Methods

DynamoBao automatically generates query methods for each index. These methods are named after the index and are available on the model class.

For example, if you have an index named `byStatus`, you can use the `queryByStatus` method to query the `User` model:

```javascript
const results = await User.queryByStatus("active");
```

This also works for models that reference each other or have unique indexes.

```yaml
models:
  User:
    modelPrefix: u
    fields:
      userId: { type: UlidField, autoAssign: true, required: true }
      name: { type: StringField, required: true }
      email: { type: StringField, required: true }
    primaryKey:
      partitionKey: userId
    uniqueConstraints:
      uniqueEmail: { field: email, uniqueConstraintId: uc1 }

  Post:
    modelPrefix: p
    fields:
      postId: { type: UlidField, autoAssign: true }
      userId: { type: RelatedField, model: User, required: true }
      title: { type: StringField, required: true }
      content: { type: StringField, required: true }
      createdAt: { type: CreateDateField }
    primaryKey:
      partitionKey: postId
    indexes:
      allPosts: { partitionKey: modelPrefix, sortKey: postId, indexId: gsi1 }
      postsForUser: { partitionKey: userId, sortKey: createdAt, indexId: gsi2 }
```

```javascript
// Query all posts (using allPosts index)
const posts = await Post.queryAllPosts();

// Query with sort key condition
const posts = await Post.queryAllPosts({
  postId: { $gt: "someId" },
});

// Query with options
const posts = await Post.queryAllPosts(null, {
  limit: 10,
  loadRelated: true,
});

// Query using postsForUser index directly
const posts = await Post.queryByIndex("postsForUser", userId);

// Query all posts for a user
const user = await User.find("userId123");

// Shortcut for Post.queryByIndex("postsForUser", userId);
const posts = await user.queryPosts();

// Query with sort key condition (using createdAt)
const posts = await user.queryPosts({
  createdAt: { $gt: new Date("2024-01-01") },
});

// Query with options
const posts = await user.queryPosts(null, {
  limit: 10,
  loadRelated: true,
});

// Query based on a unique constraint
const user = await User.findByEmail("john@example.com");
```

### Key Conditions

Key conditions allow you to refine queries using the sort key of an index.

- `$beginsWith`: Matches items beginning with a prefix
- `$between`: Matches items between two values
- `$gt`: Greater than
- `$gte`: Greater than or equal
- `$lt`: Less than
- `$lte`: Less than or equal

#### Equality

```javascript
// Simple equality match
const result = await User.queryByIndex("byStatus", "active", {
  category: "premium",
});
```

#### Begins With

```javascript
// Match items where sort key begins with a prefix
const result = await User.queryByIndex("byStatus", "active", {
  category: { $beginsWith: "pre" },
});
```

#### Between

```javascript
// Match items where sort key is between two values
const result = await User.queryByIndex("byStatus", "active", {
  category: { $between: ["basic", "premium"] },
});
```

#### Comparison Operators

```javascript
// Greater than
const result = await User.queryByIndex("byStatus", "active", {
  category: { $gt: "basic" },
});
```

### Filter Expressions

Filters allow you to further refine your query results. Unlike key conditions, filters are applied after the query and consume read capacity units for any items that match the sort key condition regardless of whether they are returned.

- `$eq`: Equal to (default when using simple equality)
- `$ne`: Not equal to
- `$gt`: Greater than
- `$gte`: Greater than or equal
- `$lt`: Less than
- `$lte`: Less than or equal
- `$in`: Match any value in an array
- `$beginsWith`: String begins with
- `$between`: Value is between (inclusive)
- `$and`: Logical AND of conditions
- `$or`: Logical OR of conditions
- `$not`: Logical NOT of a condition

#### Simple Equality

```javascript
const result = await User.queryByIndex("byStatus", "active", null, {
  filter: { isVerified: true },
});
```

#### Comparison Operators

```javascript
const result = await User.queryByIndex("byStatus", "active", null, {
  filter: {
    age: { $gt: 25 },
    score: { $lte: 150 },
  },
});
```

#### Logical Operators

```javascript
const result = await User.queryByIndex("byStatus", "active", null, {
  filter: {
    $or: [
      {
        $and: [{ age: { $gte: 25 } }, { isVerified: true }],
      },
      { score: { $gt: 125 } },
    ],
  },
});
```

#### Not Operator

```javascript
const result = await User.queryByIndex("byStatus", "active", null, {
  filter: {
    $not: { country: "US" },
  },
});
```

#### Date Field Filtering

```javascript
const result = await User.queryByIndex("byStatus", "active", null, {
  filter: {
    lastLoginDate: { $lt: new Date("2024-01-02") },
  },
});
```

### Related Data Queries

DynamoBao supports loading related data during queries.

#### Loading All Related Data

```javascript
const posts = await Post.queryByIndex("postsForUser", userId, null, {
  loadRelated: true,
});
```

#### Loading Specific Related Fields

```javascript
const posts = await Post.queryByIndex("postsForUser", userId, null, {
  loadRelated: true,
  relatedFields: ["userId"],
});
```

## Pagination

Query results can be paginated using the `limit`, `startKey`, and `direction` options:

```javascript
// First page
const firstPage = await Post.queryByIndex("postsForUser", userId, null, {
  limit: 10,
  direction: "DESC",
});

// Next page (if there are more results)
if (firstPage.lastEvaluatedKey) {
  const nextPage = await Post.queryByIndex("postsForUser", userId, null, {
    limit: 10,
    startKey: firstPage.lastEvaluatedKey,
    direction: "DESC",
  });
}
```
