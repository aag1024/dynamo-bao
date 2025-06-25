const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const { BaoModel, PrimaryKeyConfig } = require("../src/model");
const { StringField, TtlField } = require("../src/fields");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");
const { GetCommand } = require("../src/dynamodb-client");
const { ValidationError } = require("../src/exceptions");

let testId;

class TestTtl extends BaoModel {
  static modelPrefix = "tt";
  static iterable = true;
  static iterationBuckets = 1;

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
    await runWithBatchContext(async () => {
      testId = ulid();

      const manager = initTestModelsWithTenant(testConfig, testId);

      manager.registerModel(TestTtl);

      if (testId) {
        await cleanupTestDataByIteration(testId, [TestTtl]);
        await verifyCleanup(testId, [TestTtl]);
      }

      testItem = await TestTtl.create({
        itemId: `test-ttl-${Date.now()}`,
        name: "Test Item",
      });
    });
  });

  afterEach(async () => {
    await runWithBatchContext(async () => {
      TenantContext.clearTenant();
      if (testId) {
        await cleanupTestDataByIteration(testId, [TestTtl]);
        await verifyCleanup(testId, [TestTtl]);
      }
    });
  });

  test("should accept Date objects", async () => {
    await runWithBatchContext(async () => {
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
  });

  test("should accept timestamp in milliseconds", async () => {
    await runWithBatchContext(async () => {
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
  });

  test("should accept ISO string dates", async () => {
    await runWithBatchContext(async () => {
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
  });

  test("should store TTL as Unix timestamp in seconds", async () => {
    await runWithBatchContext(async () => {
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
      const tenantId =
        item._dyData._tenantId || item._dyData._gsi_test_id || testId;
      const params = {
        TableName: TestTtl.table,
        Key: {
          _pk: `[${tenantId}]#${TestTtl.modelPrefix}#${itemId}`,
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
  });

  test("should handle null TTL values", async () => {
    await runWithBatchContext(async () => {
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
      const tenantId =
        item._dyData._tenantId || item._dyData._gsi_test_id || testId;
      const command = new GetCommand({
        TableName: TestTtl.table,
        Key: {
          _pk: `[${tenantId}]#${TestTtl.modelPrefix}#${itemId}`,
          _sk: TestTtl.modelPrefix,
        },
      });

      const { Item } = await TestTtl.documentClient.send(command);
      expect(Item.ttl).toBeUndefined();
    });
  });

  test("should reject invalid date values", async () => {
    await runWithBatchContext(async () => {
      await expect(async () => {
        await TestTtl.update(testItem.itemId, {
          ttl: "not-a-date",
        });
      }).rejects.toThrow(ValidationError);
    });
  });

  test("should fail with invalid date", async () => {
    await runWithBatchContext(async () => {
      await expect(
        TestTtl.create({
          itemId: "ttl-test-6",
          ttl: "invalid-date",
        }),
      ).rejects.toThrow(ValidationError);
    });
  });
});
