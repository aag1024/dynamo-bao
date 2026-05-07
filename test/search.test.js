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

      const found = [];
      for await (const batch of SearchablePost.searchAll(["banana"])) {
        found.push(...batch);
      }
      const ids = found.map((p) => p.postId).sort();
      expect(ids).toEqual([b.postId].sort());
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

      const found = [];
      for await (const batch of SearchablePost.searchAll(
        ["iphone", "banana"],
        { operator: "$and" },
      )) {
        found.push(...batch);
      }
      expect(found.map((p) => p.postId)).toEqual([both.postId]);
    });

    test("$or matches rows containing any term", async () => {
      const a = await SearchablePost.create({ title: "Apple", body: null});
      const b = await SearchablePost.create({ title: "Banana", body: null});
      await SearchablePost.create({ title: "Carrot", body: null});

      const found = [];
      for await (const batch of SearchablePost.searchAll(
        ["apple", "banana"],
        { operator: "$or" },
      )) {
        found.push(...batch);
      }
      const ids = found.map((p) => p.postId).sort();
      expect(ids).toEqual([a.postId, b.postId].sort());
    });

    test("non-projected attributes can be filtered post-iteration", async () => {
      // iter_search_index only projects _searchText, so filters on other
      // attributes have to be applied to hydrated items in JS (same rule as
      // iterateAll). This is the recommended pattern.
      await SearchablePost.create({
        title: "alice the explorer",
        status: "draft",
      });
      const active = await SearchablePost.create({
        title: "alice in wonderland",
        status: "active",
      });

      const found = [];
      for await (const batch of SearchablePost.searchAll(["alice"])) {
        for (const item of batch) {
          if (item.status === "active") found.push(item);
        }
      }
      expect(found.map((p) => p.postId)).toEqual([active.postId]);
    });

    test("returns empty when no rows match", async () => {
      await SearchablePost.create({ title: "Apple", body: null});

      const found = [];
      for await (const batch of SearchablePost.searchAll(["nonexistent"])) {
        found.push(...batch);
      }
      expect(found).toEqual([]);
    });

    test("multilingual: matches CJK substring", async () => {
      const cjk = await SearchablePost.create({
        title: "苹果手机评测",
        body: "iPhone 15 上市了。",
      });
      await SearchablePost.create({ title: "Banana", body: null});

      const found = [];
      for await (const batch of SearchablePost.searchAll(["苹果"])) {
        found.push(...batch);
      }
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
        await SearchablePost.create({ title: `bob number ${i}`, body: null});
      }

      const bucketResults = await Promise.all(
        Array.from({ length: SearchablePost.iterationBuckets }, async (_, b) => {
          const out = [];
          for await (const batch of SearchablePost.searchBucket(b, ["alice"])) {
            out.push(...batch);
          }
          return out;
        }),
      );
      const flat = bucketResults
        .flat()
        .map((p) => p.postId)
        .sort();
      expect(flat).toEqual(aliceIds.slice().sort());
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
          const found = [];
          for await (const batch of SearchablePost.searchAll(["alice"], {
            batchSize: 5,
          })) {
            found.push(...batch);
          }

          const foundIds = found.map((p) => p.postId).sort();
          expect(foundIds).toEqual(aliceIds.slice().sort());
          // No duplicates — pagination must not double-yield rows.
          expect(new Set(foundIds).size).toBe(foundIds.length);
          // Pagination actually happened. With 5 buckets and batchSize 5
          // against a dataset of ~75 rows, we expect at least one extra
          // Query per bucket. The exact count varies with hash distribution,
          // but it must be strictly more than the bucket count.
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
        // 5 matching needles in a haystack of 75. With batchSize=5 the GSI
        // Query returns up to 5 items per page, then the contains() filter
        // throws away most of them. The pagination loop must keep going on
        // LastEvaluatedKey across many empty/sparse pages until exhausted.
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
          const found = [];
          for await (const batch of SearchablePost.searchAll(
            ["unique-marker-xyz"],
            { batchSize: 5 },
          )) {
            found.push(...batch);
          }

          const foundIds = found.map((p) => p.postId).sort();
          expect(foundIds).toEqual(needleIds.slice().sort());
          // 80 total rows / 5 per page = 16+ pages spread across 5 buckets.
          // At minimum we must have made far more Query calls than buckets,
          // confirming the pagination loop survives mostly-empty pages.
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
      let found = [];
      for await (const batch of CaseSensitivePost.searchAll(["Hello"])) {
        found.push(...batch);
      }
      expect(found.map((p) => p.postId)).toEqual([upper.postId]);

      // Lowercase query matches only the lowercase row.
      found = [];
      for await (const batch of CaseSensitivePost.searchAll(["hello"])) {
        found.push(...batch);
      }
      expect(found.map((p) => p.postId)).toEqual([lower.postId]);
    });

    test("dedupe: true collapses repeated tokens at write time", async () => {
      const repeated = await DedupePost.create({
        title: "foo foo foo bar baz baz",
      });
      // Tokens deduped in first-seen order; lowercase because caseSensitive=false.
      expect(repeated._dyData._searchText).toBe("foo bar baz");

      // Searches still work against the deduped storage.
      let found = [];
      for await (const batch of DedupePost.searchAll(["foo", "baz"])) {
        found.push(...batch);
      }
      expect(found.map((p) => p.postId)).toEqual([repeated.postId]);

      // A token that appeared only as a duplicate in input is still findable.
      found = [];
      for await (const batch of DedupePost.searchAll(["bar"])) {
        found.push(...batch);
      }
      expect(found.map((p) => p.postId)).toEqual([repeated.postId]);
    });

    test("minTermLength drops short tokens at write AND at query time", async () => {
      // Source has a mix of short and long tokens. minTermLength=3 means
      // 'a', 'is', 'go' get dropped from _searchText.
      const row = await MinTermLengthPost.create({
        title: "a fox is here go now seriously",
      });
      const stored = row._dyData._searchText.split(" ");
      // Long tokens kept...
      expect(stored).toEqual(
        expect.arrayContaining(["fox", "here", "now", "seriously"]),
      );
      // ...and short ones dropped.
      expect(stored).not.toContain("a");
      expect(stored).not.toContain("is");
      expect(stored).not.toContain("go");

      // Searching for a long token still works.
      let found = [];
      for await (const batch of MinTermLengthPost.searchAll(["seriously"])) {
        found.push(...batch);
      }
      expect(found.map((p) => p.postId)).toEqual([row.postId]);

      // Query terms are normalized too: a too-short term is dropped from
      // the predicate. With ['a', 'fox'] passed in, only 'fox' survives.
      found = [];
      for await (const batch of MinTermLengthPost.searchAll(["a", "fox"])) {
        found.push(...batch);
      }
      expect(found.map((p) => p.postId)).toEqual([row.postId]);

      // A query with only short terms throws (no usable terms remain).
      await expect(async () => {
        for await (const _ of MinTermLengthPost.searchAll(["a", "is"])) {
          // unreachable
        }
      }).rejects.toThrow(/at least one non-empty term/i);
    });
  });

  describe("save-time _searchText behavior", () => {
    test("update touching no source field does not rewrite _searchText", async () => {
      const p = await SearchablePost.create({
        title: "alice the great",
        body: null,
      });
      const found = [];
      for await (const batch of SearchablePost.searchAll(["alice"])) {
        found.push(...batch);
      }
      expect(found.map((x) => x.postId)).toEqual([p.postId]);

      // Update only status — _searchText must stay
      await SearchablePost.update(p.postId, { status: "archived" });

      const after = [];
      for await (const batch of SearchablePost.searchAll(["alice"])) {
        after.push(...batch);
      }
      expect(after.map((x) => x.postId)).toEqual([p.postId]);
    });

    test("update touching a source field recomputes (with backfill)", async () => {
      const p = await SearchablePost.create({
        title: "first version",
        body: "with extra context",
      });
      let found = [];
      for await (const batch of SearchablePost.searchAll(["first"])) {
        found.push(...batch);
      }
      expect(found.length).toBe(1);

      await SearchablePost.update(p.postId, { title: "second version" });

      // 'first' no longer matches title; body still contains "extra"
      found = [];
      for await (const batch of SearchablePost.searchAll(["first"])) {
        found.push(...batch);
      }
      expect(found.length).toBe(0);

      found = [];
      for await (const batch of SearchablePost.searchAll(["second"])) {
        found.push(...batch);
      }
      expect(found.map((x) => x.postId)).toEqual([p.postId]);

      // Body backfilled — searching for it still finds the row
      found = [];
      for await (const batch of SearchablePost.searchAll(["extra"])) {
        found.push(...batch);
      }
      expect(found.map((x) => x.postId)).toEqual([p.postId]);
    });

    test("clearing all source fields REMOVEs _searchText (row drops out of search)", async () => {
      const p = await SearchablePost.create({
        title: "deletable",
        body: "stuff",
      });
      let found = [];
      for await (const batch of SearchablePost.searchAll(["deletable"])) {
        found.push(...batch);
      }
      expect(found.length).toBe(1);

      await SearchablePost.update(p.postId, { title: null, body: null });

      found = [];
      for await (const batch of SearchablePost.searchAll(["deletable"])) {
        found.push(...batch);
      }
      expect(found.length).toBe(0);
    });
  });

  describe("non-iterable searchable model uses normal queries", () => {
    test("NonIterableSearchable populates _searchText and is filterable", async () => {
      const p = await NonIterableSearchable.create({ title: "Hello, World!" });
      const fetched = await NonIterableSearchable.find(p.postId);
      // _searchText is internal but should be set on the row's raw data
      expect(fetched._dyData._searchText).toBe("hello world");
    });

    test("searchAll throws on non-iterable searchable model", async () => {
      await expect(async () => {
        for await (const _ of NonIterableSearchable.searchAll(["foo"])) {
          // unreachable
        }
      }).rejects.toThrow(/searchAll requires iterable/i);
    });
  });

  describe("error paths", () => {
    test("searchAll throws on non-searchable model", async () => {
      await expect(async () => {
        for await (const _ of NonSearchablePost.searchAll(["foo"])) {
          // unreachable
        }
      }).rejects.toThrow(/not configured as searchable/i);
    });

    test("searchAll throws on empty terms", async () => {
      await expect(async () => {
        for await (const _ of SearchablePost.searchAll([])) {
          // unreachable
        }
      }).rejects.toThrow(/at least one non-empty term/i);
    });

    test("searchAll throws on bad operator", async () => {
      await expect(async () => {
        for await (const _ of SearchablePost.searchAll(["foo"], {
          operator: "AND",
        })) {
          // unreachable
        }
      }).rejects.toThrow(/operator must be one of/i);
    });

    test("searchAll throws on non-array terms", async () => {
      await expect(async () => {
        for await (const _ of SearchablePost.searchAll("foo")) {
          // unreachable
        }
      }).rejects.toThrow(/terms must be an array/i);
    });

    test("searchBucket validates bucket number", async () => {
      await expect(async () => {
        for await (const _ of SearchablePost.searchBucket(-1, ["foo"])) {
          // unreachable
        }
      }).rejects.toThrow(/Invalid bucket number/i);
      await expect(async () => {
        for await (const _ of SearchablePost.searchBucket(99, ["foo"])) {
          // unreachable
        }
      }).rejects.toThrow(/Invalid bucket number/i);
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
