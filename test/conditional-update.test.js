const dynamoBao = require("../src");
const testConfig = require("./config");
const { BaoModel, PrimaryKeyConfig, IndexConfig } = require("../src/model");
const { cleanupTestData, verifyCleanup } = require("./utils/test-utils");
const { ulid } = require("ulid");
const {
  StringField,
  IntegerField,
  BooleanField,
  DateTimeField,
  UlidField,
  CreateDateField,
} = require("../src/fields");

class TestUser extends BaoModel {
  static modelPrefix = "tu";

  static fields = {
    userId: UlidField({ required: true, autoAssign: true }),
    name: StringField({ required: true }),
    status: StringField({ required: true }),
    count: IntegerField({ defaultValue: 0 }),
    isVerified: BooleanField({ defaultValue: false }),
    lastUpdated: DateTimeField(),
    createdAt: CreateDateField(),
  };

  static primaryKey = PrimaryKeyConfig("userId");
}

describe("Conditional Update Tests", () => {
  let model;
  let testId;
  let testUser;

  beforeEach(async () => {
    testId = ulid();

    const manager = dynamoBao.initModels({
      ...testConfig,
      testId: testId,
    });

    manager.registerModel(TestUser);
    model = TestUser;

    await cleanupTestData(testId);
    await verifyCleanup(testId);

    // Create a test user
    testUser = await model.create({
      name: "Test User",
      status: "active",
      count: 5,
      isVerified: true,
    });
  });

  afterEach(async () => {
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  test("should update when condition is met", async () => {
    const result = await model.update(
      testUser.userId,
      { status: "inactive" },
      {
        condition: { status: "active" },
      },
    );

    expect(result.status).toBe("inactive");
  });

  test("should fail to update when condition is not met", async () => {
    await expect(
      model.update(
        testUser.userId,
        { status: "inactive" },
        {
          condition: { status: "pending" },
        },
      ),
    ).rejects.toThrow("Condition check failed");
  });

  test("should support complex conditions with $and", async () => {
    const result = await model.update(
      testUser.userId,
      { status: "inactive" },
      {
        condition: {
          $and: [{ status: "active" }, { count: { $lt: 10 } }],
        },
      },
    );

    expect(result.status).toBe("inactive");
  });

  test("should support $exists operator", async () => {
    const result = await model.update(
      testUser.userId,
      { count: 6 },
      {
        condition: {
          status: { $exists: true },
        },
      },
    );

    expect(result.count).toBe(6);
  });

  test("should fail when mixing condition and constraints", async () => {
    await expect(
      model.update(
        testUser.userId,
        { status: "inactive" },
        {
          condition: { status: "active" },
          constraints: { mustExist: true },
        },
      ),
    ).rejects.toThrow(
      "Cannot use both condition and constraints options together",
    );
  });

  test("should support string operators", async () => {
    const result = await model.update(
      testUser.userId,
      { name: "Updated Name" },
      {
        condition: {
          name: { $beginsWith: "Test" },
        },
      },
    );

    expect(result.name).toBe("Updated Name");
  });

  test("should support multiple comparison operators", async () => {
    const result = await model.update(
      testUser.userId,
      { count: 10 },
      {
        condition: {
          count: { $gt: 3, $lt: 7 },
        },
      },
    );

    expect(result.count).toBe(10);
  });

  test("should fail gracefully when item does not exist", async () => {
    await expect(
      model.update(
        "non-existent-id",
        { status: "inactive" },
        {
          condition: { status: "active" },
        },
      ),
    ).rejects.toThrow("Item not found");
  });

  test("should prevent creating duplicate items", async () => {
    const existingId = testUser.userId;

    await expect(
      model.create({
        userId: existingId,
        name: "Duplicate User",
        status: "active",
      }),
    ).rejects.toThrow("Condition check failed");
  });

  test("should support $exists: false condition", async () => {
    // First create a user without the optional lastUpdated field
    const userWithoutDate = await model.create({
      name: "No Date User",
      status: "active",
    });

    // Update should succeed when lastUpdated doesn't exist
    const result = await model.update(
      userWithoutDate.userId,
      { status: "inactive" },
      {
        condition: {
          lastUpdated: { $exists: false },
        },
      },
    );

    expect(result.status).toBe("inactive");

    // Now try to update with the same condition after setting lastUpdated
    await model.update(userWithoutDate.userId, {
      lastUpdated: new Date(),
    });

    // This update should fail because lastUpdated now exists
    await expect(
      model.update(
        userWithoutDate.userId,
        { status: "active" },
        {
          condition: {
            lastUpdated: { $exists: false },
          },
        },
      ),
    ).rejects.toThrow("Condition check failed");
  });

  test("should support conditions on createdAt field", async () => {
    // Store creation time for comparison
    const creationTime = testUser.createdAt;

    // Wait a moment to ensure time difference
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Create another user
    const newUser = await model.create({
      name: "New User",
      status: "active",
    });

    // Update should succeed for users created after our reference time
    const result = await model.update(
      newUser.userId,
      { status: "inactive" },
      {
        condition: {
          createdAt: { $gt: creationTime },
        },
      },
    );

    expect(result.status).toBe("inactive");

    // Update should fail for the original user
    await expect(
      model.update(
        testUser.userId,
        { status: "active" },
        {
          condition: {
            createdAt: { $gt: creationTime },
          },
        },
      ),
    ).rejects.toThrow("Condition check failed");
  });
});
