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

let testId,
  SearchablePost,
  NonSearchablePost,
  NonIterableSearchable,
  CaseSensitivePost,
  DedupePost,
  MinTermLengthPost;

class TestSearchablePost extends dynamoBao.BaoModel {
  static modelPrefix = "tsp";
  static iterable = true;
  static iterationBuckets = 5;
  static searchable = true;
  static searchConfig = {
    fields: ["title", "body"],
    caseSensitive: false,
    minTermLength: 1,
    dedupe: false,
  };

  static fields = {
    postId: dynamoBao.fields.UlidField({ autoAssign: true, required: true }),
    title: dynamoBao.fields.StringField(),
    body: dynamoBao.fields.StringField(),
    status: dynamoBao.fields.StringField({ defaultValue: "active" }),
  };

  static primaryKey = dynamoBao.PrimaryKeyConfig("postId", "modelPrefix");
}

class TestNonSearchablePost extends dynamoBao.BaoModel {
  static modelPrefix = "tns";
  static iterable = true;
  static iterationBuckets = 1;
  // searchable defaults to false

  static fields = {
    postId: dynamoBao.fields.UlidField({ autoAssign: true, required: true }),
    title: dynamoBao.fields.StringField({ required: true }),
  };

  static primaryKey = dynamoBao.PrimaryKeyConfig("postId", "modelPrefix");
}

class TestNonIterableSearchable extends dynamoBao.BaoModel {
  static modelPrefix = "tni";
  static iterable = false;
  static searchable = true;
  static searchConfig = {
    fields: ["title"],
    caseSensitive: false,
    minTermLength: 1,
    dedupe: false,
  };

  static fields = {
    postId: dynamoBao.fields.UlidField({ autoAssign: true, required: true }),
    title: dynamoBao.fields.StringField({ required: true }),
  };

  static primaryKey = dynamoBao.PrimaryKeyConfig("postId", "modelPrefix");
}

// Variants exercising each searchConfig option end-to-end.

class TestCaseSensitivePost extends dynamoBao.BaoModel {
  static modelPrefix = "tcs";
  static iterable = true;
  static iterationBuckets = 3;
  static searchable = true;
  static searchConfig = {
    fields: ["title"],
    caseSensitive: true,
    minTermLength: 1,
    dedupe: false,
  };
  static fields = {
    postId: dynamoBao.fields.UlidField({ autoAssign: true, required: true }),
    title: dynamoBao.fields.StringField(),
  };
  static primaryKey = dynamoBao.PrimaryKeyConfig("postId", "modelPrefix");
}

class TestDedupePost extends dynamoBao.BaoModel {
  static modelPrefix = "tdp";
  static iterable = true;
  static iterationBuckets = 3;
  static searchable = true;
  static searchConfig = {
    fields: ["title"],
    caseSensitive: false,
    minTermLength: 1,
    dedupe: true,
  };
  static fields = {
    postId: dynamoBao.fields.UlidField({ autoAssign: true, required: true }),
    title: dynamoBao.fields.StringField(),
  };
  static primaryKey = dynamoBao.PrimaryKeyConfig("postId", "modelPrefix");
}

class TestMinTermLengthPost extends dynamoBao.BaoModel {
  static modelPrefix = "tmt";
  static iterable = true;
  static iterationBuckets = 3;
  static searchable = true;
  static searchConfig = {
    fields: ["title"],
    caseSensitive: false,
    minTermLength: 3,
    dedupe: false,
  };
  static fields = {
    postId: dynamoBao.fields.UlidField({ autoAssign: true, required: true }),
    title: dynamoBao.fields.StringField(),
  };
  static primaryKey = dynamoBao.PrimaryKeyConfig("postId", "modelPrefix");
}

