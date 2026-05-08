// Unit tests for FilterExpressionBuilder support for system filterable
// fields (currently just _searchText). Tests the builder in isolation by
// constructing a fake model with the right shape rather than going through
// the manager / DynamoDB stack.

const {
  FilterExpressionBuilder,
} = require("../src/filter-expression");

function makeModel({ searchConfig = null, extraFields = {} } = {}) {
  // FilterExpressionBuilder reads `model.fields[name]` and calls `.toDy(value)`
  // on the result for user fields. System fields skip that path so the model
  // just needs `fields` and `searchConfig` for normalization.
  return {
    fields: {
      title: { toDy: (v) => v },
      ...extraFields,
    },
    searchable: !!searchConfig,
    searchConfig,
  };
}

describe("FilterExpressionBuilder — _searchText system field", () => {
  describe("validation", () => {
    test("does not throw 'Unknown field' for _searchText", () => {
      const model = makeModel({
        searchConfig: {
          fields: ["title"],
          caseSensitive: false,
          minTermLength: 1,
          dedupe: false,
        },
      });
      const b = new FilterExpressionBuilder();
      expect(() =>
        b.build({ _searchText: { $contains: "foo" } }, model),
      ).not.toThrow();
    });

    test("still throws 'Unknown field' for genuinely unknown fields", () => {
      const model = makeModel();
      const b = new FilterExpressionBuilder();
      expect(() => b.build({ nope: "foo" }, model)).toThrow(
        /Unknown field in filter: nope/,
      );
    });
  });

  describe("$contains with auto-normalization", () => {
    test("normalizes the value using the model's searchConfig", () => {
      const model = makeModel({
        searchConfig: {
          fields: ["title"],
          caseSensitive: false,
          minTermLength: 1,
          dedupe: false,
        },
      });
      const b = new FilterExpressionBuilder();
      const e = b.build(
        { _searchText: { $contains: "Hello, World!" } },
        model,
      );
      expect(e.FilterExpression).toMatch(/^contains\(#n\d+, :v\d+\)$/);
      expect(Object.values(e.ExpressionAttributeNames)).toContain(
        "_searchText",
      );
      expect(Object.values(e.ExpressionAttributeValues)).toEqual([
        "hello world",
      ]);
    });

    test("preserves case when model uses caseSensitive: true", () => {
      const model = makeModel({
        searchConfig: {
          fields: ["title"],
          caseSensitive: true,
          minTermLength: 1,
          dedupe: false,
        },
      });
      const b = new FilterExpressionBuilder();
      const e = b.build(
        { _searchText: { $contains: "Hello, World!" } },
        model,
      );
      expect(Object.values(e.ExpressionAttributeValues)).toEqual([
        "Hello World",
      ]);
    });

    test("preserves CJK characters in the value", () => {
      const model = makeModel({
        searchConfig: {
          fields: ["title"],
          caseSensitive: false,
          minTermLength: 1,
          dedupe: false,
        },
      });
      const b = new FilterExpressionBuilder();
      const e = b.build({ _searchText: { $contains: "苹果" } }, model);
      expect(Object.values(e.ExpressionAttributeValues)).toEqual(["苹果"]);
    });
  });

  describe("$in normalizes each value", () => {
    test("$in array values auto-normalize for _searchText", () => {
      const cfg = {
        fields: ["title"],
        caseSensitive: false,
        minTermLength: 1,
        dedupe: false,
      };
      const b = new FilterExpressionBuilder();
      const e = b.build(
        { _searchText: { $in: ["Hello, World!", "FOO"] } },
        makeModel({ searchConfig: cfg }),
      );
      expect(e.FilterExpression).toMatch(/IN \(/);
      // Both values normalized — punctuation stripped, lowercase.
      expect(Object.values(e.ExpressionAttributeValues).sort()).toEqual([
        "foo",
        "hello world",
      ]);
    });

    test("$in with single-element array still goes through convertValue", () => {
      const cfg = {
        fields: ["title"],
        caseSensitive: false,
        minTermLength: 1,
        dedupe: false,
      };
      const b = new FilterExpressionBuilder();
      const e = b.build(
        { _searchText: { $in: ["BAR"] } },
        makeModel({ searchConfig: cfg }),
      );
      expect(Object.values(e.ExpressionAttributeValues)).toEqual(["bar"]);
    });
  });

  describe("$beginsWith / $eq / $ne also normalize", () => {
    const cfg = {
      fields: ["title"],
      caseSensitive: false,
      minTermLength: 1,
      dedupe: false,
    };

    test("$beginsWith", () => {
      const b = new FilterExpressionBuilder();
      const e = b.build(
        { _searchText: { $beginsWith: "Foo!" } },
        makeModel({ searchConfig: cfg }),
      );
      expect(e.FilterExpression).toMatch(/^begins_with/);
      expect(Object.values(e.ExpressionAttributeValues)).toEqual(["foo"]);
    });

    test("$eq", () => {
      const b = new FilterExpressionBuilder();
      const e = b.build(
        { _searchText: { $eq: "Foo Bar" } },
        makeModel({ searchConfig: cfg }),
      );
      expect(e.FilterExpression).toMatch(/= /);
      expect(Object.values(e.ExpressionAttributeValues)).toEqual(["foo bar"]);
    });

    test("$ne", () => {
      const b = new FilterExpressionBuilder();
      const e = b.build(
        { _searchText: { $ne: "Foo" } },
        makeModel({ searchConfig: cfg }),
      );
      expect(e.FilterExpression).toMatch(/<>/);
      expect(Object.values(e.ExpressionAttributeValues)).toEqual(["foo"]);
    });

    test("shorthand exact match (raw value, no operator) normalizes too", () => {
      const b = new FilterExpressionBuilder();
      const e = b.build(
        { _searchText: "Hello, World!" },
        makeModel({ searchConfig: cfg }),
      );
      expect(Object.values(e.ExpressionAttributeValues)).toEqual([
        "hello world",
      ]);
    });
  });

  describe("$exists doesn't try to normalize a value", () => {
    test("$exists: true → attribute_exists", () => {
      const b = new FilterExpressionBuilder();
      const e = b.build(
        { _searchText: { $exists: true } },
        makeModel({
          searchConfig: {
            fields: ["title"],
            caseSensitive: false,
            minTermLength: 1,
            dedupe: false,
          },
        }),
      );
      expect(e.FilterExpression).toMatch(/^attribute_exists\(/);
      // No value placeholder should be created since $exists doesn't
      // consume a value.
      expect(Object.values(e.ExpressionAttributeValues || {})).toEqual([]);
    });

    test("$exists: false → attribute_not_exists", () => {
      const b = new FilterExpressionBuilder();
      const e = b.build(
        { _searchText: { $exists: false } },
        makeModel({
          searchConfig: {
            fields: ["title"],
            caseSensitive: false,
            minTermLength: 1,
            dedupe: false,
          },
        }),
      );
      expect(e.FilterExpression).toMatch(/^attribute_not_exists\(/);
    });
  });

  describe("composition", () => {
    const cfg = {
      fields: ["title"],
      caseSensitive: false,
      minTermLength: 1,
      dedupe: false,
    };

    test("AND with a regular field works", () => {
      const model = makeModel({
        searchConfig: cfg,
        extraFields: { status: { toDy: (v) => v } },
      });
      const b = new FilterExpressionBuilder();
      const e = b.build(
        {
          _searchText: { $contains: "alice" },
          status: "active",
        },
        model,
      );
      // Both clauses present, AND'd by the builder.
      expect(e.FilterExpression).toMatch(/AND/);
      expect(e.FilterExpression).toMatch(/contains\(/);
      // _searchText placeholder maps to "_searchText", status placeholder
      // maps to "status".
      const names = Object.values(e.ExpressionAttributeNames);
      expect(names).toEqual(expect.arrayContaining(["_searchText", "status"]));
    });

    test("$or with _searchText and a regular field", () => {
      const model = makeModel({
        searchConfig: cfg,
        extraFields: { status: { toDy: (v) => v } },
      });
      const b = new FilterExpressionBuilder();
      const e = b.build(
        {
          $or: [
            { _searchText: { $contains: "alice" } },
            { status: "active" },
          ],
        },
        model,
      );
      expect(e.FilterExpression).toMatch(/OR/);
      const names = Object.values(e.ExpressionAttributeNames);
      expect(names).toEqual(expect.arrayContaining(["_searchText", "status"]));
    });
  });

  describe("fallbacks when searchConfig is missing", () => {
    test("non-searchable model: _searchText filter passes the raw String value", () => {
      // No searchConfig — we don't auto-normalize. Pass through as String().
      const model = makeModel({ searchConfig: null });
      const b = new FilterExpressionBuilder();
      const e = b.build(
        { _searchText: { $contains: "Hello, World!" } },
        model,
      );
      expect(Object.values(e.ExpressionAttributeValues)).toEqual([
        "Hello, World!",
      ]);
    });

    test("coerces non-string values to string", () => {
      const model = makeModel({
        searchConfig: {
          fields: ["title"],
          caseSensitive: false,
          minTermLength: 1,
          dedupe: false,
        },
      });
      const b = new FilterExpressionBuilder();
      const e = b.build({ _searchText: { $eq: 42 } }, model);
      expect(Object.values(e.ExpressionAttributeValues)).toEqual(["42"]);
    });
  });
});
