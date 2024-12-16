const dynamoBao = require("../src");
const testConfig = require("./config");
const { BaseModel, PrimaryKeyConfig, IndexConfig } = require("../src/model");
const { GSI_INDEX_ID1 } = require("../src/constants");
const { StringField, IntegerField, BooleanField } = require("../src/fields");
const { cleanupTestData, verifyCleanup } = require("./utils/test-utils");
const { ulid } = require("ulid");
require("dotenv").config();

let testId;

class TestUser extends BaseModel {
  static modelPrefix = "tu";

  static fields = {
    userId: StringField({ required: true }),
    name: StringField({ required: true }),
    age: IntegerField(),
    status: StringField(),
    isVerified: BooleanField({ defaultValue: false }),
  };

  static primaryKey = PrimaryKeyConfig("userId");

  static indexes = {
    byStatus: IndexConfig("status", "userId", GSI_INDEX_ID1),
  };
}

describe("Count Query Tests", () => {
  beforeEach(async () => {
    testId = ulid();

    const manager = dynamoBao.initModels({
      ...testConfig,
      testId: testId,
    });

    manager.registerModel(TestUser);

    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }

    // Create test users
    await Promise.all([
      TestUser.create({
        userId: "user1",
        name: "John Doe",
        age: 25,
        status: "active",
        isVerified: true,
      }),
      TestUser.create({
        userId: "user2",
        name: "Jane Smith",
        age: 30,
        status: "active",
        isVerified: false,
      }),
      TestUser.create({
        userId: "user3",
        name: "Bob Wilson",
        age: 20,
        status: "inactive",
        isVerified: true,
      }),
    ]);
  });

  afterEach(async () => {
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  test("should return only count for simple index query", async () => {
    const result = await TestUser.queryByIndex("byStatus", "active", null, {
      countOnly: true,
    });

    expect(result.count).toEqual(2);
    // Ensure no items were returned
    expect(result.items).toBeUndefined();
  });

  test("should return correct count with filter", async () => {
    const result = await TestUser.queryByIndex("byStatus", "active", null, {
      countOnly: true,
      filter: { isVerified: true },
    });

    expect(result.count).toBe(1);
  });

  test("should return zero count when no matches", async () => {
    const result = await TestUser.queryByIndex("byStatus", "deleted", null, {
      countOnly: true,
    });

    expect(result.count).toBe(0);
  });

  test("should return correct count with complex filter", async () => {
    const result = await TestUser.queryByIndex("byStatus", "active", null, {
      countOnly: true,
      filter: {
        $or: [{ age: { $gt: 28 } }, { isVerified: true }],
      },
    });

    expect(result.count).toBe(2); // Should match Jane (age > 28) and John (verified)
  });

  test("should handle count with sort key condition", async () => {
    const result = await TestUser.queryByIndex(
      "byStatus",
      "active",
      {
        userId: { $beginsWith: "user" },
      },
      {
        countOnly: true,
      },
    );

    expect(result.count).toBe(2);
  });

  test("should include consumed capacity in response", async () => {
    const result = await TestUser.queryByIndex("byStatus", "active", null, {
      countOnly: true,
    });

    expect(result.consumedCapacity).toBeDefined();
  });

  test("should respect limit for both regular and count queries", async () => {
    // Test with countOnly
    const countResult = await TestUser.queryByIndex(
      "byStatus",
      "active",
      null,
      {
        countOnly: true,
        limit: 1,
      },
    );

    // Test without countOnly
    const regularResult = await TestUser.queryByIndex(
      "byStatus",
      "active",
      null,
      {
        limit: 1,
      },
    );

    expect(countResult.count).toBe(1); // Should only count up to limit
    expect(regularResult.items).toHaveLength(1);
    expect(regularResult.count).toBe(1);
  });

  test("should respect limit with countOnly queries", async () => {
    const limitedCount = await TestUser.queryByIndex(
      "byStatus",
      "active",
      null,
      {
        countOnly: true,
        limit: 1,
      },
    );

    const fullCount = await TestUser.queryByIndex("byStatus", "active", null, {
      countOnly: true,
      limit: 10, // Using higher limit to get all items
    });

    expect(limitedCount.count).toBe(1); // Should only count first item
    expect(fullCount.count).toBe(2); // Should count all items
  });

  test("should use default limit when no limit specified", async () => {
    const defaultResult = await TestUser.queryByIndex(
      "byStatus",
      "active",
      null,
      {
        countOnly: true,
      },
    );

    const explicitResult = await TestUser.queryByIndex(
      "byStatus",
      "active",
      null,
      {
        countOnly: true,
        limit: 1,
      },
    );

    expect(defaultResult.count).toBe(2);
    expect(explicitResult.count).toBe(1);
  });

  test("should handle pagination with counts", async () => {
    // First page
    const page1 = await TestUser.queryByIndex("byStatus", "active", null, {
      limit: 1,
    });

    // Second page
    const page2 = await TestUser.queryByIndex("byStatus", "active", null, {
      limit: 1,
      startKey: page1.lastEvaluatedKey,
    });

    // Total count
    const total = await TestUser.queryByIndex("byStatus", "active", null, {
      countOnly: true,
    });

    expect(page1.items).toHaveLength(1);
    expect(page2.items).toHaveLength(1);
    expect(total.count).toBe(2);
  });
});
