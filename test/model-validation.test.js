const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const { BaoModel, PrimaryKeyConfig, IndexConfig } = require("../src/model");
const { StringField } = require("../src/fields");
const { ConfigurationError, ValidationError } = require("../src/exceptions");
const { ulid } = require("ulid");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
let testId, manager;

describe("Model Validation Tests", () => {
  beforeEach(async () => {
    testId = ulid();

    manager = dynamoBao.initModels({
      ...testConfig,
      testId: testId,
    });
  });

  afterEach(async () => {
    TenantContext.clearTenant();
  });

  test("should reject field names starting with underscore", () => {
    class InvalidFieldModel extends BaoModel {
      static modelPrefix = "test";
      static iterable = true;
      static iterationBuckets = 1;

      static fields = {
        validField: StringField(),
        _invalidField: StringField(),
      };
      static primaryKey = PrimaryKeyConfig("validField");
    }

    // We expect the error to be thrown during model registration
    expect(() => {
      manager.registerModel(InvalidFieldModel);
    }).toThrow(ConfigurationError);
  });

  test("should reject index names starting with underscore", () => {
    class InvalidIndexModel extends BaoModel {
      static modelPrefix = "test";
      static iterable = true;
      static iterationBuckets = 1;

      static fields = {
        id: StringField(),
        name: StringField(),
      };
      static primaryKey = PrimaryKeyConfig("id");
      static indexes = {
        _invalidIndex: IndexConfig("name", "id", "gsi1"),
      };
    }

    // We expect the error to be thrown during model registration
    expect(() => {
      manager.registerModel(InvalidIndexModel);
    }).toThrow(ConfigurationError);
  });

  test("should validate required fields during creation", async () => {
    await runWithBatchContext(async () => {
      class RequiredFieldModel extends BaoModel {
        static modelPrefix = "test";
        static iterable = true;
        static iterationBuckets = 1;

        static fields = {
          id: StringField({ required: true }),
          name: StringField({ required: true }),
          optional: StringField(),
        };
        static primaryKey = PrimaryKeyConfig("id");
      }

      manager.registerModel(RequiredFieldModel);

      // Should succeed with all required fields
      const validModel = await RequiredFieldModel.create({
        id: "test-1",
        name: "Test Name",
      });
      expect(validModel).toBeDefined();
      expect(validModel.id).toBe("test-1");
      expect(validModel.name).toBe("Test Name");

      // Should fail without required name field
      await expect(
        RequiredFieldModel.create({
          id: "test-2",
        }),
      ).rejects.toThrow(ValidationError);

      // Should fail without required id field
      await expect(
        RequiredFieldModel.create({
          name: "Test Name",
        }),
      ).rejects.toThrow(ValidationError);

      // Should succeed with optional field missing
      const validModelNoOptional = await RequiredFieldModel.create({
        id: "test-3",
        name: "Test Name",
      });
      expect(validModelNoOptional).toBeDefined();
      expect(validModelNoOptional.optional).toBeUndefined();
    });
  });

  test("should validate required fields during update", async () => {
    await runWithBatchContext(async () => {
      class RequiredFieldModel extends BaoModel {
        static modelPrefix = "test";
        static iterable = true;
        static iterationBuckets = 1;

        static fields = {
          id: StringField({ required: true }),
          name: StringField({ required: true }),
          optional: StringField(),
        };
        static primaryKey = PrimaryKeyConfig("id");
      }

      manager.registerModel(RequiredFieldModel);

      // Create initial record
      const model = await RequiredFieldModel.create({
        id: "test-1",
        name: "Initial Name",
      });

      // Should succeed with valid update
      const updatedModel = await RequiredFieldModel.update(model.id, {
        name: "Updated Name",
      });
      expect(updatedModel.name).toBe("Updated Name");

      // Should fail when setting required field to null
      await expect(
        RequiredFieldModel.update(model.id, {
          name: null,
        }),
      ).rejects.toThrow(ValidationError);

      // Should succeed when updating optional field
      const optionalUpdate = await RequiredFieldModel.update(model.id, {
        optional: "Optional Value",
      });
      expect(optionalUpdate.optional).toBe("Optional Value");
    });
  });

  test("should automatically mark primary key fields as required", async () => {
    await runWithBatchContext(async () => {
      class ImplicitRequiredModel extends BaoModel {
        static modelPrefix = "test";
        static iterable = true;
        static iterationBuckets = 1;

        static fields = {
          id: StringField(), // Not explicitly required
          sortKey: StringField(), // Not explicitly required
          otherField: StringField(),
        };
        static primaryKey = PrimaryKeyConfig("id", "sortKey");
      }

      manager.registerModel(ImplicitRequiredModel);

      // Should automatically mark fields as required during validation
      ImplicitRequiredModel._validateConfiguration();

      // Verify fields are now required by attempting to create without them
      await expect(
        ImplicitRequiredModel.create({
          sortKey: "test",
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        ImplicitRequiredModel.create({
          id: "test",
        }),
      ).rejects.toThrow(ValidationError);

      // Should succeed with both primary key fields
      const validModel = await ImplicitRequiredModel.create({
        id: "test",
        sortKey: "test",
      });
      expect(validModel).toBeDefined();
    });
  });

  test("should work with single-field primary keys", async () => {
    await runWithBatchContext(async () => {
      class SingleKeyModel extends BaoModel {
        static modelPrefix = "test";
        static iterable = true;
        static iterationBuckets = 1;

        static fields = {
          id: StringField(), // Not explicitly required
          otherField: StringField(),
        };
        static primaryKey = PrimaryKeyConfig("id");
      }

      manager.registerModel(SingleKeyModel);

      // Should automatically mark field as required during validation
      SingleKeyModel._validateConfiguration();

      // Verify field is now required
      await expect(
        SingleKeyModel.create({
          otherField: "test",
        }),
      ).rejects.toThrow(ValidationError);

      // Should succeed with primary key field
      const validModel = await SingleKeyModel.create({
        id: "test",
      });
      expect(validModel).toBeDefined();
    });
  });

  test("should accept explicitly required primary key fields", async () => {
    await runWithBatchContext(async () => {
      class ExplicitRequiredModel extends BaoModel {
        static modelPrefix = "test";
        static iterable = true;
        static iterationBuckets = 1;

        static fields = {
          id: StringField({ required: true }),
          sortKey: StringField({ required: true }),
          otherField: StringField(),
        };
        static primaryKey = PrimaryKeyConfig("id", "sortKey");
      }

      manager.registerModel(ExplicitRequiredModel);

      // Should validate without any warnings
      ExplicitRequiredModel._validateConfiguration();

      // Verify fields are required
      await expect(
        ExplicitRequiredModel.create({
          sortKey: "test",
        }),
      ).rejects.toThrow(ValidationError);

      // Should succeed with both fields
      const validModel = await ExplicitRequiredModel.create({
        id: "test",
        sortKey: "test",
      });
      expect(validModel).toBeDefined();

      // Should fail when setting the required field to null
      await expect(
        ExplicitRequiredModel.update(validModel.getPrimaryId(), {
          id: null,
        }),
      ).rejects.toThrow(ValidationError);
    });
  });
});
