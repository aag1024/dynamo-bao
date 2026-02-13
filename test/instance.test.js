const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { UpdateCommand, GetCommand } = require("../src/dynamodb-client");
const { ulid } = require("ulid");
const { ConditionalError } = require("../src/exceptions");

let testUser, testId, User;

describe("Instance Methods", () => {
  beforeEach(async () => {
    await runWithBatchContext(async () => {
      testId = ulid();

      const manager = initTestModelsWithTenant(testConfig, testId);

      User = manager.getModel("User");

      await cleanupTestDataByIteration(testId, [User]);
      await verifyCleanup(testId, [User]);

      // Create a test user for each test
      testUser = await User.create({
        name: "Test User",
        email: "test@example.com",
        externalId: "ext1",
        externalPlatform: "platform1",
        role: "user",
        status: "active",
      });
    });
  });

  afterEach(async () => {
    await runWithBatchContext(async () => {
      TenantContext.clearTenant();
      if (testId) {
        await cleanupTestDataByIteration(testId, [User]);
        await verifyCleanup(testId, [User]);
      }
    });
  });

  test("should track changes correctly", async () => {
    await runWithBatchContext(async () => {
      const user = await User.find(testUser.userId);
      expect(user.hasChanges()).toBeFalsy();
      expect(user._getChanges()).toEqual({});

      user.name = "Updated Name";
      expect(user.hasChanges()).toBeTruthy();
      expect(user._getChanges()).toEqual({ name: "Updated Name" });
    });
  });

  test("should only save changed fields", async () => {
    await runWithBatchContext(async () => {
      const user = await User.create({
        name: "Test User",
        email: "test_save_fields@example.com",
        externalId: "ext_save_fields",
        externalPlatform: "platform1",
        status: "active",
      });

      const updateSpy = jest.spyOn(User, "update");

      user.name = "Updated Name";
      await user.save();

      expect(updateSpy).toHaveBeenCalledWith(
        user.userId,
        { name: "Updated Name" },
        expect.any(Object),
      );

      updateSpy.mockRestore();
    });
  });

  test("should reset change tracking after save", async () => {
    await runWithBatchContext(async () => {
      const user = await User.find(testUser.userId);

      user.name = "Updated Name";
      expect(user.hasChanges()).toBeTruthy();

      await user.save();
      expect(user.hasChanges()).toBeFalsy();
      expect(user._getChanges()).toEqual({});
    });
  });

  test("should handle multiple changes and saves correctly", async () => {
    await runWithBatchContext(async () => {
      const user = await User.create({
        name: "Test User",
        email: "test_multiple_changes@example.com",
        externalId: "ext_multiple_changes",
        externalPlatform: "platform1",
        status: "active",
      });

      const updateSpy = jest.spyOn(User, "update");

      user.name = "Updated Name";
      user.status = "inactive";
      await user.save();

      expect(updateSpy).toHaveBeenCalledWith(
        user.userId,
        {
          name: "Updated Name",
          status: "inactive",
        },
        expect.any(Object),
      );

      updateSpy.mockRestore();
    });
  });

  test("should not call update if no changes made", async () => {
    await runWithBatchContext(async () => {
      const user = await User.create({
        name: "Test User",
        email: "test_no_changes@example.com",
        externalId: "ext_no_changes",
        externalPlatform: "platform1",
        status: "active",
      });

      const updateSpy = jest.spyOn(User, "update");

      // Don't make any changes
      await user.save();

      expect(updateSpy).not.toHaveBeenCalled();

      updateSpy.mockRestore();
    });
  });

  test("should force reindex when requested even without field changes", async () => {
    await runWithBatchContext(async () => {
      const user = await User.find(testUser.userId);

      // Ensure no changes are tracked initially
      expect(user.hasChanges()).toBeFalsy();

      const docClient = User.documentClient;

      // Remove existing index attributes to simulate a drifted item
      await docClient.send(
        new UpdateCommand({
          TableName: User.table,
          Key: {
            _pk: user._dyData._pk,
            _sk: user._dyData._sk,
          },
          UpdateExpression: "REMOVE #g1pk, #g1sk, #g2pk, #g2sk, #g3pk, #g3sk, #g4pk, #g4sk, #g5pk, #g5sk",
          ExpressionAttributeNames: {
            "#g1pk": "_gsi1_pk",
            "#g1sk": "_gsi1_sk",
            "#g2pk": "_gsi2_pk",
            "#g2sk": "_gsi2_sk",
            "#g3pk": "_gsi3_pk",
            "#g3sk": "_gsi3_sk",
            "#g4pk": "_gsi4_pk",
            "#g4sk": "_gsi4_sk",
            "#g5pk": "_gsi5_pk",
            "#g5sk": "_gsi5_sk",
          },
          ReturnValues: "ALL_NEW",
        }),
      );

      const itemWithoutIndexes = await docClient.send(
        new GetCommand({
          TableName: User.table,
          Key: {
            _pk: user._dyData._pk,
            _sk: user._dyData._sk,
          },
        }),
      );

      expect(itemWithoutIndexes.Item._gsi1_pk).toBeUndefined();
      expect(itemWithoutIndexes.Item._gsi2_pk).toBeUndefined();
      expect(itemWithoutIndexes.Item._gsi3_pk).toBeUndefined();

      // Force reindex without mutating fields
      await user.save({ forceReindex: true });

      const savedUser = await User.find(user.getPrimaryId(), {
        bypassCache: true,
      });
      expect(savedUser.exists()).toBeTruthy();

      const tableItem = await docClient.send(
        new GetCommand({
          TableName: User.table,
          Key: {
            _pk: savedUser._dyData._pk,
            _sk: savedUser._dyData._sk,
          },
          ReturnConsumedCapacity: "TOTAL",
        }),
      );

      expect(tableItem.Item._gsi1_pk).toBeDefined();
      expect(tableItem.Item._gsi2_pk).toBeDefined();
      expect(tableItem.Item._gsi3_pk).toBeDefined();
    });
  });

  test("should maintain original values until save", async () => {
    let user, originalName;

    await runWithBatchContext(async () => {
      user = await User.find(testUser.userId);
      originalName = user.name;
      user.name = "Updated Name";
    });

    await runWithBatchContext(async () => {
      // Fetch the same user in a different batch context
      const sameUser = await User.find(testUser.userId);
      expect(sameUser.name).toBe(originalName);
    });

    await runWithBatchContext(async () => {
      await user.save();
    });

    await runWithBatchContext(async () => {
      // Now fetch again and verify the update
      const updatedUser = await User.find(testUser.userId);
      expect(updatedUser.name).toBe("Updated Name");
    });
  });

  test("should handle unique constraint updates correctly", async () => {
    let user1, user2;

    await runWithBatchContext(async () => {
      // Create two users
      user1 = await User.find(testUser.userId);
      user2 = await User.create({
        name: "Test User 2",
        email: "test2@example.com",
        externalId: "ext2",
        externalPlatform: "platform1",
        role: "user",
        status: "active",
      });

      // Try to update user1's email to user2's email
      user1.email = user2.email;

      await expect(user1.save()).rejects.toThrow(ConditionalError);
    });

    await runWithBatchContext(async () => {
      // Verify the original email wasn't changed in the database
      const freshUser1 = await User.find(user1.userId);
      expect(freshUser1.email).toBe("test@example.com");
    });
  });

  test("should not create unique constraint when optional field is undefined", async () => {
    let userIdA, userIdB;
    const emailA = `no-ext-${ulid()}@example.com`;
    const emailB = `no-ext-${ulid()}@example.com`;

    await runWithBatchContext(async () => {
      const createdA = await User.create({
        name: "No External Id",
        email: emailA,
        status: "active",
        role: "user",
      });
      userIdA = createdA.userId;

      // Creating another user without externalId should also succeed
      const createdB = await User.create({
        name: "No External Id 2",
        email: emailB,
        status: "active",
        role: "user",
      });
      userIdB = createdB.userId;
    });

    // Allow async writes to settle before reloading
    await new Promise((resolve) => setTimeout(resolve, 100));

    await runWithBatchContext(async () => {
      const reloadedA = await User.find(userIdA, { bypassCache: true });
      expect(reloadedA.exists()).toBe(true);
      expect(reloadedA.email).toBe(emailA);
      expect(reloadedA.externalId).toBeUndefined();

      const reloadedB = await User.find(userIdB, { bypassCache: true });
      expect(reloadedB.exists()).toBe(true);
      expect(reloadedB.email).toBe(emailB);
      expect(reloadedB.externalId).toBeUndefined();
    });
  });

  test("should handle concurrent updates correctly", async () => {
    await runWithBatchContext(async () => {
      // Get two instances of the same user
      const instance1 = await User.find(testUser.userId);
      const instance2 = await User.find(testUser.userId);

      // Update different fields in each instance
      instance1.name = "Name from instance 1";
      instance2.status = "inactive";

      // Save both changes
      await instance1.save();
      await instance2.save();

      // Verify both changes were applied
      const finalUser = await User.find(testUser.userId, { bypassCache: true });
      expect(finalUser.name).toBe("Name from instance 1");
      expect(finalUser.status).toBe("inactive");
    });
  });

  test("creating and saving a user", async () => {
    await runWithBatchContext(async () => {
      const existingUser = await User.findByUniqueConstraint(
        "uniqueEmail",
        "test@example.com",
      );
      if (existingUser.exists()) {
        await User.delete(existingUser.getPrimaryId());
      }

      const newUser = new User({
        name: "New User",
        email: "new@example.com",
        externalId: "ext_new",
        externalPlatform: "platform1",
        role: "user",
        status: "active",
      });

      await newUser.save();

      expect(newUser.exists()).toBe(true);
      expect(newUser.name).toBe("New User");
      expect(newUser.email).toBe("new@example.com");
    });
  });

  test("forceReindex should preserve new values instead of overwriting with old ones", async () => {
    await runWithBatchContext(async () => {
      const user = await User.find(testUser.userId);
      const docClient = User.documentClient;

      // Update the role field with forceReindex
      user.role = "admin";
      await user.save({ forceReindex: true });

      // Verify the new value was saved, not the old one
      const savedUser = await User.find(testUser.userId, {
        bypassCache: true,
      });
      expect(savedUser.role).toBe("admin");

      // Verify the GSI that uses role as a key was updated with the new value
      const tableItem = await docClient.send(
        new GetCommand({
          TableName: User.table,
          Key: {
            _pk: savedUser._dyData._pk,
            _sk: savedUser._dyData._sk,
          },
        }),
      );

      // byRole index uses role as PK - verify the GSI key reflects the new value
      expect(tableItem.Item._gsi2_pk).toContain("admin");
      expect(tableItem.Item._gsi2_pk).not.toContain("user");
    });
  });

  test("partial GSI key update should auto-backfill counterpart from existing item", async () => {
    await runWithBatchContext(async () => {
      const docClient = User.documentClient;

      // User has byRole index: IndexConfig("role", "status", GSI_INDEX_ID2)
      // Updating only role (PK) should auto-backfill status (SK) from existing item
      const updated = await User.update(testUser.userId, { role: "admin" });
      expect(updated.role).toBe("admin");
      expect(updated.status).toBe("active"); // original value preserved

      // Verify the GSI was updated correctly with new role + old status
      const tableItem = await docClient.send(
        new GetCommand({
          TableName: User.table,
          Key: {
            _pk: updated._dyData._pk,
            _sk: updated._dyData._sk,
          },
        }),
      );

      expect(tableItem.Item._gsi2_pk).toContain("admin");
      expect(tableItem.Item._gsi2_sk).toBeDefined();
    });
  });

  test("SK-only update should auto-backfill PK across multiple GSIs", async () => {
    await runWithBatchContext(async () => {
      const docClient = User.documentClient;

      // status is SK in byRole (PK=role) AND PK in byStatus (SK=createdAt)
      // Updating status alone should backfill both role and createdAt
      const updated = await User.update(testUser.userId, {
        status: "inactive",
      });
      expect(updated.status).toBe("inactive");

      const tableItem = await docClient.send(
        new GetCommand({
          TableName: User.table,
          Key: {
            _pk: updated._dyData._pk,
            _sk: updated._dyData._sk,
          },
        }),
      );

      // byRole (gsi2): PK=role should be backfilled, SK=status is the new value
      expect(tableItem.Item._gsi2_pk).toBeDefined();
      expect(tableItem.Item._gsi2_pk).toContain("user"); // original role

      // byStatus (gsi3): PK=status is the new value, SK=createdAt should be backfilled
      expect(tableItem.Item._gsi3_pk).toBeDefined();
      expect(tableItem.Item._gsi3_pk).toContain("inactive");
      expect(tableItem.Item._gsi3_sk).toBeDefined();
    });
  });

  test("non-GSI field update should not rewrite GSI keys", async () => {
    await runWithBatchContext(async () => {
      const docClient = User.documentClient;

      // Grab the GSI keys before the update
      const beforeItem = await docClient.send(
        new GetCommand({
          TableName: User.table,
          Key: {
            _pk: testUser._dyData._pk,
            _sk: testUser._dyData._sk,
          },
        }),
      );

      // Update a field that doesn't participate in any GSI
      await User.update(testUser.userId, { name: "New Name" });

      const afterItem = await docClient.send(
        new GetCommand({
          TableName: User.table,
          Key: {
            _pk: testUser._dyData._pk,
            _sk: testUser._dyData._sk,
          },
        }),
      );

      // GSI keys should be unchanged
      expect(afterItem.Item._gsi1_pk).toEqual(beforeItem.Item._gsi1_pk);
      expect(afterItem.Item._gsi1_sk).toEqual(beforeItem.Item._gsi1_sk);
      expect(afterItem.Item._gsi2_pk).toEqual(beforeItem.Item._gsi2_pk);
      expect(afterItem.Item._gsi2_sk).toEqual(beforeItem.Item._gsi2_sk);
      expect(afterItem.Item._gsi3_pk).toEqual(beforeItem.Item._gsi3_pk);
      expect(afterItem.Item._gsi3_sk).toEqual(beforeItem.Item._gsi3_sk);
    });
  });

  test("forceReindex should preserve multiple new values", async () => {
    await runWithBatchContext(async () => {
      const user = await User.find(testUser.userId);
      const docClient = User.documentClient;

      // Change both fields of the byRole GSI key pair
      user.role = "admin";
      user.status = "inactive";
      await user.save({ forceReindex: true });

      const savedUser = await User.find(testUser.userId, {
        bypassCache: true,
      });
      expect(savedUser.role).toBe("admin");
      expect(savedUser.status).toBe("inactive");

      const tableItem = await docClient.send(
        new GetCommand({
          TableName: User.table,
          Key: {
            _pk: savedUser._dyData._pk,
            _sk: savedUser._dyData._sk,
          },
        }),
      );

      // byRole GSI should reflect both new values
      expect(tableItem.Item._gsi2_pk).toContain("admin");
      expect(tableItem.Item._gsi2_pk).not.toContain("user");
    });
  });

  test("backfill safety net throws when counterpart field was never stored", async () => {
    await runWithBatchContext(async () => {
      // Create a user without externalPlatform (optional field, GSI PK)
      const user = await User.create({
        name: "No Platform User",
        email: "noplatform@example.com",
        externalId: "ext_np",
        role: "user",
        status: "active",
      });

      const docClient = User.documentClient;

      // Manually remove the externalPlatform GSI keys AND the field data
      // to simulate an item that never had this field stored
      await docClient.send(
        new UpdateCommand({
          TableName: User.table,
          Key: {
            _pk: user._dyData._pk,
            _sk: user._dyData._sk,
          },
          UpdateExpression: "REMOVE #ep, #g1pk, #g1sk",
          ExpressionAttributeNames: {
            "#ep": "externalPlatform",
            "#g1pk": "_gsi1_pk",
            "#g1sk": "_gsi1_sk",
          },
          ReturnValues: "ALL_NEW",
        }),
      );

      // byPlatform index: PK=externalPlatform, SK=userId
      // Updating externalPlatform (PK) should try to backfill userId (SK)
      // userId always exists so this should succeed, not throw
      const updated = await User.update(user.userId, {
        externalPlatform: "newPlatform",
      });
      expect(updated.externalPlatform).toBe("newPlatform");
    });
  });
});
