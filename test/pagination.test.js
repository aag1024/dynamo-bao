const dynamoBao = require("../src");
const { TenantContext } = dynamoBao;
const testConfig = require("./config");
const { BaoModel, PrimaryKeyConfig, IndexConfig } = require("../src/model");

const { GSI_INDEX_ID1 } = require("../src/constants");

const {
  StringField,
  IntegerField,
  BooleanField,
  DateTimeField,
  UlidField,
} = require("../src/fields");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");

let testId;

// Reuse the same TestUser model
class TestUser extends BaoModel {
  static modelPrefix = "tu";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    userId: UlidField({ required: true, autoAssign: true }),
    name: StringField({ required: true }),
    age: IntegerField(),
    status: StringField(),
    isVerified: BooleanField({ defaultValue: false }),
    country: StringField(),
    lastLoginDate: DateTimeField(),
    score: IntegerField({ defaultValue: 0 }),
  };

  static primaryKey = PrimaryKeyConfig("userId");

  static indexes = {
    byStatus: IndexConfig("status", "userId", GSI_INDEX_ID1),
  };
}

describe("Pagination Tests", () => {
  let users = [];

  beforeEach(async () => {
    testId = ulid();

    const manager = initTestModelsWithTenant(testConfig, testId);

    manager.registerModel(TestUser);

    if (testId) {
      await cleanupTestDataByIteration(testId, [TestUser]);
      await verifyCleanup(testId, [TestUser]);
    }

    // Create more test users for pagination
    // Create sequentially to ensure ULID order is predictable
    users = [];
    users.push(
      await TestUser.create({ name: "User 1", status: "active", score: 100 }),
    );
    users.push(
      await TestUser.create({ name: "User 2", status: "active", score: 200 }),
    );
    users.push(
      await TestUser.create({ name: "User 3", status: "active", score: 300 }),
    );
    users.push(
      await TestUser.create({ name: "User 4", status: "active", score: 400 }),
    );
    users.push(
      await TestUser.create({ name: "User 5", status: "active", score: 500 }),
    );
  });

  afterEach(async () => {
    TenantContext.clearTenant();
    if (testId) {
      await cleanupTestDataByIteration(testId, [TestUser]);
      await verifyCleanup(testId, [TestUser]);
    }
  });

  test("should paginate with limit", async () => {
    // First page
    const page1 = await TestUser.queryByIndex("byStatus", "active", null, {
      limit: 2,
    });

    expect(page1.items).toHaveLength(2);
    expect(page1.lastEvaluatedKey).toBeDefined();

    // Second page
    const page2 = await TestUser.queryByIndex("byStatus", "active", null, {
      limit: 2,
      startKey: page1.lastEvaluatedKey,
    });

    expect(page2.items).toHaveLength(2);
    expect(page2.lastEvaluatedKey).toBeDefined();

    // Third page
    const page3 = await TestUser.queryByIndex("byStatus", "active", null, {
      limit: 2,
      startKey: page2.lastEvaluatedKey,
    });

    expect(page3.items).toHaveLength(1);
    expect(page3.lastEvaluatedKey).toBeUndefined();

    // Verify total items
    const allUsers = await TestUser.queryByIndex("byStatus", "active");
    expect(allUsers.items).toHaveLength(5);
  });

  test("should paginate with ascending sort", async () => {
    const allUsers = await TestUser.queryByIndex("byStatus", "active", null, {
      direction: "ASC",
    });

    // First page
    const page1 = await TestUser.queryByIndex("byStatus", "active", null, {
      limit: 2,
      direction: "ASC",
    });

    expect(page1.items).toHaveLength(2);
    expect(page1.items[0].userId).toBe(allUsers.items[0].userId);
    expect(page1.items[1].userId).toBe(allUsers.items[1].userId);

    // Second page
    const page2 = await TestUser.queryByIndex("byStatus", "active", null, {
      limit: 2,
      direction: "ASC",
      startKey: page1.lastEvaluatedKey,
    });

    expect(page2.items).toHaveLength(2);
    expect(page2.items[0].userId).toBe(allUsers.items[2].userId);
    expect(page2.items[1].userId).toBe(allUsers.items[3].userId);
  });

  test("should paginate with descending sort", async () => {
    const allUsers = await TestUser.queryByIndex("byStatus", "active", null, {
      direction: "DESC",
    });

    // First page
    const page1 = await TestUser.queryByIndex("byStatus", "active", null, {
      limit: 3,
      direction: "DESC",
    });

    expect(page1.items).toHaveLength(3);
    expect(page1.items[0].userId).toBe(allUsers.items[0].userId);
    expect(page1.items[2].userId).toBe(allUsers.items[2].userId);

    // Second page
    const page2 = await TestUser.queryByIndex("byStatus", "active", null, {
      limit: 3,
      direction: "DESC",
      startKey: page1.lastEvaluatedKey,
    });

    expect(page2.items).toHaveLength(2);
    expect(page2.items[0].userId).toBe(allUsers.items[3].userId);
    expect(page2.items[1].userId).toBe(allUsers.items[4].userId);
  });

  test("should maintain consistent order across pages", async () => {
    // Get all items sorted by score
    const allUsers = await TestUser.queryByIndex("byStatus", "active", null, {
      direction: "ASC",
    });

    const pageSize = 2;
    let currentPage = 1;
    let startKey = null;
    let collectedItems = [];

    // Collect all items through pagination
    while (true) {
      const page = await TestUser.queryByIndex("byStatus", "active", null, {
        limit: pageSize,
        direction: "ASC",
        startKey,
      });

      collectedItems = [...collectedItems, ...page.items];

      if (!page.lastEvaluatedKey) break;
      startKey = page.lastEvaluatedKey;
      currentPage++;
    }

    // Verify the order matches the non-paginated query
    expect(collectedItems).toHaveLength(allUsers.items.length);
    collectedItems.forEach((item, index) => {
      expect(item.userId).toBe(allUsers.items[index].userId);
    });
  });
});
