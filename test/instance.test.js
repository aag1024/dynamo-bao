const dynamoBao = require("../src");
const testConfig = require("./config");
const { cleanupTestData, verifyCleanup } = require("./utils/test-utils");
const { ulid } = require("ulid");

let testUser, testId;

describe("Instance Methods", () => {
  beforeEach(async () => {
    testId = ulid();

    const manager = dynamoBao.initModels({
      ...testConfig,
      testId: testId,
    });

    await cleanupTestData(testId);
    await verifyCleanup(testId);

    User = manager.getModel("User");

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

  afterEach(async () => {
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  test("should track changes correctly", async () => {
    const user = await User.find(testUser.userId);
    expect(user.hasChanges()).toBeFalsy();
    expect(user.getChanges()).toEqual({});

    user.name = "Updated Name";
    expect(user.hasChanges()).toBeTruthy();
    expect(user.getChanges()).toEqual({ name: "Updated Name" });
  });

  test("should only save changed fields", async () => {
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

  test("should reset change tracking after save", async () => {
    const user = await User.find(testUser.userId);

    user.name = "Updated Name";
    expect(user.hasChanges()).toBeTruthy();

    await user.save();
    expect(user.hasChanges()).toBeFalsy();
    expect(user.getChanges()).toEqual({});
  });

  test("should handle multiple changes and saves correctly", async () => {
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

  test("should not call update if no changes made", async () => {
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

  test("should maintain original values until save", async () => {
    const user = await User.find(testUser.userId);
    const originalName = user.name;

    user.name = "Updated Name";

    // Fetch the same user in a different instance
    const sameUser = await User.find(testUser.userId);
    expect(sameUser.name).toBe(originalName);

    await user.save();

    // Now fetch again and verify the update
    const updatedUser = await User.find(testUser.userId);
    expect(updatedUser.name).toBe("Updated Name");
  });

  test("should handle unique constraint updates correctly", async () => {
    // Create two users
    const user1 = await User.find(testUser.userId);
    const user2 = await User.create({
      name: "Test User 2",
      email: "test2@example.com",
      externalId: "ext2",
      externalPlatform: "platform1",
      role: "user",
      status: "active",
    });

    // Try to update user1's email to user2's email
    user1.email = user2.email;

    await expect(user1.save()).rejects.toThrow("email must be unique");

    // Verify the original email wasn't changed in the database
    const freshUser1 = await User.find(user1.userId);
    expect(freshUser1.email).toBe("test@example.com");
  });

  test("should handle concurrent updates correctly", async () => {
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
    const finalUser = await User.find(testUser.userId);
    expect(finalUser.name).toBe("Name from instance 1");
    expect(finalUser.status).toBe("inactive");
  });
});
