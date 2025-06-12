const dynamoBao = require("../src");
const { TenantContext } = dynamoBao;
const testConfig = require("./config");
const { BaoModel, PrimaryKeyConfig } = require("../src/model");
const { StringField, IntegerField, BooleanField } = require("../src/fields");
const { cleanupTestDataByIteration, verifyCleanup, initTestModelsWithTenant } = require("./utils/test-utils");
const { ulid } = require("ulid");

const printPerfStats = false;
const PERF_THRESHOLDS = {
  simple: 0.005, // 5 microseconds per instance
  complex: 0.05, // 50 microseconds per instance
  sparse: 0.05, // 50 microseconds per instance
};

let testId;

// Simple model with just two fields
class SimpleModel extends BaoModel {
  static modelPrefix = "sm";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    id: StringField({ required: true }),
    name: StringField(),
  };

  static primaryKey = PrimaryKeyConfig("id");
}

// Complex model with many fields and different types
class ComplexModel extends BaoModel {
  static modelPrefix = "cm";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    id: StringField({ required: true }),
    name: StringField(),
    age: IntegerField(),
    email: StringField(),
    isActive: BooleanField(),
    address: StringField(),
    phone: StringField(),
    score: IntegerField(),
    lastLogin: StringField(),
    preferences: StringField(),
    status: StringField(),
    metadata: StringField(),
    // Additional fields
    title: StringField(),
    description: StringField(),
    createdAt: StringField(),
    updatedAt: StringField(),
    category: StringField(),
    tags: StringField(),
    rating: IntegerField(),
    views: IntegerField(),
    likes: IntegerField(),
    shares: IntegerField(),
    comments: IntegerField(),
    priority: IntegerField(),
    isPublic: BooleanField(),
    isArchived: BooleanField(),
    isFeatured: BooleanField(),
    isSponsored: BooleanField(),
    isPremium: BooleanField(),
    region: StringField(),
    country: StringField(),
    city: StringField(),
    zipCode: StringField(),
    latitude: StringField(),
    longitude: StringField(),
    website: StringField(),
    socialMedia: StringField(),
    department: StringField(),
    role: StringField(),
    salary: IntegerField(),
    experience: IntegerField(),
    education: StringField(),
    skills: StringField(),
    languages: StringField(),
    certifications: StringField(),
    projects: StringField(),
    supervisor: StringField(),
    team: StringField(),
    division: StringField(),
    costCenter: StringField(),
    budget: IntegerField(),
    revenue: IntegerField(),
    expenses: IntegerField(),
    profit: IntegerField(),
    quarter: IntegerField(),
    year: IntegerField(),
  };

  static primaryKey = PrimaryKeyConfig("id");
}

