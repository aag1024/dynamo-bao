const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");
const { defaultLogger: logger } = require("../src/utils/logger");
const {
  BaoModel,
  PrimaryKeyConfig,
  UniqueConstraintConfig,
} = require("../src/model");
const {
  StringField,
  IntegerField,
  CounterField,
  UlidField,
} = require("../src/fields");
const { ConditionalError } = require("../src/exceptions");
const { UNIQUE_CONSTRAINT_ID1 } = require("../src/constants");

let testId, User;

// A unique-constrained model with a counter, so a create goes through the
// transaction path with a relative ("+3") counter value.
class UniqueCounter extends BaoModel {
  static modelPrefix = "ucn";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    counterId: UlidField({ autoAssign: true }),
    code: StringField({ required: true }),
    hits: CounterField(),
  };
  static primaryKey = PrimaryKeyConfig("counterId");
  static uniqueConstraints = {
    uniqueCode: UniqueConstraintConfig("code", UNIQUE_CONSTRAINT_ID1),
  };
}

beforeEach(async () => {
  await runWithBatchContext(async () => {
    testId = ulid();

    const manager = initTestModelsWithTenant(testConfig, testId);

    User = manager.getModel("User");
    manager.registerModel(UniqueCounter);
  });
});

afterEach(async () => {
  await runWithBatchContext(async () => {
    TenantContext.clearTenant();
    if (testId) {
      await cleanupTestDataByIteration(testId, [User, UniqueCounter]);
      await verifyCleanup(testId, [User, UniqueCounter]);
    }
  });
});

describe("User Unique Constraints", () => {
  test("should create user with unique email", async () => {
    await runWithBatchContext(async () => {
      const userData = {
        name: "Test User 1",
        email: "test1@example.com",
      };
      const user = await User.create(userData);
      expect(user.name).toBe(userData.name);
      expect(user.email).toBe(userData.email);
    });
  });

  test("should prevent duplicate email creation", async () => {
    await runWithBatchContext(async () => {
      const userData = {
        name: "Test User 1",
        email: "test1@example.com",
      };
      await User.create(userData);

      await expect(async () => {
        await User.create({
          name: "Test User 2",
          email: "test1@example.com",
        });
      }).rejects.toThrow(ConditionalError);
    });
  });

  test("should allow creating user with different email", async () => {
    await runWithBatchContext(async () => {
      const user2Data = {
        name: "Test User 2",
        email: "test2@example.com",
        role: "user",
        status: "active",
        createdAt: new Date(),
        modifiedAt: new Date(),
      };
      const user2 = await User.create(user2Data);

      // Only check the fields we care about
      expect(user2).toMatchObject({
        name: user2Data.name,
        email: user2Data.email,
        role: user2Data.role,
        status: user2Data.status,
      });

      // Verify timestamps exist but don't check exact values
      expect(user2.createdAt).toBeInstanceOf(Date);
      expect(user2.modifiedAt).toBeInstanceOf(Date);

      // Verify ID was generated
      expect(user2.userId).toBeDefined();
    });
  });

  test("should allow updating user with unique email", async () => {
    let user;

    await runWithBatchContext(async () => {
      user = await User.create({
        name: "Test User 1",
        email: "test1@example.com",
        status: "active",
      });
    });

    await runWithBatchContext(async () => {
      await User.update(user.userId, {
        email: "test2@example.com",
        status: user.status,
        createdAt: user.createdAt,
      });
    });

    await runWithBatchContext(async () => {
      // Verify the update was persisted
      const updatedUser = await User.find(user.userId);
      expect(updatedUser.email).toBe("test2@example.com");

      const user2 = await User.create({
        name: "Test User 1",
        email: "test1@example.com",
        status: "active",
      });
      expect(user2.email).toBe("test1@example.com");
    });
  });

  test("should drop unique constraint when field is cleared", async () => {
    let user;
    const externalId = `ext-${Date.now()}`;

    await runWithBatchContext(async () => {
      user = await User.create({
        name: "User With ExternalId",
        email: `unique-clear-${Date.now()}@example.com`,
        externalId,
      });
    });

    await runWithBatchContext(async () => {
      await User.update(user.userId, { externalId: null });

      // Reload bypassing cache to ensure the attribute was removed
      const refreshed = await User.find(user.userId, {
        batchDelay: 0,
        bypassCache: true,
      });
      expect(refreshed.externalId == null).toBe(true);

      const reused = await User.create({
        name: "User Reusing ExternalId",
        email: `unique-clear-reuse-${Date.now()}@example.com`,
        externalId,
      });

      expect(reused.externalId).toBe(externalId);
    });
  });

  test("should prevent updating user with existing email", async () => {
    await runWithBatchContext(async () => {
      const user1 = await User.create({
        name: "Test User 1",
        email: "test1@example.com",
        status: "active",
      });

      await User.create({
        name: "Test User 2",
        email: "test2@example.com",
        status: "active",
      });

      await expect(async () => {
        await User.update(user1.userId, {
          email: "test2@example.com",
          status: user1.status,
          createdAt: user1.createdAt,
        });
      }).rejects.toThrow(ConditionalError);
    });
  });

  test("should allow reusing email after user deletion", async () => {
    await runWithBatchContext(async () => {
      const user1 = await User.create({
        name: "Test User 1",
        email: "test1@example.com",
      });

      await User.delete(user1.userId);

      const user2 = await User.create({
        name: "Test User 2",
        email: "test1@example.com",
      });
      expect(user2.email).toBe("test1@example.com");
    });
  });
});

