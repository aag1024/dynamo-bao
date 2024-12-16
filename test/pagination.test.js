const dynamoBao = require("../src");
const testConfig = require("./config");
const { BaseModel, PrimaryKeyConfig, IndexConfig } = require("../src/model");

const { GSI_INDEX_ID1 } = require("../src/constants");

const {
  StringField,
  IntegerField,
  BooleanField,
  DateTimeField,
  UlidField,
} = require("../src/fields");
const { cleanupTestData, verifyCleanup } = require("./utils/test-utils");
const { ulid } = require("ulid");

let testId;

// Reuse the same TestUser model
class TestUser extends BaseModel {
  static modelPrefix = "tu";

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

    const manager = dynamoBao.initModels({
      ...testConfig,
      testId: testId,
    });

    manager.registerModel(TestUser);

    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }

    // Create more test users for pagination
    users = await Promise.all([
      TestUser.create({ name: "User 1", status: "active", score: 100 }),
      TestUser.create({ name: "User 2", status: "active", score: 200 }),
      TestUser.create({ name: "User 3", status: "active", score: 300 }),
      TestUser.create({ name: "User 4", status: "active", score: 400 }),
      TestUser.create({ name: "User 5", status: "active", score: 500 }),
    ]);
  });

  afterEach(async () => {
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
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
      sort: "ASC",
    });

    // First page
    const page1 = await TestUser.queryByIndex("byStatus", "active", null, {
      limit: 2,
      sort: "ASC",
    });

    expect(page1.items).toHaveLength(2);
    expect(page1.items[0].userId).toBe(allUsers.items[0].userId);
    expect(page1.items[1].userId).toBe(allUsers.items[1].userId);

    // Second page
    const page2 = await TestUser.queryByIndex("byStatus", "active", null, {
      limit: 2,
      sort: "ASC",
      startKey: page1.lastEvaluatedKey,
    });

    expect(page2.items).toHaveLength(2);
    expect(page2.items[0].userId).toBe(allUsers.items[2].userId);
    expect(page2.items[1].userId).toBe(allUsers.items[3].userId);
  });

  test("should paginate with descending sort", async () => {
    const allUsers = await TestUser.queryByIndex("byStatus", "active", null, {
      sort: "DESC",
    });

    // First page
    const page1 = await TestUser.queryByIndex("byStatus", "active", null, {
      limit: 3,
      sort: "DESC",
    });

    expect(page1.items).toHaveLength(3);
    expect(page1.items[0].userId).toBe(allUsers.items[0].userId);
    expect(page1.items[2].userId).toBe(allUsers.items[2].userId);

    // Second page
    const page2 = await TestUser.queryByIndex("byStatus", "active", null, {
      limit: 3,
      sort: "DESC",
      startKey: page1.lastEvaluatedKey,
    });

    expect(page2.items).toHaveLength(2);
    expect(page2.items[0].userId).toBe(allUsers.items[3].userId);
    expect(page2.items[1].userId).toBe(allUsers.items[4].userId);
  });

  test("should maintain consistent order across pages", async () => {
    // Get all items sorted by score
    const allUsers = await TestUser.queryByIndex("byStatus", "active", null, {
      sort: "ASC",
    });

    const pageSize = 2;
    let currentPage = 1;
    let startKey = null;
    let collectedItems = [];

    // Collect all items through pagination
    while (true) {
      const page = await TestUser.queryByIndex("byStatus", "active", null, {
        limit: pageSize,
        sort: "ASC",
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
