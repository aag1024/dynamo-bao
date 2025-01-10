Models in DynamoBao are defined using YAML configuration files. These definitions are used to generate the corresponding model classes with all necessary fields, indexes, and relationships.

## Basic Structure

```yaml
models:
  ModelName:
    modelPrefix: "x" # Required: short (1-4 unique character prefix) for the model. This must be unique and cannot change later. It is not user visible.
    tableType: "standard" # Optional: "standard" (default) or "mapping"
    fields: {} # Required: field definitions
    primaryKey: {} # Required: primary key configuration
    indexes: {} # Optional: secondary indexes
    uniqueConstraints: {} # Optional: unique constraints
```

## Field Types

Fields can be defined with various types and options:

### Basic Fields

```yaml
fields:
  stringField:
    type: StringField
    required: true # Optional: makes the field required

  integerField:
    type: IntegerField
    defaultValue: 0 # Optional: default value

  floatField:
    type: FloatField

  booleanField:
    type: BooleanField
    defaultValue: false

  binaryField:
    type: BinaryField # Stores Buffer or Uint8Array data
```

### Date and Time Fields

```yaml
fields:
  dateTime:
    type: DateTimeField # Stores any date/time value

  createdAt:
    type: CreateDateField # Automatically sets creation timestamp

  modifiedAt:
    type: ModifiedDateField # Automatically updates on modification

  ttl:
    type: TtlField # Time-to-live field for automatic deletion
```

### UlidField

The `UlidField` is a special field that automatically generates ULID values. It is recommended to use this field for the primary key of your model.

```yaml
fields:
  postId:
    type: UlidField
    autoAssign: true
```

ULIDs are 128-bit values that are lexicographically sortable and can be generated in parallel. They are designed to be collision resistant and are compatible with the UUID format.

They are especially useful for dynamo since they can be used as sort keys and sort by the date they were created. This makes the default sort order when an id is used feel more natural than being purely random or requiring a secondary index to sort by creation date.

### VersionField

The `VersionField` is a special field that automatically generates a new larger version every time the object is saved. It is recommended to use this field for the version of your model. Note that this is a string, not a number.

```yaml
fields:
  version:
    type: VersionField
```

### CounterField

The `CounterField` is a special field that allows you to increment and decrement a counter atomically. This is useful for creating counters that can be incremented/decremented across users without having to worry about race conditions.

```yaml
fields:
  counter:
    type: CounterField
```

### TtlField

The `TtlField` is a special field that allows you to automatically delete an object after a certain amount of time. This is useful for creating time-based TTLs for objects. The field must be named `ttl`.

```yaml
fields:
  ttl:
    type: TtlField
```

### RelatedField

The `RelatedField` is a special field that allows you to reference another model. This is useful for creating relationships between models.

```yaml
fields:
  userId:
    type: RelatedField
    model: User
    required: true
```

