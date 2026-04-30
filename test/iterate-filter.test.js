const dynamoBao = require("../src");
const { TenantContext } = dynamoBao;
const testConfig = require("./config");
const {
  cleanupTestData,
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");
const { encodeCursor } = require("../src/iteration-cursor");

class TestIterableUser extends dynamoBao.BaoModel {
  static modelPrefix = "iu";
  static iterable = true;
  static iterationBuckets = 5;

  static fields = {
    userId: dynamoBao.fields.UlidField({ autoAssign: true, required: true }),
    name: dynamoBao.fields.StringField({ required: true }),
    email: dynamoBao.fields.StringField({ required: true }),
    status: dynamoBao.fields.StringField({ required: true }),
    score: dynamoBao.fields.IntegerField({ defaultValue: 0 }),
  };

  static primaryKey = dynamoBao.PrimaryKeyConfig("userId", "modelPrefix");
}

class TestSingleBucketUser extends dynamoBao.BaoModel {
  static modelPrefix = "su";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    userId: dynamoBao.fields.UlidField({ autoAssign: true, required: true }),
    name: dynamoBao.fields.StringField({ required: true }),
    email: dynamoBao.fields.StringField({ required: true }),
    status: dynamoBao.fields.StringField({ required: true }),
  };

  static primaryKey = dynamoBao.PrimaryKeyConfig("userId", "modelPrefix");
}

class TestManyBucketUser extends dynamoBao.BaoModel {
  static modelPrefix = "mb";
  static iterable = true;
  static iterationBuckets = 20;

  static fields = {
    userId: dynamoBao.fields.UlidField({ autoAssign: true, required: true }),
    name: dynamoBao.fields.StringField({ required: true }),
    status: dynamoBao.fields.StringField({ required: true }),
  };

  static primaryKey = dynamoBao.PrimaryKeyConfig("userId", "modelPrefix");
}

class TestNonIterableUser extends dynamoBao.BaoModel {
  static modelPrefix = "nu";
  static iterable = false;

  static fields = {
    userId: dynamoBao.fields.UlidField({ autoAssign: true, required: true }),
    name: dynamoBao.fields.StringField({ required: true }),
    status: dynamoBao.fields.StringField({ required: true }),
  };

  static primaryKey = dynamoBao.PrimaryKeyConfig("userId", "modelPrefix");
}

let testId, IterableUser, SingleBucketUser, ManyBucketUser, NonIterableUser;

async function walkAll(Model, options = {}) {
  const items = [];
  let cursor = null;
  let calls = 0;
  do {
    const page = await Model.iterateFilter({ ...options, cursor });
    items.push(...page.items);
    cursor = page.cursor;
    calls += 1;
    if (calls > 1000) throw new Error("walkAll exceeded 1000 pages");
  } while (cursor);
  return { items, calls };
}