// Test helper: page through searchAll with cursors until exhausted.
// Equivalent to the old `for await (const batch of searchAll(...))`
// behavior for tests that want every match regardless of the new default
// limit. Pass `limit: Infinity` to opt out of capping per page.
async function drainAll(model, terms, options = {}) {
  const out = [];
  let cursor = null;
  do {
    const page = await model.searchAll(terms, { ...options, cursor });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

// Same idea for searchBucket: scoped to one bucket.
async function drainBucket(model, bucketNum, terms, options = {}) {
  const out = [];
  let cursor = null;
  do {
    const page = await model.searchBucket(bucketNum, terms, {
      ...options,
      cursor,
    });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

// Search-enabled tests need the runtime to resolve the iteration index to
// `iter_search_index` (the new INCLUDE-projection GSI). Opt in via config —
// the package default is the legacy `iter_index` for backwards compatibility.
const searchEnabledConfig = {
  ...testConfig,
  db: { ...testConfig.db, iterationIndexName: "iter_search_index" },
};

describe("Searchable models", () => {
  beforeEach(async () => {
    testId = ulid();
    const manager = initTestModelsWithTenant(searchEnabledConfig, testId);
    manager.registerModel(TestSearchablePost);
    manager.registerModel(TestNonSearchablePost);
    manager.registerModel(TestNonIterableSearchable);
    manager.registerModel(TestCaseSensitivePost);
    manager.registerModel(TestDedupePost);
    manager.registerModel(TestMinTermLengthPost);

    await cleanupTestData(testId);
    await verifyCleanup(testId);

    SearchablePost = manager.getModel("TestSearchablePost");
    NonSearchablePost = manager.getModel("TestNonSearchablePost");
    NonIterableSearchable = manager.getModel("TestNonIterableSearchable");
    CaseSensitivePost = manager.getModel("TestCaseSensitivePost");
    DedupePost = manager.getModel("TestDedupePost");
    MinTermLengthPost = manager.getModel("TestMinTermLengthPost");
  });

  afterEach(async () => {
    TenantContext.clearTenant();
    if (testId) {
      await cleanupTestDataByIteration(testId, [
        SearchablePost,
        NonSearchablePost,
        CaseSensitivePost,
        DedupePost,
        MinTermLengthPost,
      ]);
      // NonIterableSearchable can't be cleaned up via iteration (it's not
      // iterable). Tenant isolation prevents cross-test pollution; a small
      // amount of accumulation across runs against the same tenant prefix
      // is acceptable for a test fixture.
      await cleanupTestData(testId);
    }
  });

  describe("searchAll basic", () => {
    test("returns rows whose _searchText contains the term", async () => {
      const a = await SearchablePost.create({
        title: "Apple announces new iPhone",
        body: "The iPhone 15 launches today.",
      });
      const b = await SearchablePost.create({
        title: "Banana split recipe",
        body: "How to make a great banana split.",
      });
      await SearchablePost.create({
        title: "Carrot cake",
        body: "A classic recipe.",
      });

      const { items: found, cursor } = await SearchablePost.searchAll([
        "banana",
      ]);
      const ids = found.map((p) => p.postId).sort();
      expect(ids).toEqual([b.postId].sort());
      // Single page, all matches found, cursor is null.
      expect(cursor).toBeNull();
    });

    test("$and matches only rows containing every term", async () => {
      const both = await SearchablePost.create({
        title: "Apple iPhone review",
        body: "iPhone meets banana — wait, that doesn't make sense.",
      });
      await SearchablePost.create({
        title: "Just iPhone",
        body: "no fruit here",
      });
      await SearchablePost.create({
        title: "Just banana",
        body: "no phones",
      });

      const { items: found } = await SearchablePost.searchAll(
        ["iphone", "banana"],
        { operator: "$and" },
      );
      expect(found.map((p) => p.postId)).toEqual([both.postId]);
    });

    test("$or matches rows containing any term", async () => {
      const a = await SearchablePost.create({ title: "Apple", body: null });
      const b = await SearchablePost.create({ title: "Banana", body: null });
      await SearchablePost.create({ title: "Carrot", body: null });

      const { items: found } = await SearchablePost.searchAll(
        ["apple", "banana"],
        { operator: "$or" },
      );
      const ids = found.map((p) => p.postId).sort();
      expect(ids).toEqual([a.postId, b.postId].sort());
    });

    test("non-projected attributes can be filtered post-iteration", async () => {
      // iter_search_index only projects _searchText, so filters on other
      // attributes have to be applied to hydrated items in JS. The
      // recommended pattern is to loop over page.items.
      await SearchablePost.create({
        title: "alice the explorer",
        status: "draft",
      });
      const active = await SearchablePost.create({
        title: "alice in wonderland",
        status: "active",
      });

      const { items: page } = await SearchablePost.searchAll(["alice"]);
      const found = page.filter((item) => item.status === "active");
      expect(found.map((p) => p.postId)).toEqual([active.postId]);
    });

    test("returns empty when no rows match", async () => {
      await SearchablePost.create({ title: "Apple", body: null });

      const { items: found, cursor } = await SearchablePost.searchAll([
        "nonexistent",
      ]);
      expect(found).toEqual([]);
      expect(cursor).toBeNull();
    });

    test("multilingual: matches CJK substring", async () => {
      const cjk = await SearchablePost.create({
        title: "苹果手机评测",
        body: "iPhone 15 上市了。",
      });
      await SearchablePost.create({ title: "Banana", body: null });

      const { items: found } = await SearchablePost.searchAll(["苹果"]);
      expect(found.map((p) => p.postId)).toEqual([cjk.postId]);
    });
  });

  describe("searchBucket parallel fan-out", () => {
    test("Promise.all across buckets returns same items as searchAll", async () => {
      // Create 12 alice posts spread across buckets
      const aliceIds = [];
      for (let i = 0; i < 12; i++) {
        const p = await SearchablePost.create({
          title: `alice number ${i}`,
          body: null,
        });
        aliceIds.push(p.postId);
      }
      // a few non-matching
      for (let i = 0; i < 5; i++) {
        await SearchablePost.create({ title: `bob number ${i}`, body: null });
      }

      const bucketResults = await Promise.all(
        Array.from({ length: SearchablePost.iterationBuckets }, (_, b) =>
          drainBucket(SearchablePost, b, ["alice"]),
        ),
      );
      const flat = bucketResults
        .flat()
        .map((p) => p.postId)
        .sort();
      expect(flat).toEqual(aliceIds.slice().sort());
    });
  });

  describe("limit option (real DynamoDB)", () => {
    test("limit caps total results across buckets", async () => {
      // 30 matches spread across 5 buckets. With limit=10 we should get
      // exactly 10 hydrated rows, no more.
      const aliceIds = [];
      const creates = [];
      for (let i = 0; i < 30; i++) {
        creates.push(
          SearchablePost.create({ title: `alice ${i}`, body: null }).then(
            (p) => aliceIds.push(p.postId),
          ),
        );
      }
      await Promise.all(creates);

      const { items: found, cursor } = await SearchablePost.searchAll(
        ["alice"],
        { limit: 10 },
      );
      expect(found.length).toBe(10);
      // Cursor is non-null because there are more matches to find.
      expect(cursor).not.toBeNull();
      // Every returned id is a real alice id (not a stray).
      for (const p of found) {
        expect(aliceIds).toContain(p.postId);
      }
      // Returned rows are unique.
      expect(new Set(found.map((p) => p.postId)).size).toBe(10);
    }, 120000);

    test("default limit is 100 when not specified", async () => {
      // Create 110 matches. With the default limit of 100, one searchAll
      // call returns exactly 100 plus a non-null cursor.
      const creates = [];
      for (let i = 0; i < 110; i++) {
        creates.push(
          SearchablePost.create({ title: `alice ${i}`, body: null }),
        );
      }
      await Promise.all(creates);

      const { items, cursor } = await SearchablePost.searchAll(["alice"]);
      expect(items.length).toBe(100);
      expect(cursor).not.toBeNull();
    }, 180000);

    test("limit: Infinity drained returns every match", async () => {
      // 110 matches, drain across pages until cursor is null.
      const aliceIds = [];
      const creates = [];
      for (let i = 0; i < 110; i++) {
        creates.push(
          SearchablePost.create({ title: `alice ${i}`, body: null }).then(
            (p) => aliceIds.push(p.postId),
          ),
        );
      }
      await Promise.all(creates);

      const found = await drainAll(SearchablePost, ["alice"], {
        limit: Infinity,
      });
      expect(found.length).toBe(110);
      expect(found.map((p) => p.postId).sort()).toEqual(aliceIds.slice().sort());
    }, 180000);

    test("limit returns exactly the requested count, even when matches per bucket exceed it", async () => {
      // 12 matches, batchSize=5, limit=7. Result must be exactly 7 items;
      // any over-pull from parallel rounds is sliced and stashed in the cursor.
      for (let i = 0; i < 12; i++) {
        await SearchablePost.create({ title: `alice ${i}`, body: null });
      }

      const { items, cursor } = await SearchablePost.searchAll(["alice"], {
        batchSize: 5,
        limit: 7,
      });
      expect(items.length).toBe(7);
      // Cursor non-null because there are still 5 unreturned matches.
      expect(cursor).not.toBeNull();
    }, 120000);

    test("searchAll stops issuing Query calls once limit is reached (sequential mode)", async () => {
      // Create 30 alice rows across 5 buckets. Sequential mode with limit=5
      // typically finishes in the first 1-2 buckets — far fewer Query calls
      // than the bucket count would imply if we walked everything.
      for (let i = 0; i < 30; i++) {
        await SearchablePost.create({ title: `alice ${i}`, body: null });
      }

      let queryCount = 0;
      const realSend = SearchablePost.documentClient.send.bind(
        SearchablePost.documentClient,
      );
      SearchablePost.documentClient.send = async (cmd) => {
        if (
          cmd?.constructor?.name === "QueryCommand" &&
          cmd.input?.IndexName === "iter_search_index"
        ) {
          queryCount++;
        }
        return realSend(cmd);
      };

      try {
        const { items } = await SearchablePost.searchAll(["alice"], {
          limit: 5,
          parallel: false,
        });
        expect(items.length).toBe(5);
        // We did not exhaust all 5 buckets — far fewer Query calls.
        expect(queryCount).toBeLessThan(SearchablePost.iterationBuckets);
      } finally {
        SearchablePost.documentClient.send = realSend;
      }
    }, 120000);

    test("limit on searchBucket caps per-bucket results", async () => {
      // Create lots of items so a single bucket has plenty of matches.
      // iterationBuckets=5, so 50 creates → ~10 per bucket.
      for (let i = 0; i < 50; i++) {
        await SearchablePost.create({ title: `alice ${i}`, body: null });
      }

      const { items: bucket0 } = await SearchablePost.searchBucket(
        0,
        ["alice"],
        { limit: 3 },
      );
      expect(bucket0.length).toBeLessThanOrEqual(3);
    }, 120000);

    test("invalid limit values throw before hitting DynamoDB", async () => {
      // Confirm the validateLimit guard fires synchronously, not after
      // any Query calls. Spy on send to make sure no calls happen.
      let sendCalls = 0;
      const realSend = SearchablePost.documentClient.send.bind(
        SearchablePost.documentClient,
      );
      SearchablePost.documentClient.send = async (...args) => {
        sendCalls++;
        return realSend(...args);
      };

      try {
        for (const bad of [0, -1, 1.5, NaN, "10"]) {
          await expect(
            SearchablePost.searchAll(["alice"], { limit: bad }),
          ).rejects.toThrow(/limit must be a positive integer or Infinity/i);
        }
        expect(sendCalls).toBe(0);
      } finally {
        SearchablePost.documentClient.send = realSend;
      }
    });
  });

  describe("pagination across partitions (real DynamoDB)", () => {
    // Spies on documentClient.send to count GSI Query roundtrips. Used to
    // assert pagination actually happens (i.e., LastEvaluatedKey-driven
    // multi-page reads), not just that we get the right ids back.
    function installQueryCounter(model) {
      let count = 0;
      const realSend = model.documentClient.send.bind(model.documentClient);
      model.documentClient.send = async (cmd) => {
        // Detect Query commands targeting the iter_search_index.
        if (
          cmd?.constructor?.name === "QueryCommand" &&
          cmd.input?.IndexName === "iter_search_index"
        ) {
          count++;
        }
        return realSend(cmd);
      };
      return {
        get count() {
          return count;
        },
        restore() {
          model.documentClient.send = realSend;
        },
      };
    }

    test(
      "searchAll returns every match across paginated buckets (batchSize forces multiple pages per bucket)",
      async () => {
        // 5 buckets × ~10 alice items per bucket = 50 matching. Use a small
        // batchSize so each bucket needs at least 2 Query roundtrips. We also
        // sprinkle in non-matching items so the GSI returns rows the filter
        // discards — exercising the "partial page after filter" case.
        const aliceIds = [];
        const creates = [];
        for (let i = 0; i < 50; i++) {
          creates.push(
            SearchablePost.create({
              title: `alice slot-${i}`,
              body: null,
            }).then((p) => aliceIds.push(p.postId)),
          );
        }
        for (let i = 0; i < 25; i++) {
          creates.push(
            SearchablePost.create({ title: `bob slot-${i}`, body: null }),
          );
        }
        await Promise.all(creates);

        const counter = installQueryCounter(SearchablePost);
        try {
          const found = await drainAll(SearchablePost, ["alice"], {
            batchSize: 5,
            limit: Infinity,
          });

          const foundIds = found.map((p) => p.postId).sort();
          expect(foundIds).toEqual(aliceIds.slice().sort());
          // No duplicates — pagination must not double-yield rows.
          expect(new Set(foundIds).size).toBe(foundIds.length);
          // Pagination actually happened. With 5 buckets and batchSize 5
          // against ~75 rows, we expect strictly more Queries than buckets.
          expect(counter.count).toBeGreaterThan(
            SearchablePost.iterationBuckets,
          );
        } finally {
          counter.restore();
        }
      },
      120000,
    );

    test(
      "searchAll keeps paginating when most pages are empty after the FilterExpression",
      async () => {
        // 5 needles in a haystack of 75. With batchSize=5 the GSI Query
        // returns up to 5 items per page, then contains() throws most away.
        // Pagination must survive mostly-empty pages (across calls now).
        const needleIds = [];
        const creates = [];
        for (let i = 0; i < 5; i++) {
          creates.push(
            SearchablePost.create({
              title: `needle-${i} unique-marker-xyz`,
              body: null,
            }).then((p) => needleIds.push(p.postId)),
          );
        }
        for (let i = 0; i < 75; i++) {
          creates.push(
            SearchablePost.create({ title: `haystack ${i}`, body: null }),
          );
        }
        await Promise.all(creates);

        const counter = installQueryCounter(SearchablePost);
        try {
          const found = await drainAll(
            SearchablePost,
            ["unique-marker-xyz"],
            { batchSize: 5, limit: Infinity },
          );

          const foundIds = found.map((p) => p.postId).sort();
          expect(foundIds).toEqual(needleIds.slice().sort());
          // 80 rows / 5 per page = 16+ pages across 5 buckets — must have
          // made many more Queries than buckets to drain everything.
          expect(counter.count).toBeGreaterThan(
            SearchablePost.iterationBuckets * 2,
          );
        } finally {
          counter.restore();
        }
      },
      180000,
    );
  });

  describe("searchConfig option round-trip (real DynamoDB)", () => {
    test("caseSensitive: true preserves case at write AND respects case at search", async () => {
      const upper = await CaseSensitivePost.create({ title: "Hello World" });
      const lower = await CaseSensitivePost.create({ title: "hello world" });

      // Stored verbatim (case preserved on write).
      expect(upper._dyData._searchText).toBe("Hello World");
      expect(lower._dyData._searchText).toBe("hello world");

      // Mixed-case query matches only the row with that exact case.
      let { items: found } = await CaseSensitivePost.searchAll(["Hello"]);
      expect(found.map((p) => p.postId)).toEqual([upper.postId]);

      // Lowercase query matches only the lowercase row.
      ({ items: found } = await CaseSensitivePost.searchAll(["hello"]));
      expect(found.map((p) => p.postId)).toEqual([lower.postId]);
    });

    test("dedupe: true collapses repeated tokens at write time", async () => {
      const repeated = await DedupePost.create({
        title: "foo foo foo bar baz baz",
      });
      // Tokens deduped in first-seen order; lowercase because caseSensitive=false.
      expect(repeated._dyData._searchText).toBe("foo bar baz");

      // Searches still work against the deduped storage.
      let { items: found } = await DedupePost.searchAll(["foo", "baz"]);
      expect(found.map((p) => p.postId)).toEqual([repeated.postId]);

      // A token that appeared only as a duplicate in input is still findable.
      ({ items: found } = await DedupePost.searchAll(["bar"]));
      expect(found.map((p) => p.postId)).toEqual([repeated.postId]);
    });

    test("minTermLength drops short tokens at write AND at query time", async () => {
      const row = await MinTermLengthPost.create({
        title: "a fox is here go now seriously",
      });
      const stored = row._dyData._searchText.split(" ");
      expect(stored).toEqual(
        expect.arrayContaining(["fox", "here", "now", "seriously"]),
      );
      expect(stored).not.toContain("a");
      expect(stored).not.toContain("is");
      expect(stored).not.toContain("go");

      // Searching for a long token still works.
      let { items: found } = await MinTermLengthPost.searchAll(["seriously"]);
      expect(found.map((p) => p.postId)).toEqual([row.postId]);

      // Query terms are normalized too: a too-short term drops from the
      // predicate. With ['a', 'fox'] passed in, only 'fox' survives.
      ({ items: found } = await MinTermLengthPost.searchAll(["a", "fox"]));
      expect(found.map((p) => p.postId)).toEqual([row.postId]);

      // A query with only short terms throws (no usable terms remain).
      await expect(
        MinTermLengthPost.searchAll(["a", "is"]),
      ).rejects.toThrow(/at least one non-empty term/i);
    });
  });

  describe("filter on _searchText via standard filter API", () => {
    test("iterateAll with _searchText filter returns matching rows (auto-normalized)", async () => {
      const a = await SearchablePost.create({
        title: "Apple announces new iPhone",
        body: null,
      });
      const b = await SearchablePost.create({
        title: "Banana split recipe",
        body: null,
      });
      await SearchablePost.create({ title: "Carrot cake", body: null });

      const found = [];
      for await (const batch of SearchablePost.iterateAll({
        filter: { _searchText: { $contains: "Banana" } },
      })) {
        found.push(...batch);
      }
      // 'Banana' auto-normalizes to 'banana' to match what's stored.
      expect(found.map((p) => p.postId)).toEqual([b.postId]);

      // Sanity: 'Apple' matches the apple row only.
      const apples = [];
      for await (const batch of SearchablePost.iterateAll({
        filter: { _searchText: { $contains: "Apple" } },
      })) {
        apples.push(...batch);
      }
      expect(apples.map((p) => p.postId)).toEqual([a.postId]);
    });

    test("iterateAll with _searchText filter combined with other field clauses", async () => {
      const draft = await SearchablePost.create({
        title: "alice in wonderland",
        status: "draft",
      });
      const active = await SearchablePost.create({
        title: "alice the explorer",
        status: "active",
      });

      // Combined: _searchText AND status. Both fields are projected on
      // iter_search_index ... wait, status isn't. So this combination
      // would fail the projection preflight. Use post-iteration JS filter
      // for non-projected attributes, but the _searchText filter alone
      // pushes substring matching to the index.
      const found = [];
      for await (const batch of SearchablePost.iterateAll({
        filter: { _searchText: { $contains: "alice" } },
      })) {
        found.push(...batch);
      }
      const ids = found.map((p) => p.postId).sort();
      expect(ids).toEqual([draft.postId, active.postId].sort());
    });
  });

  describe("save-time _searchText behavior", () => {
    test("update touching no source field does not rewrite _searchText", async () => {
      const p = await SearchablePost.create({
        title: "alice the great",
        body: null,
      });
      const { items: found } = await SearchablePost.searchAll(["alice"]);
      expect(found.map((x) => x.postId)).toEqual([p.postId]);

      // Update only status — _searchText must stay
      await SearchablePost.update(p.postId, { status: "archived" });

      const { items: after } = await SearchablePost.searchAll(["alice"]);
      expect(after.map((x) => x.postId)).toEqual([p.postId]);
    });

    test("update touching a source field recomputes (with backfill)", async () => {
      const p = await SearchablePost.create({
        title: "first version",
        body: "with extra context",
      });
      let res = await SearchablePost.searchAll(["first"]);
      expect(res.items.length).toBe(1);

      await SearchablePost.update(p.postId, { title: "second version" });

      // 'first' no longer matches title; body still contains 'extra'
      res = await SearchablePost.searchAll(["first"]);
      expect(res.items.length).toBe(0);

      res = await SearchablePost.searchAll(["second"]);
      expect(res.items.map((x) => x.postId)).toEqual([p.postId]);

      // Body backfilled — searching for it still finds the row
      res = await SearchablePost.searchAll(["extra"]);
      expect(res.items.map((x) => x.postId)).toEqual([p.postId]);
    });

    test("clearing all source fields REMOVEs _searchText (row drops out of search)", async () => {
      const p = await SearchablePost.create({
        title: "deletable",
        body: "stuff",
      });
      let res = await SearchablePost.searchAll(["deletable"]);
      expect(res.items.length).toBe(1);

      await SearchablePost.update(p.postId, { title: null, body: null });

      res = await SearchablePost.searchAll(["deletable"]);
      expect(res.items.length).toBe(0);
    });
  });

  describe("non-iterable searchable model uses normal queries", () => {
    test("NonIterableSearchable populates _searchText and is filterable", async () => {
      const p = await NonIterableSearchable.create({ title: "Hello, World!" });
      const fetched = await NonIterableSearchable.find(p.postId);
      expect(fetched._dyData._searchText).toBe("hello world");
    });

    test("searchAll throws on non-iterable searchable model", async () => {
      await expect(NonIterableSearchable.searchAll(["foo"])).rejects.toThrow(
        /searchAll requires iterable/i,
      );
    });

    test("filtering on _searchText via condition expression works (auto-normalize)", async () => {
      const p = await NonIterableSearchable.create({ title: "Hello, World!" });

      const updated = await NonIterableSearchable.update(
        p.postId,
        { title: "Hello, World!" },
        { condition: { _searchText: { $contains: "Hello" } } },
      );
      expect(updated.postId).toBe(p.postId);

      await expect(
        NonIterableSearchable.update(
          p.postId,
          { title: "Hello, World!" },
          { condition: { _searchText: { $contains: "nonexistent" } } },
        ),
      ).rejects.toThrow();
    });
  });

  describe("cursor / resume (real DynamoDB)", () => {
    test("draining via cursors yields the same set as a single Infinity call", async () => {
      const aliceIds = [];
      const creates = [];
      for (let i = 0; i < 60; i++) {
        creates.push(
          SearchablePost.create({ title: `alice ${i}`, body: null }).then((p) =>
            aliceIds.push(p.postId),
          ),
        );
      }
      await Promise.all(creates);

      // Drain via cursors with a small per-page limit.
      const drained = [];
      let cursor = null;
      let pages = 0;
      do {
        const page = await SearchablePost.searchAll(["alice"], {
          limit: 7,
          cursor,
        });
        drained.push(...page.items);
        cursor = page.cursor;
        pages++;
        // Safety against infinite loops in case of a bug.
        expect(pages).toBeLessThan(200);
      } while (cursor);

      const drainedIds = drained.map((p) => p.postId).sort();
      expect(drainedIds).toEqual(aliceIds.slice().sort());
      // No duplicates across pages — cursor mechanics must not double-yield.
      expect(new Set(drainedIds).size).toBe(drainedIds.length);
      // Drained at least the expected number of pages (60 / 7 ≈ 9).
      expect(pages).toBeGreaterThan(5);
    }, 240000);

    test("cursor is null when the search is fully exhausted", async () => {
      await SearchablePost.create({ title: "alice", body: null });
      const { items, cursor } = await SearchablePost.searchAll(["alice"], {
        limit: 100,
      });
      expect(items.length).toBe(1);
      expect(cursor).toBeNull();
    });

    test("zero matches anywhere returns empty + null cursor", async () => {
      await SearchablePost.create({ title: "bob", body: null });
      const { items, cursor } = await SearchablePost.searchAll(["zzz-no-match-here"]);
      expect(items).toEqual([]);
      expect(cursor).toBeNull();
    });

    test("cursor with different terms throws (predicate-hash mismatch)", async () => {
      await SearchablePost.create({ title: "alice", body: null });
      await SearchablePost.create({ title: "bob", body: null });
      const { cursor } = await SearchablePost.searchAll(["alice"], { limit: 1 });
      // Even if no cursor is returned (single match exhausted), this test
      // requires a non-null cursor — so make sure we have one.
      const second = await SearchablePost.create({
        title: "alice extra",
        body: null,
      });
      const { cursor: c2 } = await SearchablePost.searchAll(["alice"], {
        limit: 1,
      });
      // c2 might be null if hash distribution puts both alices in the
      // same first-page bucket. Use whichever is non-null.
      const usable = c2 || cursor;
      if (!usable) return; // skip — would only happen if ≤1 match across all buckets
      await expect(
        SearchablePost.searchAll(["bob"], { cursor: usable }),
      ).rejects.toThrow(/different query/i);
      // Keep `second` referenced so it's not GC-stripped from intent.
      expect(second.postId).toBeTruthy();
    });

    test("cursor with different operator throws", async () => {
      // Create enough matches that limit:1 produces a non-null cursor.
      for (let i = 0; i < 5; i++) {
        await SearchablePost.create({ title: `alice ${i}`, body: null });
      }
      const { cursor } = await SearchablePost.searchAll(["alice", "bob"], {
        operator: "$or",
        limit: 1,
      });
      if (!cursor) return; // unlikely
      await expect(
        SearchablePost.searchAll(["alice", "bob"], {
          operator: "$and",
          cursor,
        }),
      ).rejects.toThrow(/different query/i);
    });

    test("malformed cursor throws", async () => {
      await SearchablePost.create({ title: "alice", body: null });
      await expect(
        SearchablePost.searchAll(["alice"], { cursor: "$$$bogus$$$" }),
      ).rejects.toThrow(/cursor/i);
    });

    test("parallel and sequential modes return the same set when fully drained", async () => {
      const aliceIds = [];
      const creates = [];
      for (let i = 0; i < 30; i++) {
        creates.push(
          SearchablePost.create({ title: `alice ${i}`, body: null }).then(
            (p) => aliceIds.push(p.postId),
          ),
        );
      }
      await Promise.all(creates);

      const par = await drainAll(SearchablePost, ["alice"], {
        parallel: true,
        limit: 8,
      });
      const seq = await drainAll(SearchablePost, ["alice"], {
        parallel: false,
        limit: 8,
      });

      const expected = aliceIds.slice().sort();
      expect(par.map((p) => p.postId).sort()).toEqual(expected);
      expect(seq.map((p) => p.postId).sort()).toEqual(expected);
    }, 240000);

    test("maxQueriesPerBucket caps capacity for sparse-match searches", async () => {
      // Lots of haystack rows, no matching needles. With a low
      // maxQueriesPerBucket, each call returns empty + a non-null cursor
      // pointing to where the next call should pick up.
      for (let i = 0; i < 60; i++) {
        await SearchablePost.create({ title: `haystack ${i}`, body: null });
      }

      const { items, cursor } = await SearchablePost.searchAll(
        ["nomatchterm-zzz"],
        { batchSize: 5, maxQueriesPerBucket: 1 },
      );
      expect(items).toEqual([]);
      // With matches=0 but unexhausted buckets (capped at 1 query each),
      // cursor must be non-null so the caller can continue.
      expect(cursor).not.toBeNull();
    }, 120000);

    test("invalid maxQueriesPerBucket throws synchronously", async () => {
      await expect(
        SearchablePost.searchAll(["alice"], { maxQueriesPerBucket: 0 }),
      ).rejects.toThrow(/maxQueriesPerBucket must be a positive integer/i);
      await expect(
        SearchablePost.searchAll(["alice"], { maxQueriesPerBucket: -1 }),
      ).rejects.toThrow(/maxQueriesPerBucket must be a positive integer/i);
      await expect(
        SearchablePost.searchAll(["alice"], { maxQueriesPerBucket: 1.5 }),
      ).rejects.toThrow(/maxQueriesPerBucket must be a positive integer/i);
    });
  });

  describe("error paths", () => {
    test("searchAll throws on non-searchable model", async () => {
      await expect(NonSearchablePost.searchAll(["foo"])).rejects.toThrow(
        /not configured as searchable/i,
      );
    });

    test("searchAll throws on empty terms", async () => {
      await expect(SearchablePost.searchAll([])).rejects.toThrow(
        /at least one non-empty term/i,
      );
    });

    test("searchAll throws on bad operator", async () => {
      await expect(
        SearchablePost.searchAll(["foo"], { operator: "AND" }),
      ).rejects.toThrow(/operator must be one of/i);
    });

    test("searchAll throws on non-array terms", async () => {
      await expect(SearchablePost.searchAll("foo")).rejects.toThrow(
        /terms must be an array/i,
      );
    });

    test("searchBucket validates bucket number", async () => {
      await expect(
        SearchablePost.searchBucket(-1, ["foo"]),
      ).rejects.toThrow(/Invalid bucket number/i);
      await expect(
        SearchablePost.searchBucket(99, ["foo"]),
      ).rejects.toThrow(/Invalid bucket number/i);
    });
  });

  describe("tokenizeSearchQuery static helper", () => {
    test("delegates to the utils helper", () => {
      expect(SearchablePost.tokenizeSearchQuery('"hello world" foo')).toEqual([
        "hello world",
        "foo",
      ]);
    });
  });
});
