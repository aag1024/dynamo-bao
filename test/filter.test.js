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

describe("Filter Expression Tests", () => {
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

    // Create test users
    users = await Promise.all([
      TestUser.create({
        name: "John Doe",
        age: 25,
        status: "active",
        isVerified: true,
        country: "US",
        lastLoginDate: new Date("2024-01-01"),
        score: 100,
      }),
      TestUser.create({
        name: "Jane Smith",
        age: 30,
        status: "active",
        isVerified: false,
        country: "CA",
        lastLoginDate: new Date("2024-01-02"),
        score: 150,
      }),
      TestUser.create({
        name: "Bob Wilson",
        age: 20,
        status: "inactive",
        isVerified: true,
        country: "UK",
        lastLoginDate: new Date("2024-01-03"),
        score: 75,
      }),
    ]);
  });

  afterEach(async () => {
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  test("should filter with simple equality", async () => {
    const result = await TestUser.queryByIndex("byStatus", "active", null, {
      filter: { isVerified: true },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("John Doe");
  });

  test("should filter by auto-assigned userId", async () => {
    const johnDoe = users[0];
    const result = await TestUser.queryByIndex("byStatus", "active", null, {
      filter: { userId: johnDoe.userId },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("John Doe");
  });

  test("should filter userId with $in operator", async () => {
    const [john, jane] = users;
    const result = await TestUser.queryByIndex("byStatus", "active", null, {
      filter: {
        userId: { $in: [john.userId, jane.userId] },
      },
    });

    expect(result.items).toHaveLength(2);
    expect(result.items.map((u) => u.name).sort()).toEqual([
      "Jane Smith",
      "John Doe",
    ]);
  });

  test("should filter userId with $beginsWith operator", async () => {
    const johnDoe = users[0];
    const prefix = johnDoe.userId.substring(0, 20);
    const result = await TestUser.queryByIndex("byStatus", "active", null, {
      filter: {
        userId: { $beginsWith: prefix },
      },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("John Doe");
  });

  test("should filter with comparison operators", async () => {
    const result = await TestUser.queryByIndex("byStatus", "active", null, {
      filter: {
        age: { $gt: 25 },
        score: { $lte: 150 },
      },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("Jane Smith");
  });

  test("should filter with complex logical operators", async () => {
    const result = await TestUser.queryByIndex("byStatus", "active", null, {
      filter: {
        $or: [
          {
            $and: [{ age: { $gte: 25 } }, { isVerified: true }],
          },
          { score: { $gt: 125 } },
        ],
      },
    });

    expect(result.items).toHaveLength(2);
    expect(result.items.map((u) => u.name).sort()).toEqual([
      "Jane Smith",
      "John Doe",
    ]);
  });

  test("should filter with $not operator", async () => {
    const result = await TestUser.queryByIndex("byStatus", "active", null, {
      filter: {
        $not: { country: "US" },
      },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].country).toBe("CA");
  });

  test("should handle date field filtering", async () => {
    const result = await TestUser.queryByIndex("byStatus", "active", null, {
      filter: {
        lastLoginDate: { $lt: new Date("2024-01-02") },
      },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("John Doe");
  });

  test("should reject invalid field names", async () => {
    await expect(
      TestUser.queryByIndex("byStatus", "active", null, {
        filter: { invalidField: "value" },
      }),
    ).rejects.toThrow("Unknown field in filter: invalidField");
  });

  test("should reject invalid operators", async () => {
    await expect(
      TestUser.queryByIndex("byStatus", "active", null, {
        filter: { age: { $invalid: 25 } },
      }),
    ).rejects.toThrow("Invalid operator $invalid for field age");
  });

  test("should handle empty filter object", async () => {
    const result = await TestUser.queryByIndex("byStatus", "active", null, {
      filter: {},
    });

    expect(result.items).toHaveLength(2);
  });

  test("should handle multiple field conditions", async () => {
    const result = await TestUser.queryByIndex("byStatus", "active", null, {
      filter: {
        age: { $gte: 25 },
        score: { $lt: 125 },
        isVerified: true,
      },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("John Doe");
  });
});
