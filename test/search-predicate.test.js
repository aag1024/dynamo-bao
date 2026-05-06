const { buildSearchPredicate } = require("../src/utils/search-text");

const config = {
  fields: ["title"],
  caseSensitive: false,
  minTermLength: 1,
  dedupe: false,
};

describe("buildSearchPredicate", () => {
  describe("validation", () => {
    test("throws when terms is not an array", () => {
      expect(() => buildSearchPredicate("foo", config)).toThrow(
        /terms must be an array/i,
      );
    });

    test("throws when terms is empty", () => {
      expect(() => buildSearchPredicate([], config)).toThrow(
        /at least one non-empty term/i,
      );
    });

    test("throws when all terms normalize to empty", () => {
      expect(() => buildSearchPredicate(["", "  ", "!!!"], config)).toThrow(
        /at least one non-empty term/i,
      );
    });

    test("throws when operator is not $and or $or", () => {
      expect(() =>
        buildSearchPredicate(["foo"], config, { operator: "AND" }),
      ).toThrow(/operator must be one of/i);
    });

    test("throws when terms contains a non-string", () => {
      expect(() => buildSearchPredicate([123], config)).toThrow(
        /terms must be strings/i,
      );
    });
  });

  describe("single term", () => {
    test("builds a single contains predicate", () => {
      const p = buildSearchPredicate(["alice"], config);
      expect(p.FilterExpression).toMatch(/^contains\(#st, :st0\)$/);
      expect(p.ExpressionAttributeNames).toEqual({ "#st": "_searchText" });
      expect(p.ExpressionAttributeValues).toEqual({ ":st0": "alice" });
    });

    test("normalizes the term using the same rules as the index", () => {
      const p = buildSearchPredicate(["Hello, World!"], config);
      expect(p.ExpressionAttributeValues[":st0"]).toBe("hello world");
    });

    test("preserves case when caseSensitive is true", () => {
      const p = buildSearchPredicate(
        ["Hello"],
        { ...config, caseSensitive: true },
      );
      expect(p.ExpressionAttributeValues[":st0"]).toBe("Hello");
    });

    test("drops empty/whitespace-only terms before counting", () => {
      const p = buildSearchPredicate(["  ", "alice"], config);
      expect(p.FilterExpression).toMatch(/^contains\(#st, :st0\)$/);
      expect(p.ExpressionAttributeValues).toEqual({ ":st0": "alice" });
    });
  });

  describe("multiple terms — $and (default)", () => {
    test("AND'd contains predicates for each term", () => {
      const p = buildSearchPredicate(["foo", "bar"], config);
      expect(p.FilterExpression).toBe(
        "(contains(#st, :st0)) AND (contains(#st, :st1))",
      );
      expect(p.ExpressionAttributeValues).toEqual({
        ":st0": "foo",
        ":st1": "bar",
      });
    });

    test("explicit $and operator behaves the same", () => {
      const p = buildSearchPredicate(["foo", "bar"], config, {
        operator: "$and",
      });
      expect(p.FilterExpression).toBe(
        "(contains(#st, :st0)) AND (contains(#st, :st1))",
      );
    });
  });

  describe("multiple terms — $or", () => {
    test("OR'd contains predicates for each term", () => {
      const p = buildSearchPredicate(["foo", "bar"], config, {
        operator: "$or",
      });
      expect(p.FilterExpression).toBe(
        "(contains(#st, :st0)) OR (contains(#st, :st1))",
      );
      expect(p.ExpressionAttributeValues).toEqual({
        ":st0": "foo",
        ":st1": "bar",
      });
    });
  });

  describe("phrase terms (with spaces)", () => {
    test("handles multi-word substring as a single term", () => {
      const p = buildSearchPredicate(["foo bar", "baz"], config);
      expect(p.ExpressionAttributeValues).toEqual({
        ":st0": "foo bar",
        ":st1": "baz",
      });
    });
  });

  describe("non-ASCII", () => {
    test("preserves CJK characters in values", () => {
      const p = buildSearchPredicate(["苹果"], config);
      expect(p.ExpressionAttributeValues[":st0"]).toBe("苹果");
    });
  });

});
