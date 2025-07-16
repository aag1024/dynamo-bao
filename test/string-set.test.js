const dynamoBao = require("../src");
const { TenantContext } = dynamoBao;
const testConfig = require("./config");
const { BaoModel, PrimaryKeyConfig, IndexConfig } = require("../src/model");
const {
  StringField,
  IntegerField,
  UlidField,
  StringSetField,
} = require("../src/fields");
const {
  QueryError,
  ValidationError,
  ConfigurationError,
} = require("../src/exceptions");

const { GSI_INDEX_ID1 } = require("../src/constants");

const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");

let testId;

class TestDocument extends BaoModel {
  static modelPrefix = "td";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    docId: UlidField({ required: true, autoAssign: true }),
    title: StringField({ required: true }),
    tags: StringSetField({ maxStringLength: 50, maxMemberCount: 10 }),
    categories: StringSetField({ maxStringLength: 20, maxMemberCount: 5 }),
    version: IntegerField({ defaultValue: 1 }),
    status: StringField({ defaultValue: "draft" }),
  };

  static primaryKey = PrimaryKeyConfig("docId");

  static indexes = {
    byStatus: IndexConfig("status", "docId", GSI_INDEX_ID1),
  };
}

describe("StringSetField Tests", () => {
  let documents = [];

  beforeEach(async () => {
    testId = ulid();

    const manager = initTestModelsWithTenant(testConfig, testId);
    manager.registerModel(TestDocument);

    if (testId) {
      await cleanupTestDataByIteration(testId, [TestDocument]);
      await verifyCleanup(testId, [TestDocument]);
    }

    // Create test documents
    documents = await Promise.all([
      TestDocument.create({
        title: "JavaScript Guide",
        tags: new Set(["javascript", "programming", "web"]),
        categories: new Set(["tutorial", "beginner"]),
        status: "published",
      }),
      TestDocument.create({
        title: "React Tutorial",
        tags: new Set(["react", "javascript", "frontend"]),
        categories: new Set(["tutorial", "intermediate"]),
        status: "published",
      }),
      TestDocument.create({
        title: "Draft Article",
        tags: new Set(["draft"]),
        categories: new Set(),
        status: "draft",
      }),
    ]);
  });

  afterEach(async () => {
    TenantContext.clearTenant();
    if (testId) {
      await cleanupTestDataByIteration(testId, [TestDocument]);
      await verifyCleanup(testId, [TestDocument]);
    }
  });

  describe("Basic StringSetField Operations", () => {
    test("should create and save documents with StringSetField", async () => {
      const doc = new TestDocument({
        title: "Test Document",
        tags: new Set(["test", "example"]),
        categories: new Set(["demo"]),
      });

      await doc.save();
      expect(doc.tags).toBeInstanceOf(Set);
      expect(doc.tags.has("test")).toBe(true);
      expect(doc.tags.has("example")).toBe(true);
      expect(doc.categories.has("demo")).toBe(true);
    });

    test("should accept arrays and convert to Sets", async () => {
      const doc = new TestDocument({
        title: "Array Test",
        tags: ["array", "test"],
        categories: ["conversion"],
      });

      await doc.save();
      expect(doc.tags).toBeInstanceOf(Set);
      expect(doc.tags.has("array")).toBe(true);
      expect(doc.tags.has("test")).toBe(true);
      expect(doc.categories).toBeInstanceOf(Set);
      expect(doc.categories.has("conversion")).toBe(true);
    });

    test("should handle empty sets", async () => {
      const doc = new TestDocument({
        title: "Empty Test",
        tags: new Set(),
        categories: new Set(),
      });

      await doc.save();

      // Reload from database
      const reloaded = await TestDocument.find(doc.docId);
      expect(reloaded.exists()).toBe(true);
      expect(reloaded.tags).toBeInstanceOf(Set);
      expect(reloaded.tags.size).toBe(0);
      expect(reloaded.categories).toBeInstanceOf(Set);
      expect(reloaded.categories.size).toBe(0);
    });

    test("should handle undefined/null fields", async () => {
      const doc = new TestDocument({
        title: "Null Test",
        // tags and categories not provided
      });

      await doc.save();

      // Reload from database
      const reloaded = await TestDocument.find(doc.docId);
      expect(reloaded.exists()).toBe(true);
      expect(reloaded.tags).toBeInstanceOf(Set);
      expect(reloaded.tags.size).toBe(0);
      expect(reloaded.categories).toBeInstanceOf(Set);
      expect(reloaded.categories.size).toBe(0);
    });
  });

  describe("StringSetField Validation", () => {
    test("should validate maxMemberCount", async () => {
      const doc = new TestDocument({
        title: "Too Many Tags",
        tags: new Set([
          "tag1",
          "tag2",
          "tag3",
          "tag4",
          "tag5",
          "tag6",
          "tag7",
          "tag8",
          "tag9",
          "tag10",
          "tag11",
        ]),
      });

      await expect(doc.save()).rejects.toThrow(ValidationError);
    });

    test("should validate maxStringLength", async () => {
      const longTag = "a".repeat(51); // Exceeds maxStringLength of 50
      const doc = new TestDocument({
        title: "Long Tag Test",
        tags: new Set([longTag]),
      });

      await expect(doc.save()).rejects.toThrow(ValidationError);
    });

    test("should allow valid string lengths", async () => {
      const validTag = "a".repeat(50); // Exactly maxStringLength
      const doc = new TestDocument({
        title: "Valid Tag Test",
        tags: new Set([validTag]),
      });

      await expect(doc.save()).resolves.not.toThrow();
    });

    test("should reject non-string values", async () => {
      const doc = new TestDocument({
        title: "Invalid Type Test",
        tags: new Set([123, "valid"]), // Number in set
      });

      await expect(doc.save()).rejects.toThrow(ValidationError);
    });
  });

  describe("StringSetField Filter Operations", () => {
    test("should filter with $contains operator", async () => {
      const result = await TestDocument.queryByIndex(
        "byStatus",
        "published",
        null,
        {
          filter: {
            tags: { $contains: "javascript" },
          },
        },
      );

      expect(result.items).toHaveLength(2);
      expect(result.items.map((d) => d.title).sort()).toEqual([
        "JavaScript Guide",
        "React Tutorial",
      ]);
    });

    test("should filter with $size operator using exact number", async () => {
      const result = await TestDocument.queryByIndex(
        "byStatus",
        "published",
        null,
        {
          filter: {
            tags: { $size: 3 },
          },
        },
      );

      expect(result.items).toHaveLength(2);
      expect(result.items.map((d) => d.title).sort()).toEqual([
        "JavaScript Guide",
        "React Tutorial",
      ]);
    });

    test("should filter with $size operator using comparison", async () => {
      const result = await TestDocument.queryByIndex(
        "byStatus",
        "published",
        null,
        {
          filter: {
            tags: { $size: { $gt: 1 } },
          },
        },
      );

      expect(result.items).toHaveLength(2);
      expect(result.items.map((d) => d.title).sort()).toEqual([
        "JavaScript Guide",
        "React Tutorial",
      ]);
    });

    test("should filter with $size operator finding small sets", async () => {
      const result = await TestDocument.queryByIndex(
        "byStatus",
        "draft",
        null,
        {
          filter: {
            tags: { $size: 1 },
          },
        },
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Draft Article");
    });

    test("should filter for empty sets using $exists", async () => {
      // Note: Empty sets are stored as null in DynamoDB, so we use $exists: false
      // to find items with empty categories
      const result = await TestDocument.queryByIndex(
        "byStatus",
        "draft",
        null,
        {
          filter: {
            categories: { $exists: false },
          },
        },
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Draft Article");
    });

    test("should combine $contains and $size in filter", async () => {
      const result = await TestDocument.queryByIndex(
        "byStatus",
        "published",
        null,
        {
          filter: {
            $and: [
              { tags: { $contains: "javascript" } },
              { categories: { $size: 2 } },
            ],
          },
        },
      );

      expect(result.items).toHaveLength(2);
    });
  });

  describe("StringSetField Update Operations", () => {
    test("should handle adding items to existing set", async () => {
      const doc = documents[0]; // JavaScript Guide

      // Add new tags (direct mutation)
      doc.tags.add("advanced");
      doc.tags.add("guide");

      await doc.save();

      // Reload and verify
      const reloaded = await TestDocument.find(doc.docId);
      expect(reloaded.tags.has("javascript")).toBe(true); // Original
      expect(reloaded.tags.has("programming")).toBe(true); // Original
      expect(reloaded.tags.has("web")).toBe(true); // Original
      expect(reloaded.tags.has("advanced")).toBe(true); // New
      expect(reloaded.tags.has("guide")).toBe(true); // New
      expect(reloaded.tags.size).toBe(5);
    });

    test("should handle removing items from existing set", async () => {
      const doc = documents[1]; // React Tutorial

      // Remove a tag (direct mutation)
      doc.tags.delete("frontend");

      await doc.save();

      // Reload and verify
      const reloaded = await TestDocument.find(doc.docId);
      expect(reloaded.tags.has("react")).toBe(true);
      expect(reloaded.tags.has("javascript")).toBe(true);
      expect(reloaded.tags.has("frontend")).toBe(false); // Removed
      expect(reloaded.tags.size).toBe(2);
    });

    test("should handle replacing entire set", async () => {
      const doc = documents[0]; // JavaScript Guide

      // Replace entire set
      doc.tags = new Set(["new", "replacement", "tags"]);

      await doc.save();

      // Reload and verify
      const reloaded = await TestDocument.find(doc.docId);
      expect(reloaded.tags.has("javascript")).toBe(false); // Old removed
      expect(reloaded.tags.has("programming")).toBe(false); // Old removed
      expect(reloaded.tags.has("new")).toBe(true); // New
      expect(reloaded.tags.has("replacement")).toBe(true); // New
      expect(reloaded.tags.has("tags")).toBe(true); // New
      expect(reloaded.tags.size).toBe(3);
    });

    test("should handle setting to empty set", async () => {
      const doc = documents[0]; // JavaScript Guide

      // Clear the set
      doc.tags = new Set();

      await doc.save();

      // Reload and verify
      const reloaded = await TestDocument.find(doc.docId);
      expect(reloaded.tags.size).toBe(0);
    });

    test("should handle mixed add and delete operations (uses ADD/DELETE)", async () => {
      const doc = documents[0]; // JavaScript Guide with ["javascript", "programming", "web"]

      // Make a complex change: remove some, add some (direct mutations)
      doc.tags.delete("programming"); // Remove
      doc.tags.delete("web"); // Remove
      doc.tags.add("frontend"); // Add
      doc.tags.add("tutorial"); // Add
      doc.tags.add("beginner"); // Add

      await doc.save();

      // Reload and verify
      const reloaded = await TestDocument.find(doc.docId);
      expect(reloaded.tags.has("javascript")).toBe(true); // Kept
      expect(reloaded.tags.has("programming")).toBe(false); // Removed
      expect(reloaded.tags.has("web")).toBe(false); // Removed
      expect(reloaded.tags.has("frontend")).toBe(true); // Added
      expect(reloaded.tags.has("tutorial")).toBe(true); // Added
      expect(reloaded.tags.has("beginner")).toBe(true); // Added
      expect(reloaded.tags.size).toBe(4);
    });

    test("should handle direct mutations without get/set", async () => {
      const doc = documents[0]; // JavaScript Guide

      // Verify direct mutations work
      doc.tags.add("newTag1");
      doc.tags.add("newTag2");
      doc.tags.delete("programming");

      // Verify changes are tracked
      expect(doc.hasChanges()).toBe(true);
      expect(doc._changes.has("tags")).toBe(true);

      await doc.save();

      // Reload and verify
      const reloaded = await TestDocument.find(doc.docId);
      expect(reloaded.tags.has("javascript")).toBe(true); // Original kept
      expect(reloaded.tags.has("programming")).toBe(false); // Removed
      expect(reloaded.tags.has("web")).toBe(true); // Original kept
      expect(reloaded.tags.has("newTag1")).toBe(true); // Added
      expect(reloaded.tags.has("newTag2")).toBe(true); // Added
      expect(reloaded.tags.size).toBe(4);
    });

    test("should handle clear operation", async () => {
      const doc = documents[0]; // JavaScript Guide

      // Clear all tags using direct mutation
      doc.tags.clear();

      // Verify changes are tracked
      expect(doc.hasChanges()).toBe(true);
      expect(doc._changes.has("tags")).toBe(true);

      await doc.save();

      // Reload and verify
      const reloaded = await TestDocument.find(doc.docId);
      expect(reloaded.tags.size).toBe(0);
    });

    test("should maintain backward compatibility with get/set pattern", async () => {
      const doc = documents[0]; // JavaScript Guide

      // Old pattern should still work
      const currentTags = doc.tags;
      currentTags.add("backwardCompatible");
      doc.tags = currentTags;

      await doc.save();

      // Reload and verify
      const reloaded = await TestDocument.find(doc.docId);
      expect(reloaded.tags.has("backwardCompatible")).toBe(true);
    });
  });

  describe("StringSetField Index Error", () => {
    test("should throw error when trying to index a StringSetField", () => {
      expect(() => {
        class InvalidModel extends BaoModel {
          static modelPrefix = "iv";

          static fields = {
            id: UlidField({ required: true, autoAssign: true }),
            tags: StringSetField({ maxStringLength: 50, maxMemberCount: 10 }),
          };

          static primaryKey = PrimaryKeyConfig("id");

          // This should throw an error - StringSetField cannot be indexed
          static indexes = {
            byTags: IndexConfig("tags", "id", GSI_INDEX_ID1),
          };
        }

        // Trigger the model registration which should validate the index
        const manager = initTestModelsWithTenant(testConfig, testId);
        manager.registerModel(InvalidModel);
      }).toThrow(ConfigurationError);
    });

    test("should throw error when trying to use StringSetField as sort key", () => {
      expect(() => {
        class InvalidSortModel extends BaoModel {
          static modelPrefix = "is";

          static fields = {
            id: UlidField({ required: true, autoAssign: true }),
            status: StringField({ required: true }),
            tags: StringSetField({ maxStringLength: 50, maxMemberCount: 10 }),
          };

          static primaryKey = PrimaryKeyConfig("id");

          // This should throw an error - StringSetField cannot be used as sort key
          static indexes = {
            byStatus: IndexConfig("status", "tags", GSI_INDEX_ID1),
          };
        }

        const manager = initTestModelsWithTenant(testConfig, testId);
        manager.registerModel(InvalidSortModel);
      }).toThrow(ConfigurationError);
    });
  });

  describe("StringSetField Error Handling", () => {
    test("should return empty results for unsupported operators", async () => {
      // $gt is not a meaningful operator for sets, but DynamoDB accepts it and returns empty results
      const result = await TestDocument.queryByIndex(
        "byStatus",
        "published",
        null,
        {
          filter: {
            tags: { $gt: "invalid" },
          },
        },
      );

      expect(result.items).toHaveLength(0);
    });

    test("should reject invalid $size values", async () => {
      await expect(
        TestDocument.queryByIndex("byStatus", "published", null, {
          filter: {
            tags: { $size: "invalid" },
          },
        }),
      ).rejects.toThrow(ValidationError);
    });

    test("should return empty results for negative $size values", async () => {
      // Negative size doesn't make sense but DynamoDB handles it gracefully
      const result = await TestDocument.queryByIndex(
        "byStatus",
        "published",
        null,
        {
          filter: {
            tags: { $size: -1 },
          },
        },
      );

      expect(result.items).toHaveLength(0);
    });
  });
});