This field will automatically generate a getter method on the model that allows you to query for the related model. Two of these fields can be used to create a many-to-many relationship. See the [Mapping Tables](#mapping-tables) section for more information.

### Complete Field Type Reference

- `StringField`: Text data
- `IntegerField`: Whole numbers
- `FloatField`: Decimal numbers
- `BooleanField`: True/false values
- `BinaryField`: Binary data (Buffer or Uint8Array)
- `DateTimeField`: Date and time values
- `CreateDateField`: Automatic creation timestamp
- `ModifiedDateField`: Automatic modification timestamp
- `UlidField`: Unique identifiers (often used for IDs)
- `VersionField`: Automatic version tracking for optimistic locking
- `CounterField`: Atomic counters that can be incremented/decremented
- `RelatedField`: References to other models
- `TtlField`: Time-to-live field for automatic item deletion (field must be named `ttl`)

### Field Options

Common options that can be applied to fields:

```yaml
fields:
  exampleField:
    type: StringField
    required: true # Field must have a value
    defaultValue: "test" # Default value if none provided
```

## Primary Key Configuration

Every model requires a primary key configuration:

```yaml
primaryKey:
  partitionKey: "userId" # Required: field to use as partition key
  sortKey: "createdAt" # Optional: field to use as sort key
```

The primary key's `partitionKey` and `sortKey` can never change once the model is created. If you need to change them, you will need to delete the object and create a new object with the new `partitionKey` and `sortKey`. With this in mind, it is recommended to choose a `partitionKey` and `sortKey` that will not change.

In addition to specifying a field as a `partitionKey` or `sortKey`, you can also specify the `modelPrefix` for either the `partitionKey` or `sortKey`. This is useful if you want to [query all the objects of a particular model](#iterating-over-all-objects-for-a-model) . However, if you expect this particular model to grow large, you should not use the modelPrefix as the partitionKey since all objects of this model will be stored in the same partition.

If the sortKey is not specified, it will use the modelPrefix as the sortKey. This is handled automatically and not something you need to specify.

## Indexes

You can add up to 3 secondary indexes (`gsi1`, `gsi2`, `gsi3`) to a model. Much like a primary key, each index has a `partitionKey` and `sortKey`. However, unlike a primary key, you can change the `partitionKey` and `sortKey` at any time.

Indexes incur additional costs, so you should only add them if you need them. In particular, if you are creating an index to support an infrequent query, it would be good to test the query with a filter rather than an index to see if the index necessary before adding it.

Secondary indexes enable additional query patterns:

```yaml
indexes:
  tagsForPost:
    partitionKey: "postId" # Field to use as partition key
    sortKey: "tagId" # Field to use as sort key
    indexId: "gsi1" # GSI identifier (gsi1, gsi2, etc.)

  # Reference to primary key
  postsForTag: primaryKey
```

Adding the `primaryKey` to the index is a shorthand that allows you to give the primary key a name and let you query by it. It does not create a new index. If you plan to query by the primary key, it is recommended to name it this way.

### Iterating Over All Objects for a Model

If you want to iterate over all the objects for a model, you can set the `modelPrefix` as the `partitionKey` for the model. This will allow you to query the model by the `modelPrefix` and iterate over all the objects of that model.

Here's an example:

```yaml
models:
  User:
    modelPrefix: "u"
    fields:
      userId:
        type: UlidField
        autoAssign: true
    primaryKey:
      partitionKey: "userId"
    indexes:
      allUsers:
        partitionKey: "modelPrefix"
        sortKey: "userId"
```

If you don't set this up, there is no efficient way to iterate over all the objects for a given model. However, if you expect this model to grow large, you should not use the modelPrefix as the `partitionKey` since all objects of this model will be stored in the same partition. This is a fundamental tension present in Dynamo single table design.

One way of addressing this is to choose a root model and enable iteration on it. This allows you to iterate over all the objects for the root model and use that to access all the other data in the system.

For instance, a `User` model could have an `allUsers` index that allows you to iterate over all the users in the system. If all other data in the system is owned by a user, you can iterate over all the users to get all the data in the system.

A good root model isn't too large and doesn't get written to frequently. For instance, a `User` model may be a good candidate, since you typically have many fewer users than posts, messages, or other objects in the system. Users also don't get written to as frequently as other objects, so it's a good fit for iteration. However, you should be aware that if you ever try to write lots of users to dynamo quickly (e.g. bulk importing users without rate limiting), you may hit write capacity limits since it's all on a single partition.

It is not recommended to use the `modelPrefix` as the primaryKey's partitionKey, since it cannot be changed later. If you do enable iteration, I recommend using an _index_ with the `modelPrefix` as the partitionKey since you can always stop using the index if you run into capacity issues with no issues to the rest of the system.

If you anticipate having a root model that is very large (1M+ objects), you will probably want to use a `partitionKey` that is the modelPrefix and a short hash of the object id. This will allow you to iterate over all the objects while also splitting the data across multiple partitions. If you need this, please [open an issue](https://github.com/aag1024/dynamo-bao/issues) and we can discuss further.

## Unique Constraints

You can specify up to 3 unique constraints (`uc1`, `uc2`, `uc3`) for a model.

```yaml
uniqueConstraints:
  uniqueEmail:
    field: "email"
    uniqueConstraintId: "uc1" # Unique constraint identifier
```

Unique constraints are implemented using Dynamo transactions, so they incur significant costs. Only use them where you really need them (e.g. to prevent duplicate emails, or map to a globally unique external id). Primary keys are already unique, so you may be able to use them instead, though keep in mind that they can't be changed later.

Creating a unique constraint will also enable fast lookups for that field. Before creating an index on a field that has a unique constraint, consider whether you can use the unique constraint instead.

## Mapping Tables

Mapping tables are used to create many-to-many relationships between models. They are defined using `tableType: "mapping"` and typically contain RelatedFields to the models being connected.

### Basic Structure

```yaml
ModelName:
  tableType: "mapping" # Identifies this as a mapping table
  modelPrefix: "xx" # Required: 2-character prefix
  fields:
    firstModelId: # Related field to first model
      type: RelatedField
      model: FirstModel
      required: true
    secondModelId: # Related field to second model
      type: RelatedField
      model: SecondModel
      required: true
    createdAt: # Optional: tracking fields
      type: CreateDateField
  primaryKey: # Define how records are stored
    partitionKey: firstModelId
    sortKey: secondModelId
```

### Real Example: TaggedPost

Here's a complete example of a mapping table that connects Tags to Posts:

```yaml
TaggedPost:
  tableType: "mapping"
  modelPrefix: "tp"
  fields:
    tagId:
      type: RelatedField
      model: Tag
      required: true
    postId:
      type: RelatedField
      model: Post
      required: true
    createdAt:
      type: CreateDateField
  primaryKey:
    partitionKey: tagId
    sortKey: postId
  indexes:
    postsForTag: primaryKey # Query posts for a tag
    tagsForPost: # Query tags for a post
      partitionKey: postId
      sortKey: tagId
      indexId: gsi1
    recentPostsForTag: # Query posts for a tag by date
      partitionKey: tagId
      sortKey: createdAt
      indexId: gsi2
```

### Generated Methods

When you create a mapping table, the following methods are automatically generated on the related models:

For the Tag model:

```javascript
// Get all posts for a tag
async getPosts(mapSkCondition=null, limit=null, direction='ASC', startKey=null)

// Get posts for a tag ordered by creation date
async getRecentPosts(mapSkCondition=null, limit=null, direction='ASC', startKey=null)
```

For the Post model:

```javascript
// Get all tags for a post
async getTags(mapSkCondition=null, limit=null, direction='ASC', startKey=null)
```

For many-to-many relationships, the methods are called `get` rather than `query` because it's only possible to query on the mapping table, not the tags/posts themselves. In practice, you end up paging through these objects in the order of the mapping table rather than filtering them, so it's more like a get than a query. For one-to-many relationships, we add `query` methods to the related model since it's possible to query the related model objects.

### Best Practices

1. **Naming Convention**: Name mapping tables by combining the two model names (e.g., `TaggedPost`, `UserGroup`)
2. **Required Fields**: Make the relationship fields required to ensure data integrity
3. **Tracking Fields**: Include `createdAt` if you need to track when relationships were created
4. **Indexes**: Create indexes for querying from both directions
5. **Sort Keys**: Consider using `createdAt` as a sort key in secondary indexes for time-based queries

### Common Index Patterns

For a mapping table connecting ModelA and ModelB, you will want to use the primaryKey to relate one model to the other. Then you will also want to create an index to query the reverse (assuming you want to be able to query the reverse side of the relationship).

```yaml
indexes:
  # Primary access pattern
  bsForA: primaryKey # Query Bs for an A

  # Reverse lookup
  asForB: # Query As for a B
    partitionKey: modelBId
    sortKey: modelAId
    indexId: gsi1
```

## Complete Example

```yaml
models:
  Post:
    modelPrefix: "p"
    fields:
      postId:
        type: UlidField
        autoAssign: true
      userId:
        type: RelatedField
        model: User
        required: true
      title:
        type: StringField
        required: true
      content:
        type: StringField
      createdAt:
        type: CreateDateField
    primaryKey:
      partitionKey: postId
    indexes:
      postsForUser:
        partitionKey: userId
        sortKey: createdAt
        indexId: gsi1
      allPosts:
        partitionKey: modelPrefix
        sortKey: postId
        indexId: gsi2
```

## Generated Features

The model generator will automatically create:

1. Field definitions with validation
2. Primary key configuration
3. Secondary index queries
4. Related field getters (e.g., `getUser()` for a `userId` field)
5. Unique constraint validators
6. Query methods for indexes
7. Mapping table relationship helpers

## Best Practices

1. Use clear, descriptive names for models and fields
2. Always include a `createdAt` field for tracking
3. Use `UlidField` for ID fields with `autoAssign: true`
4. Define indexes based on your query patterns
5. Use mapping tables for many-to-many relationships
6. Keep model prefixes unique and short (1-4 characters)