describe("Unique constraint round trips", () => {
  // Record the DynamoDB commands sent while fn runs.
  const recordCommands = async (fn) => {
    const commands = [];
    const send = User.documentClient.send.bind(User.documentClient);
    const spy = jest
      .spyOn(User.documentClient, "send")
      .mockImplementation((command) => {
        commands.push(command.constructor.name);
        return send(command);
      });
    try {
      const result = await fn();
      return { result, commands };
    } catch (error) {
      return { error, commands };
    } finally {
      spy.mockRestore();
    }
  };

  test("create issues a single transaction and returns the stored row", async () => {
    await runWithBatchContext(async () => {
      const { result: user, commands } = await recordCommands(() =>
        User.create({ name: "Test User 1", email: "test1@example.com" }),
      );
      expect(commands).toEqual(["TransactWriteCommand"]);

      const stored = await User.find(user.userId, {
        batchDelay: 0,
        bypassCache: true,
      });
      expect(stored.exists()).toBe(true);
      expect(user._dyData).toEqual(stored._dyData);
    });
  });

  test("create with a relative counter returns the stored number", async () => {
    await runWithBatchContext(async () => {
      const item = await UniqueCounter.create({ code: "c1", hits: "+3" });

      const stored = await UniqueCounter.find(item.counterId, {
        batchDelay: 0,
        bypassCache: true,
      });
      expect(stored._dyData.hits).toBe(3);
      expect(item._dyData).toEqual(stored._dyData);
      expect((await UniqueCounter.find(item.counterId))._dyData).toEqual(
        stored._dyData,
      );
    });
  });

  test("duplicate create names the field after the transaction cancels", async () => {
    await runWithBatchContext(async () => {
      await User.create({ name: "Test User 1", email: "test1@example.com" });

      const { error, commands } = await recordCommands(() =>
        User.create({ name: "Test User 2", email: "test1@example.com" }),
      );
      expect(error).toBeInstanceOf(ConditionalError);
      expect(error.message).toBe("email must be unique");
      expect(commands).toEqual(["TransactWriteCommand", "GetCommand"]);
    });
  });

  test("find after create in the same request is served from the cache", async () => {
    await runWithBatchContext(async () => {
      const user = await User.create({
        name: "Test User 1",
        email: "test1@example.com",
      });

      const { result: found, commands } = await recordCommands(() =>
        User.find(user.userId),
      );
      expect(commands).toEqual([]);
      expect(found.email).toBe("test1@example.com");
    });
  });

  test("collision on the second constraint leaves nothing behind", async () => {
    await runWithBatchContext(async () => {
      await User.create({
        name: "Test User 1",
        email: "test1@example.com",
        externalId: "ext-1",
      });

      await expect(
        User.create({
          name: "Test User 2",
          email: "test2@example.com",
          externalId: "ext-1",
        }),
      ).rejects.toThrow("externalId must be unique");

      // The email constraint from the cancelled create was never written.
      const user3 = await User.create({
        name: "Test User 3",
        email: "test2@example.com",
      });
      expect(user3.email).toBe("test2@example.com");
    });
  });

  test("update with an unchanged unique value does not check the constraint", async () => {
    await runWithBatchContext(async () => {
      const user = await User.create({
        name: "Test User 1",
        email: "test1@example.com",
      });

      const { commands } = await recordCommands(() =>
        User.update(user.userId, {
          name: "Renamed",
          email: "test1@example.com",
        }),
      );
      expect(commands).toEqual(["UpdateCommand"]);
    });
  });

  test("find after update in the same request sees the update", async () => {
    await runWithBatchContext(async () => {
      const user = await User.create({
        name: "Test User 1",
        email: "test1@example.com",
      });
      await User.find(user.userId);

      await User.update(user.userId, { name: "Renamed" });
      expect((await User.find(user.userId)).name).toBe("Renamed");
    });
  });

  test("update of a unique field returns and caches the new row", async () => {
    await runWithBatchContext(async () => {
      const user = await User.create({
        name: "Test User 1",
        email: "test1@example.com",
      });
      await User.find(user.userId);

      const updated = await User.update(user.userId, {
        email: "test2@example.com",
      });
      expect(updated.email).toBe("test2@example.com");
      expect((await User.find(user.userId)).email).toBe("test2@example.com");
    });
  });
});