describe("iterateFilter", () => {
  beforeEach(async () => {
    testId = ulid();
    const manager = initTestModelsWithTenant(testConfig, testId);
    manager.registerModel(TestIterableUser);
    manager.registerModel(TestSingleBucketUser);
    manager.registerModel(TestManyBucketUser);
    manager.registerModel(TestNonIterableUser);

    await cleanupTestData(testId);
    await verifyCleanup(testId);

    IterableUser = manager.getModel("TestIterableUser");
    SingleBucketUser = manager.getModel("TestSingleBucketUser");
    ManyBucketUser = manager.getModel("TestManyBucketUser");
    NonIterableUser = manager.getModel("TestNonIterableUser");
  });

  afterEach(async () => {
    if (testId) {
      await cleanupTestDataByIteration(testId, [
        IterableUser,
        SingleBucketUser,
        ManyBucketUser,
      ]);
    }
    TenantContext.clearTenant();
  });

  describe("API surface and validation", () => {
    test("throws on non-iterable model", async () => {
      await expect(NonIterableUser.iterateFilter({})).rejects.toThrow(
        /not configured as iterable/,
      );
    });

    test("rejects invalid limit", async () => {
      await expect(IterableUser.iterateFilter({ limit: 0 })).rejects.toThrow(
        /limit must be a positive integer/,
      );
      await expect(IterableUser.iterateFilter({ limit: -1 })).rejects.toThrow(
        /limit must be a positive integer/,
      );
      await expect(IterableUser.iterateFilter({ limit: 1.5 })).rejects.toThrow(
        /limit must be a positive integer/,
      );
    });

    test("rejects invalid concurrency", async () => {
      await expect(
        IterableUser.iterateFilter({ concurrency: 0 }),
      ).rejects.toThrow(/concurrency/);
    });

    test("rejects invalid maxScannedItems", async () => {
      await expect(
        IterableUser.iterateFilter({ maxScannedItems: 0 }),
      ).rejects.toThrow(/maxScannedItems/);
    });

    test("rejects unknown filter field", async () => {
      await expect(
        IterableUser.iterateFilter({ filter: { notAField: "x" } }),
      ).rejects.toThrow(/Unknown field/);
    });
  });

  describe("Empty model", () => {
    test("returns empty items and null cursor in one call", async () => {
      const page = await IterableUser.iterateFilter({ limit: 50 });
      expect(page.items).toEqual([]);
      expect(page.cursor).toBeNull();
      expect(page.count).toBe(0);
    });
  });

  describe("Basic filter (single page)", () => {
    test("returns matching items across all buckets", async () => {
      for (let i = 0; i < 10; i++) {
        await IterableUser.create({
          name: `User ${i}`,
          email: `u${i}@example.com`,
          status: i % 2 === 0 ? "active" : "inactive",
        });
      }

      const page = await IterableUser.iterateFilter({
        filter: { status: "active" },
        limit: 100,
      });

      expect(page.items.length).toBe(5);
      page.items.forEach((u) => expect(u.status).toBe("active"));
      expect(page.cursor).toBeNull();
    });

    test("no filter returns all items", async () => {
      for (let i = 0; i < 8; i++) {
        await IterableUser.create({
          name: `User ${i}`,
          email: `u${i}@example.com`,
          status: "active",
        });
      }

      const { items } = await walkAll(IterableUser, { limit: 50 });
      expect(items.length).toBe(8);
    });
  });

  describe("Pagination (multi-page)", () => {
    test("walking cursor to completion covers all matches with no duplicates", async () => {
      const created = [];
      for (let i = 0; i < 25; i++) {
        const u = await IterableUser.create({
          name: `User ${i}`,
          email: `u${i}@example.com`,
          status: "active",
        });
        created.push(u);
      }

      // Constrain maxScannedItems so each call advances only a fraction of
      // each bucket — forcing the cursor to actually round-trip multiple times.
      const { items, calls } = await walkAll(IterableUser, {
        filter: { status: "active" },
        limit: 5,
        maxScannedItems: 10,
      });

      expect(items.length).toBe(25);
      expect(calls).toBeGreaterThan(1);

      const ids = items.map((i) => i.userId);
      expect(new Set(ids).size).toBe(25);

      const expected = new Set(created.map((u) => u.userId));
      expect(new Set(ids)).toEqual(expected);
    }, 60000);
  });

  describe("Single-bucket model", () => {
    test("paginates correctly", async () => {
      for (let i = 0; i < 10; i++) {
        await SingleBucketUser.create({
          name: `User ${i}`,
          email: `u${i}@example.com`,
          status: "active",
        });
      }

      const { items, calls } = await walkAll(SingleBucketUser, {
        limit: 3,
        maxScannedItems: 3,
      });
      expect(items.length).toBe(10);
      expect(calls).toBeGreaterThan(1);
      const ids = items.map((i) => i.userId);
      expect(new Set(ids).size).toBe(10);
    }, 30000);
  });

  describe("Cursor validation across calls", () => {
    test("malformed cursor throws", async () => {
      await expect(
        IterableUser.iterateFilter({ cursor: "garbage" }),
      ).rejects.toThrow();
    });

    test("cursor with wrong bucket count throws", async () => {
      const fake = encodeCursor({
        modelPrefix: IterableUser.modelPrefix,
        tenantId: testId,
        iterationBuckets: 99,
        queue: [[0, { _iter_pk: "x", _iter_sk: "y", _pk: "p", _sk: "s" }]],
      });
      await expect(
        IterableUser.iterateFilter({ cursor: fake }),
      ).rejects.toThrow(/bucket count changed/);
    });

    test("cursor from one model rejected by another", async () => {
      const fake = encodeCursor({
        modelPrefix: IterableUser.modelPrefix,
        tenantId: testId,
        iterationBuckets: IterableUser.iterationBuckets,
        queue: [[0, { _iter_pk: "x", _iter_sk: "y", _pk: "p", _sk: "s" }]],
      });
      await expect(
        SingleBucketUser.iterateFilter({ cursor: fake }),
      ).rejects.toThrow(/model mismatch|bucket count/);
    });
  });

  describe("Tenant isolation", () => {
    test("cursor from one tenant rejected in another", async () => {
      const tenantA = `tenA_${ulid()}`;
      const tenantB = `tenB_${ulid()}`;

      try {
        const fakeFromA = encodeCursor({
          modelPrefix: IterableUser.modelPrefix,
          tenantId: tenantA,
          iterationBuckets: IterableUser.iterationBuckets,
          queue: [[0, { _iter_pk: "x", _iter_sk: "y", _pk: "p", _sk: "s" }]],
        });

        TenantContext.setCurrentTenant(tenantB);
        await expect(
          IterableUser.iterateFilter({ cursor: fakeFromA }),
        ).rejects.toThrow(/tenant mismatch/);
      } finally {
        TenantContext.clearTenant();
      }
    });

    test("iterateFilter sees only current tenant's items", async () => {
      const tenantA = `tenA2_${ulid()}`;
      const tenantB = `tenB2_${ulid()}`;

      try {
        TenantContext.setCurrentTenant(tenantA);
        await IterableUser.create({
          name: "A1",
          email: "a1@example.com",
          status: "active",
        });

        TenantContext.setCurrentTenant(tenantB);
        await IterableUser.create({
          name: "B1",
          email: "b1@example.com",
          status: "active",
        });

        TenantContext.setCurrentTenant(tenantA);
        const { items } = await walkAll(IterableUser, { limit: 50 });
        expect(items.length).toBe(1);
        expect(items[0].name).toBe("A1");
      } finally {
        TenantContext.setCurrentTenant(tenantA);
        await cleanupTestData(tenantA);
        TenantContext.setCurrentTenant(tenantB);
        await cleanupTestData(tenantB);
        TenantContext.clearTenant();
      }
    }, 60000);
  });

  describe("Sparse filter with maxScannedItems", () => {
    test("bounded scan returns cursor when budget exhausted", async () => {
      for (let i = 0; i < 24; i++) {
        await IterableUser.create({
          name: `User ${i}`,
          email: `u${i}@example.com`,
          status: "active",
        });
      }
      await IterableUser.create({
        name: "Special",
        email: "special@example.com",
        status: "needle",
      });

      let cursor = null;
      let totalCalls = 0;
      let found = null;
      do {
        const page = await IterableUser.iterateFilter({
          filter: { status: "needle" },
          limit: 5,
          maxScannedItems: 5,
          cursor,
        });
        if (!found && page.items.length > 0) {
          found = page.items.find((i) => i.status === "needle");
        }
        cursor = page.cursor;
        totalCalls += 1;
        if (totalCalls > 50) throw new Error("too many pages");
      } while (cursor);

      expect(found).toBeDefined();
      expect(found.name).toBe("Special");
      expect(totalCalls).toBeGreaterThan(1);
    }, 90000);
  });

  describe("Operator coverage", () => {
    beforeEach(async () => {
      for (let i = 0; i < 10; i++) {
        await IterableUser.create({
          name: `User ${i}`,
          email: `u${i}@test.com`,
          status: i < 3 ? "admin" : i < 7 ? "active" : "inactive",
          score: i * 10,
        });
      }
    }, 60000);

    test("$gt", async () => {
      const { items } = await walkAll(IterableUser, {
        filter: { score: { $gt: 50 } },
        limit: 100,
      });
      expect(items.length).toBe(4);
      items.forEach((u) => expect(u.score).toBeGreaterThan(50));
    });

    test("$in", async () => {
      const { items } = await walkAll(IterableUser, {
        filter: { status: { $in: ["admin", "inactive"] } },
        limit: 100,
      });
      expect(items.length).toBe(6);
    });

    test("$or", async () => {
      const { items } = await walkAll(IterableUser, {
        filter: {
          $or: [{ status: "admin" }, { score: { $gte: 80 } }],
        },
        limit: 100,
      });
      expect(items.length).toBe(5);
    });
  });

  describe("Fairness", () => {
    test("within a single call, all 20 buckets are queried before any repeat", async () => {
      // Seed enough items to reach all 20 buckets via hash distribution but
      // few enough per bucket that none requires multiple pages — this lets
      // us prove the FIFO scheduler hits each bucket exactly once.
      const N = 60;
      for (let i = 0; i < N; i++) {
        await ManyBucketUser.create({
          name: `User ${i}`,
          status: "active",
        });
      }

      const calls = [];
      const original = ManyBucketUser._filterPartitionPage;
      ManyBucketUser._filterPartitionPage = function (...args) {
        calls.push(args[0]);
        return original.apply(this, args);
      };

      try {
        // limit > N forces the loop to keep going past round 1, so all
        // 20 buckets get queried (4 rounds of concurrency=5).
        await ManyBucketUser.iterateFilter({
          limit: 200,
          concurrency: 5,
          maxScannedItems: 1000,
        });

        const firstTwenty = calls.slice(0, 20);
        expect(new Set(firstTwenty).size).toBe(20);
      } finally {
        delete ManyBucketUser._filterPartitionPage;
      }
    }, 180000);

    test("queue order survives the cursor (across-call rotation)", async () => {
      const N = 60;
      for (let i = 0; i < N; i++) {
        await ManyBucketUser.create({
          name: `User ${i}`,
          status: "active",
        });
      }

      const calls = [];
      const original = ManyBucketUser._filterPartitionPage;
      ManyBucketUser._filterPartitionPage = function (...args) {
        calls.push(args[0]);
        return original.apply(this, args);
      };

      try {
        // Each call queries one round (5 buckets), then the cursor preserves
        // the queue so the next call queries the next 5 — covering all 20
        // buckets across 4 cursor-paged calls.
        let cursor = null;
        let pages = 0;
        while (pages < 6) {
          const page = await ManyBucketUser.iterateFilter({
            limit: 1,
            concurrency: 5,
            maxScannedItems: 5,
            cursor,
          });
          cursor = page.cursor;
          pages += 1;
          if (!cursor) break;
        }

        expect(new Set(calls).size).toBe(20);
      } finally {
        delete ManyBucketUser._filterPartitionPage;
      }
    }, 180000);
  });

  describe("Self-containment of cursor", () => {
    test("cursor encoded in one call resumes correctly in another", async () => {
      const collected = [];
      let cursor;

      // 60 records across 5 buckets ~= 12/bucket; with default perPageLimit
      // most buckets return a LastEvaluatedKey, so the first page produces
      // a non-null cursor we can round-trip.
      for (let i = 0; i < 60; i++) {
        await IterableUser.create({
          name: `User ${i}`,
          email: `u${i}@example.com`,
          status: "active",
        });
      }
      const page = await IterableUser.iterateFilter({ limit: 3, maxScannedItems: 10 });
      collected.push(...page.items);
      cursor = page.cursor;

      expect(cursor).toBeTruthy();

      let next = cursor;
      let safety = 0;
      while (next) {
        const p = await IterableUser.iterateFilter({ limit: 3, cursor: next });
        collected.push(...p.items);
        next = p.cursor;
        if (++safety > 100) throw new Error("safety break");
      }

      expect(collected.length).toBe(60);
      const ids = collected.map((i) => i.userId);
      expect(new Set(ids).size).toBe(60);
    }, 120000);
  });
});
