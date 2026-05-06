const { evaluateFilter } = require("../src/filter-expression");
const { QueryError, ValidationError } = require("../src/exceptions");

describe("evaluateFilter", () => {
  describe("trivial filters", () => {
    test("null filter matches everything", () => {
      expect(evaluateFilter(null, { x: 1 })).toBe(true);
    });

    test("undefined filter matches everything", () => {
      expect(evaluateFilter(undefined, { x: 1 })).toBe(true);
    });

    test("empty filter object matches everything", () => {
      expect(evaluateFilter({}, { x: 1 })).toBe(true);
    });
  });

  describe("field-level shorthand (=== $eq)", () => {
    test("primitive equality", () => {
      expect(evaluateFilter({ name: "alice" }, { name: "alice" })).toBe(true);
      expect(evaluateFilter({ name: "alice" }, { name: "bob" })).toBe(false);
    });

    test("number equality", () => {
      expect(evaluateFilter({ age: 30 }, { age: 30 })).toBe(true);
      expect(evaluateFilter({ age: 30 }, { age: 31 })).toBe(false);
    });

    test("Date equality compares by time", () => {
      const d1 = new Date("2024-01-01");
      const d2 = new Date("2024-01-01");
      expect(evaluateFilter({ at: d1 }, { at: d2 })).toBe(true);
      expect(evaluateFilter({ at: d1 }, { at: new Date("2024-01-02") })).toBe(false);
    });

    test("null condition matches missing or null field", () => {
      expect(evaluateFilter({ x: null }, { x: null })).toBe(true);
      expect(evaluateFilter({ x: null }, {})).toBe(true);
      expect(evaluateFilter({ x: null }, { x: 0 })).toBe(false);
    });
  });

  describe("comparison operators", () => {
    test("$eq", () => {
      expect(evaluateFilter({ x: { $eq: 5 } }, { x: 5 })).toBe(true);
      expect(evaluateFilter({ x: { $eq: 5 } }, { x: 6 })).toBe(false);
    });

    test("$ne", () => {
      expect(evaluateFilter({ x: { $ne: 5 } }, { x: 6 })).toBe(true);
      expect(evaluateFilter({ x: { $ne: 5 } }, { x: 5 })).toBe(false);
    });

    test("$gt / $gte / $lt / $lte", () => {
      expect(evaluateFilter({ x: { $gt: 5 } }, { x: 6 })).toBe(true);
      expect(evaluateFilter({ x: { $gt: 5 } }, { x: 5 })).toBe(false);
      expect(evaluateFilter({ x: { $gte: 5 } }, { x: 5 })).toBe(true);
      expect(evaluateFilter({ x: { $lt: 5 } }, { x: 4 })).toBe(true);
      expect(evaluateFilter({ x: { $lt: 5 } }, { x: 5 })).toBe(false);
      expect(evaluateFilter({ x: { $lte: 5 } }, { x: 5 })).toBe(true);
    });

    test("$gt / $gte / $lt / $lte with missing field never matches", () => {
      // Important: avoids `undefined > 5` returning false but also avoids
      // any accidental coercion-based match.
      expect(evaluateFilter({ x: { $gt: 5 } }, {})).toBe(false);
      expect(evaluateFilter({ x: { $gte: 5 } }, {})).toBe(false);
      expect(evaluateFilter({ x: { $lt: 5 } }, {})).toBe(false);
      expect(evaluateFilter({ x: { $lte: 5 } }, {})).toBe(false);
    });

    test("multiple operators on same field combine with AND", () => {
      expect(
        evaluateFilter({ x: { $gt: 5, $lt: 10 } }, { x: 7 }),
      ).toBe(true);
      expect(
        evaluateFilter({ x: { $gt: 5, $lt: 10 } }, { x: 11 }),
      ).toBe(false);
    });
  });

  describe("$in", () => {
    test("matches when in list", () => {
      expect(evaluateFilter({ x: { $in: [1, 2, 3] } }, { x: 2 })).toBe(true);
      expect(evaluateFilter({ x: { $in: [1, 2, 3] } }, { x: 4 })).toBe(false);
    });

    test("non-array throws", () => {
      expect(() =>
        evaluateFilter({ x: { $in: "abc" } }, { x: "a" }),
      ).toThrow(ValidationError);
    });

    test("matches Date by time", () => {
      const d = new Date("2024-01-01");
      expect(
        evaluateFilter({ x: { $in: [new Date("2024-01-01")] } }, { x: d }),
      ).toBe(true);
    });
  });

  describe("$contains", () => {
    test("string substring match", () => {
      expect(evaluateFilter({ s: { $contains: "foo" } }, { s: "foobar" })).toBe(true);
      expect(evaluateFilter({ s: { $contains: "baz" } }, { s: "foobar" })).toBe(false);
    });

    test("array membership", () => {
      expect(
        evaluateFilter({ tags: { $contains: "x" } }, { tags: ["x", "y"] }),
      ).toBe(true);
      expect(
        evaluateFilter({ tags: { $contains: "z" } }, { tags: ["x", "y"] }),
      ).toBe(false);
    });

    test("Set membership", () => {
      expect(
        evaluateFilter({ tags: { $contains: "x" } }, { tags: new Set(["x"]) }),
      ).toBe(true);
      expect(
        evaluateFilter({ tags: { $contains: "z" } }, { tags: new Set(["x"]) }),
      ).toBe(false);
    });

    test("returns false on non-collection types", () => {
      expect(evaluateFilter({ x: { $contains: "y" } }, { x: 42 })).toBe(false);
      expect(evaluateFilter({ x: { $contains: "y" } }, {})).toBe(false);
    });
  });

  describe("$beginsWith", () => {
    test("string prefix match", () => {
      expect(
        evaluateFilter({ s: { $beginsWith: "foo" } }, { s: "foobar" }),
      ).toBe(true);
      expect(
        evaluateFilter({ s: { $beginsWith: "bar" } }, { s: "foobar" }),
      ).toBe(false);
    });

    test("non-string returns false (binary not supported on this path)", () => {
      expect(
        evaluateFilter({ x: { $beginsWith: "foo" } }, { x: Buffer.from("foobar") }),
      ).toBe(false);
    });
  });

  describe("$exists", () => {
    test("$exists: true", () => {
      expect(evaluateFilter({ x: { $exists: true } }, { x: 1 })).toBe(true);
      expect(evaluateFilter({ x: { $exists: true } }, { x: 0 })).toBe(true);
      expect(evaluateFilter({ x: { $exists: true } }, { x: "" })).toBe(true);
      expect(evaluateFilter({ x: { $exists: true } }, {})).toBe(false);
      expect(evaluateFilter({ x: { $exists: true } }, { x: null })).toBe(false);
    });

    test("$exists: false", () => {
      expect(evaluateFilter({ x: { $exists: false } }, {})).toBe(true);
      expect(evaluateFilter({ x: { $exists: false } }, { x: null })).toBe(true);
      expect(evaluateFilter({ x: { $exists: false } }, { x: 1 })).toBe(false);
    });

    test("non-boolean throws", () => {
      expect(() =>
        evaluateFilter({ x: { $exists: "yes" } }, { x: 1 }),
      ).toThrow(ValidationError);
    });
  });

  describe("$size", () => {
    test("direct number on array/string/set/map", () => {
      expect(evaluateFilter({ tags: { $size: 3 } }, { tags: [1, 2, 3] })).toBe(true);
      expect(evaluateFilter({ tags: { $size: 2 } }, { tags: [1, 2, 3] })).toBe(false);
      expect(evaluateFilter({ s: { $size: 3 } }, { s: "abc" })).toBe(true);
      expect(
        evaluateFilter({ tags: { $size: 1 } }, { tags: new Set(["a"]) }),
      ).toBe(true);
      expect(
        evaluateFilter({ m: { $size: 2 } }, { m: { a: 1, b: 2 } }),
      ).toBe(true);
    });

    test("with comparison operator", () => {
      expect(
        evaluateFilter({ tags: { $size: { $gt: 2 } } }, { tags: [1, 2, 3] }),
      ).toBe(true);
      expect(
        evaluateFilter({ tags: { $size: { $lt: 2 } } }, { tags: [1, 2, 3] }),
      ).toBe(false);
    });

    test("multiple inner operators throws", () => {
      expect(() =>
        evaluateFilter(
          { tags: { $size: { $gt: 1, $lt: 5 } } },
          { tags: [1, 2, 3] },
        ),
      ).toThrow(ValidationError);
    });

    test("non-number/non-object throws", () => {
      expect(() =>
        evaluateFilter({ tags: { $size: "big" } }, { tags: [] }),
      ).toThrow(ValidationError);
    });
  });

  describe("logical operators", () => {
    test("$and matches when all conditions match", () => {
      expect(
        evaluateFilter(
          { $and: [{ x: 1 }, { y: 2 }] },
          { x: 1, y: 2 },
        ),
      ).toBe(true);
      expect(
        evaluateFilter(
          { $and: [{ x: 1 }, { y: 3 }] },
          { x: 1, y: 2 },
        ),
      ).toBe(false);
    });

    test("$and with empty array is vacuously true", () => {
      expect(evaluateFilter({ $and: [] }, { x: 1 })).toBe(true);
    });

    test("$or matches when any condition matches", () => {
      expect(
        evaluateFilter(
          { $or: [{ x: 1 }, { x: 2 }] },
          { x: 2 },
        ),
      ).toBe(true);
      expect(
        evaluateFilter(
          { $or: [{ x: 1 }, { x: 2 }] },
          { x: 3 },
        ),
      ).toBe(false);
    });

    test("$or with empty array is vacuously false", () => {
      expect(evaluateFilter({ $or: [] }, { x: 1 })).toBe(false);
    });

    test("$not inverts inner condition", () => {
      expect(evaluateFilter({ $not: { x: 1 } }, { x: 2 })).toBe(true);
      expect(evaluateFilter({ $not: { x: 1 } }, { x: 1 })).toBe(false);
    });

    test("$and / $or non-array throws", () => {
      expect(() => evaluateFilter({ $and: { x: 1 } }, { x: 1 })).toThrow(
        QueryError,
      );
      expect(() => evaluateFilter({ $or: { x: 1 } }, { x: 1 })).toThrow(
        QueryError,
      );
    });
  });

  describe("nested combinations", () => {
    test("$or of $and", () => {
      const f = {
        $or: [
          { $and: [{ status: "admin" }, { score: { $gt: 50 } }] },
          { tier: "premium" },
        ],
      };
      expect(evaluateFilter(f, { status: "admin", score: 60 })).toBe(true);
      expect(evaluateFilter(f, { tier: "premium" })).toBe(true);
      expect(evaluateFilter(f, { status: "admin", score: 10 })).toBe(false);
    });

    test("top-level field plus $or combine with AND", () => {
      const f = {
        active: true,
        $or: [{ role: "admin" }, { role: "moderator" }],
      };
      expect(evaluateFilter(f, { active: true, role: "admin" })).toBe(true);
      expect(evaluateFilter(f, { active: false, role: "admin" })).toBe(false);
      expect(evaluateFilter(f, { active: true, role: "user" })).toBe(false);
    });
  });

  describe("error handling", () => {
    test("unknown operator throws", () => {
      expect(() =>
        evaluateFilter({ x: { $weird: 1 } }, { x: 1 }),
      ).toThrow(QueryError);
    });
  });
});
