const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const { DescribeTableCommand } = require("../src/dynamodb-client");
const {
  cleanupTestData,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");
const { QueryCommand } = require("../src/dynamodb-client");
const { defaultLogger: logger } = require("../src/utils/logger");
const { ConditionalError, QueryError } = require("../src/exceptions");

let testId;

beforeAll(async () => {
  // Initialize models
  const manager = dynamoBao.initModels(testConfig);
  const docClient = manager.documentClient;

  try {
    const tableInfo = await docClient.send(
      new DescribeTableCommand({
        TableName: testConfig.db.tableName,
      }),
    );
    logger.log("Table exists:", tableInfo.Table.TableName);
    logger.log("GSIs:", tableInfo.Table.GlobalSecondaryIndexes);
  } catch (error) {
    console.error("Failed to connect to DynamoDB:", error);
    throw error;
  }
});

beforeEach(async () => {
  testId = ulid();

  const manager = initTestModelsWithTenant(testConfig, testId);

  await runWithBatchContext(async () => {
    await cleanupTestData(testId);
    await verifyCleanup(testId);
  });

  User = manager.getModel("User");
});

afterEach(async () => {
  TenantContext.clearTenant();
  if (testId) {
    await runWithBatchContext(async () => {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    });
  }
});

describe("User CRUD Operations", () => {
  test("should create a user successfully", async () => {
    await runWithBatchContext(async () => {
      const userData = {
        name: "Test User 1",
        email: "test1@example.com",
        externalId: "ext1",
        externalPlatform: "platform1",
      };

      logger.log("Creating user with data:", userData);

      try {
        const user = await User.create(userData);

        // Compare only the input fields that we explicitly provided
        expect(user.name).toBe(userData.name);
        expect(user.email).toBe(userData.email);
        expect(user.externalId).toBe(userData.externalId);
        expect(user.externalPlatform).toBe(userData.externalPlatform);

        // Verify date fields are Date instances
        expect(user.createdAt).toBeInstanceOf(Date);
        expect(user.modifiedAt).toBeInstanceOf(Date);

        // Verify other auto-generated fields
        expect(user.userId).toBeDefined();
        expect(user.role).toBe("user");
        expect(user.status).toBe("active");
      } catch (error) {
        console.error("Transaction error details:", error);
        console.error("Cancellation reasons:", error.CancellationReasons);
        throw error;
      }
    });
  });

  test("should prevent duplicate email creation", async () => {
    await runWithBatchContext(async () => {
      const userData = {
        name: "Test User 1",
        email: "test1@example.com",
        externalId: "ext1",
      };

      await User.create(userData);

      await expect(async () => {
        await User.create({
          name: "Test User 2",
          email: "test1@example.com",
          externalId: "ext2",
        });
      }).rejects.toThrow(ConditionalError);
    });
  });
});

describe("User Unique Constraints", () => {
  test("should allow reusing unique values after user deletion", async () => {
    let userId;

    await runWithBatchContext(async () => {
      const userData = {
        name: "Test User",
        email: "test@example.com",
        externalId: "ext1",
      };

      const user = await User.create(userData);
      userId = user.userId;
      await User.delete(userId);
    });

    await runWithBatchContext(async () => {
      const newUser = await User.create({
        name: "New Test User",
        email: "test@example.com",
        externalId: "ext1",
      });

      expect(newUser.email).toBe("test@example.com");
      expect(newUser.externalId).toBe("ext1");
    });
  });
});

describe("GSI Queries", () => {
  beforeEach(async () => {
    await runWithBatchContext(async () => {
      // Create test users for GSI queries
      testUsers = await Promise.all([
        User.create({
          name: "Test User 1",
          email: "test1@example.com",
          externalId: "ext1",
          externalPlatform: "platform1",
          role: "admin",
          status: "active",
        }),
        User.create({
          name: "Test User 2",
          email: "test2@example.com",
          externalId: "ext2",
          externalPlatform: "platform1",
          role: "user",
          status: "active",
        }),
        User.create({
          name: "Test User 3",
          email: "test3@example.com",
          externalId: "ext3",
          externalPlatform: "platform2",
          role: "user",
          status: "inactive",
        }),
      ]);
    });
  });

  test("should query users by platform using byPlatform index", async () => {
    await runWithBatchContext(async () => {
      const platformUsers = await User.queryByIndex("byPlatform", "platform1");
      expect(platformUsers.items).toHaveLength(2);
      expect(platformUsers.items[0].externalPlatform).toBe("platform1");
    });
  });

  test("should query users by role using byRole index", async () => {
    await runWithBatchContext(async () => {
      const adminUsers = await User.queryByIndex("byRole", "admin");
      expect(adminUsers.items).toHaveLength(1);
      expect(adminUsers.items[0].role).toBe("admin");
    });
  });

  test("should query users by status using byStatus index", async () => {
    await runWithBatchContext(async () => {
      const activeUsers = await User.queryByIndex("byStatus", "active");
      expect(activeUsers.items).toHaveLength(2);
      expect(activeUsers.items[0].status).toBe("active");
    });
  });

  test("should throw error for invalid index name", async () => {
    await runWithBatchContext(async () => {
      await expect(
        User.queryByIndex("invalidIndex", "someValue"),
      ).rejects.toThrow(QueryError);
    });
  });
});

describe("Date Range Queries", () => {
  test("should query users by date range", async () => {
    await runWithBatchContext(async () => {
      const startDate = new Date();
      await Promise.all([
        User.create({
          name: "Test User 1",
          email: "test1@example.com",
          externalId: "ext1",
          externalPlatform: "platform1",
          status: "active",
        }),
        User.create({
          name: "Test User 2",
          email: "test2@example.com",
          externalId: "ext2",
          externalPlatform: "platform1",
          status: "active",
        }),
      ]);
      const endDate = new Date();

      const result = await User.queryByIndex("byStatus", "active", {
        createdAt: { $between: [startDate, endDate] },
      });

      expect(result.items.length).toBeGreaterThan(0);
      result.items.forEach((user) => {
        expect(user.status).toBe("active");
        // Convert dates to timestamps for comparison
        const userCreatedAt = user.createdAt.getTime();
        const startTimestamp = startDate.getTime();
        const endTimestamp = endDate.getTime();

        expect(userCreatedAt).toBeGreaterThanOrEqual(startTimestamp);
        expect(userCreatedAt).toBeLessThanOrEqual(endTimestamp);
      });
    });
  });
});

test("should properly set tenantId on models", async () => {
  await runWithBatchContext(async () => {
    const manager = initTestModelsWithTenant(testConfig, testId);

    const user = await User.create({
      name: "Test User",
      email: "test@example.com",
      externalId: "ext1",
      externalPlatform: "platform1",
    });

    // Verify that the tenant context is working
    expect(manager.getTenantId()).toBe(testId);

    // Verify that the user was created with the proper tenant isolation
    expect(user._dyData._pk).toContain(`[${testId}]`);

    // Verify that we can find the user using the model (which uses tenant context)
    const foundUser = await User.find(user.userId);
    expect(foundUser.exists()).toBe(true);
    expect(foundUser.email).toBe("test@example.com");
  });
});