describe("Performance Tests - Model Instantiation", () => {
  beforeEach(async () => {
    testId = ulid();

    const manager = initTestModelsWithTenant(testConfig, testId);

    manager.registerModel(SimpleModel);
    manager.registerModel(ComplexModel);

    if (testId) {
      await cleanupTestDataByIteration(testId, [SimpleModel, ComplexModel]);
      await verifyCleanup(testId, [SimpleModel, ComplexModel]);
    }
  });

  afterEach(async () => {
    TenantContext.clearTenant();
    if (testId) {
      await cleanupTestDataByIteration(testId, [SimpleModel, ComplexModel]);
      await verifyCleanup(testId, [SimpleModel, ComplexModel]);
    }
  });

  const createInstances = (Model, count) => {
    const instances = [];
    for (let i = 0; i < count; i++) {
      const data = {
        id: `test-${i}`,
        name: `Test ${i}`,
      };

      // Add extra fields for complex model
      if (Model === ComplexModel) {
        Object.assign(data, {
          age: 25,
          email: `test${i}@example.com`,
          isActive: true,
          address: "123 Test St",
          phone: "555-0000",
          score: 100,
          lastLogin: new Date().toISOString(),
          preferences: '{"theme":"dark"}',
          status: "active",
          metadata: '{"version":"1.0"}',
          // Additional field values
          title: `Title ${i}`,
          description: `Description for item ${i}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          category: "Test Category",
          tags: '["test", "performance"]',
          rating: 4,
          views: 1000,
          likes: 50,
          shares: 25,
          comments: 10,
          priority: 1,
          isPublic: true,
          isArchived: false,
          isFeatured: true,
          isSponsored: false,
          isPremium: true,
          region: "North",
          country: "Test Country",
          city: "Test City",
          zipCode: "12345",
          latitude: "40.7128",
          longitude: "-74.0060",
          website: "https://example.com",
          socialMedia: '{"twitter": "@test"}',
          department: "Engineering",
          role: "Developer",
          salary: 100000,
          experience: 5,
          education: "Masters",
          skills: '["JavaScript", "Python"]',
          languages: '["English", "Spanish"]',
          certifications: '["AWS", "GCP"]',
          projects: '["Project A", "Project B"]',
          supervisor: "John Doe",
          team: "Alpha",
          division: "R&D",
          costCenter: "CC001",
          budget: 1000000,
          revenue: 2000000,
          expenses: 1500000,
          profit: 500000,
          quarter: 2,
          year: 2024,
        });
      }

      instances.push(new Model(data));
    }
    return instances;
  };

  const logPerfStats = (label, results) => {
    if (printPerfStats) {
      console.log(`${label}:`, results);
    }
  };

  const runPerformanceTest = (Model, count) => {
    const start = process.hrtime.bigint();
    const instances = createInstances(Model, count);
    const end = process.hrtime.bigint();

    const timeInMs = Number(end - start) / 1_000_000;
    return {
      timeInMs,
      instanceCount: instances.length,
      avgTimePerInstance: timeInMs / count,
    };
  };

  test("should measure instantiation performance for 1k instances", () => {
    const count = 1000;

    const simpleResults = runPerformanceTest(SimpleModel, count);
    const complexResults = runPerformanceTest(ComplexModel, count);

    logPerfStats(`Simple Model (${count} instances)`, simpleResults);
    logPerfStats(`Complex Model (${count} instances)`, complexResults);

    expect(simpleResults.instanceCount).toBe(count);
    expect(complexResults.instanceCount).toBe(count);
    expect(simpleResults.avgTimePerInstance).toBeLessThan(
      PERF_THRESHOLDS.simple,
    );
    expect(complexResults.avgTimePerInstance).toBeLessThan(
      PERF_THRESHOLDS.complex,
    );
  });

  test("should measure instantiation performance for 10k instances", () => {
    const count = 10000;

    const simpleResults = runPerformanceTest(SimpleModel, count);
    const complexResults = runPerformanceTest(ComplexModel, count);

    logPerfStats(`Simple Model (${count} instances)`, simpleResults);
    logPerfStats(`Complex Model (${count} instances)`, complexResults);

    expect(simpleResults.instanceCount).toBe(count);
    expect(complexResults.instanceCount).toBe(count);
    expect(simpleResults.avgTimePerInstance).toBeLessThan(
      PERF_THRESHOLDS.simple,
    );
    expect(complexResults.avgTimePerInstance).toBeLessThan(
      PERF_THRESHOLDS.complex,
    );
  });

  test("should measure instantiation performance for sparse complex model (10k instances)", () => {
    const count = 10000;

    const createSparseInstances = (count) => {
      const instances = [];
      for (let i = 0; i < count; i++) {
        // Only populate 5 fields for the sparse test
        const data = {
          id: `test-${i}`,
          name: `Test ${i}`,
          email: `test${i}@example.com`,
          isActive: true,
          score: 100,
        };

        instances.push(new ComplexModel(data));
      }
      return instances;
    };

    const start = process.hrtime.bigint();
    const instances = createSparseInstances(count);
    const end = process.hrtime.bigint();

    const timeInMs = Number(end - start) / 1_000_000;
    const results = {
      timeInMs,
      instanceCount: instances.length,
      avgTimePerInstance: timeInMs / count,
    };

    logPerfStats(`Sparse Complex Model (${count} instances)`, results);

    expect(results.instanceCount).toBe(count);
    expect(results.avgTimePerInstance).toBeLessThan(PERF_THRESHOLDS.sparse);
  });
});
