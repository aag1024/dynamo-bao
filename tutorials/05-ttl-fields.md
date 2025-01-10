Time-To-Live (TTL) fields in DynamoDB allow you to automatically delete items after a specified timestamp. This tutorial shows how to implement TTL fields in your DynamoBao models. DynamoBao will automatically enable TTL on your table. No additional configuration is required.

## Basic Setup

To add a TTL field to your model, use the `TtlField` type in your model's
definition and name your field `ttl`. It is required that your ttl field
be named `ttl` and be of type `TtlField`.

```
models:
  CachedResult:
    modelPrefix: cr
    fields:
      hashId: {type: StringField, required: true}
      content: {type: StringField, required: true}
      ttl: {type: TtlField}
    primaryKey: {partitionKey: hashId}
```

## Working with TTL Values

The TTL field accepts several formats for setting expiration times:

### 1. Date Objects

```
// Set TTL to 24 hours from now
const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

await CachedResult.create({
    hashId: "hash123",
    content: "Test Item",
    ttl: futureDate
});
```

### 2. Timestamps (milliseconds)

```
// Set TTL using millisecond timestamp
const futureTimestamp = Date.now() + 24 * 60 * 60 * 1000;

await CachedResult.update(hashId, {
ttl: futureTimestamp
});
```

### 3. ISO String Dates

```
// Set TTL using ISO string
const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
const isoString = futureDate.toISOString();

await CachedResult.update(hashId, {
    ttl: isoString
});
```

## Important Notes

1. DynamoDB stores TTL values as Unix timestamps in seconds. DynamoBao handles this conversion automatically.

2. You can remove a TTL by setting it to `null`:

```
await CachedResult.update(hashId, {
    ttl: null
});
```

3. Invalid date values will be rejected with an error.

## DynamoDB TTL Behavior

- Items are typically deleted within 48 hours after the TTL timestamp.
- Deletion is eventually consistent and happens in the background.
- There is no additional cost for using TTL.
- DynamoBao will automatically enable TTL on your table. No additional configuration is required.

## Best Practices

1. Use TTL for:

   - Session management
   - Temporary data cleanup
   - Log expiration
   - Time-sensitive content

2. Always validate that your TTL dates are set in the future when creating/updating items.

3. Remember that TTL deletion is not immediate - don't rely on it for time-critical operations. If you need to ensure data is deleted after a certain time, check the `ttl` field after the item is loaded or filter
   items based on the `ttl` field and the current time.

## See Also

- [AWS DynamoDB TTL Documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html)
- [DynamoBao API Reference](/api/fields/ttl)
