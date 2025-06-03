const dynamoBao = require("../src");
const testConfig = require("./config");
const { BaoModel, PrimaryKeyConfig } = require("../src/model");
const { StringField, TtlField } = require("../src/fields");
const { cleanupTestData, verifyCleanup } = require("./utils/test-utils");
const { ulid } = require("ulid");
const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const { ValidationError } = require("../src/exceptions");

let testId;

class TestTtl extends BaoModel {
  static modelPrefix = "tt";

  static fields = {
    itemId: StringField({ required: true }),
    name: StringField(),
    ttl: TtlField(),
  };

  static primaryKey = PrimaryKeyConfig("itemId");
}

describe("TTL Field Tests", () => {
  let testItem;

  beforeEach(async () => {
    testId = ulid();

    const manager = dynamoBao.initModels({
      ...testConfig,
      testId: testId,
    });

    manager.registerModel(TestTtl);

    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }

    testItem = await TestTtl.create({
      itemId: `test-ttl-${Date.now()}`,
      name: "Test Item",
    });
  });

  afterEach(async () => {
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  test("should accept Date objects", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
    const dyTtl = TestTtl.fields.ttl.toDy(futureDate);

    const result = await TestTtl.update(testItem.itemId, {
      ttl: futureDate,
    });

    expect(result.ttl instanceof Date).toBe(true);
    // Compare timestamps in seconds to match DynamoDB TTL precision
    const expectedSeconds = Math.floor(futureDate.getTime() / 1000);
    const actualSeconds = Math.floor(result.ttl.getTime() / 1000);
    expect(actualSeconds).toBe(expectedSeconds);
  });

  test("should accept timestamp in milliseconds", async () => {
    const futureTimestamp = Date.now() + 24 * 60 * 60 * 1000; // 24 hours from now
    const result = await TestTtl.update(testItem.itemId, {
      ttl: futureTimestamp,
    });

    expect(result.ttl instanceof Date).toBe(true);
    // Compare timestamps in seconds
    const expectedSeconds = Math.floor(futureTimestamp / 1000);
    const actualSeconds = Math.floor(result.ttl.getTime() / 1000);
    expect(actualSeconds).toBe(expectedSeconds);
  });

  test("should accept ISO string dates", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const isoString = futureDate.toISOString();

    const result = await TestTtl.update(testItem.itemId, {
      ttl: isoString,
    });

    expect(result.ttl instanceof Date).toBe(true);
    // Compare timestamps in seconds
    const expectedSeconds = Math.floor(futureDate.getTime() / 1000);
    const actualSeconds = Math.floor(result.ttl.getTime() / 1000);
    expect(actualSeconds).toBe(expectedSeconds);
  });

  test("should store TTL as Unix timestamp in seconds", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const expectedSeconds = Math.floor(futureDate.getTime() / 1000);

    const itemId = `test-ttl-${Date.now()}-2`;

    // Create item with TTL
    const item = await TestTtl.create({
      itemId: itemId,
      name: "Test TTL Item",
      ttl: futureDate,
    });

    // Get the raw DynamoDB item using v3 SDK
    const params = {
      TableName: TestTtl.table,
      Key: {
        _pk: `[${item._dyData._gsi_test_id}]#${TestTtl.modelPrefix}#${itemId}`,
        _sk: TestTtl.modelPrefix,
      },
    };

    const command = new GetCommand(params);
    const { Item } = await TestTtl.documentClient.send(command);

    // Verify the TTL is stored as seconds
    expect(typeof Item.ttl).toBe("number");
    expect(Item.ttl).toBe(expectedSeconds);

    // Verify the value can be read back correctly
    const result = await TestTtl.find(itemId);
    expect(Math.floor(result.ttl.getTime() / 1000)).toBe(expectedSeconds);
  });

  test("should handle null TTL values", async () => {
    const itemId = `test-ttl-${Date.now()}-3`;

    // First create an item with TTL
    const item = await TestTtl.create({
      itemId: itemId,
      name: "Test TTL Item",
      ttl: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    // Then remove the TTL field
    const result = await TestTtl.update(itemId, {
      ttl: null,
    });

    expect(result.ttl).toBeNull();

    // Verify in DynamoDB that the field is removed
    const command = new GetCommand({
      TableName: TestTtl.table,
      Key: {
        _pk: `[${item._dyData._gsi_test_id}]#${TestTtl.modelPrefix}#${itemId}`,
        _sk: TestTtl.modelPrefix,
      },
    });

    const { Item } = await TestTtl.documentClient.send(command);
    expect(Item.ttl).toBeUndefined();
  });

  test("should reject invalid date values", async () => {
    await expect(async () => {
      await TestTtl.update(testItem.itemId, {
        ttl: "not-a-date",
      });
    }).rejects.toThrow(ValidationError);
  });

  test("should fail with invalid date", async () => {
    await expect(
      TestTtl.create({
        itemId: "ttl-test-6",
        ttl: "invalid-date",
      }),
    ).rejects.toThrow(ValidationError);
  });
});
