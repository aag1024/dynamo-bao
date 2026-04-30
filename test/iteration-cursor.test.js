const { encodeCursor, decodeCursor, CURSOR_VERSION } = require("../src/iteration-cursor");
const { QueryError } = require("../src/exceptions");

describe("iteration-cursor", () => {
  const ctx = { modelPrefix: "iu", tenantId: "tenant-a", iterationBuckets: 5 };

  describe("encode + decode round-trip", () => {
    test("preserves queue order exactly", () => {
      const queue = [
        [3, { _iter_pk: "[tenant-a]#iu#iter#003", _iter_sk: "X", _pk: "Y", _sk: "Z" }],
        [0, { _iter_pk: "[tenant-a]#iu#iter#000", _iter_sk: "A", _pk: "B", _sk: "C" }],
        [4, { _iter_pk: "[tenant-a]#iu#iter#004", _iter_sk: "P", _pk: "Q", _sk: "R" }],
      ];
      const cursor = encodeCursor({ ...ctx, queue });
      const { queue: decoded } = decodeCursor(cursor, ctx);
      expect(decoded).toEqual(queue);
    });

    test("works with no tenant", () => {
      const noTenantCtx = { modelPrefix: "iu", tenantId: null, iterationBuckets: 5 };
      const queue = [[1, { _iter_pk: "iu#iter#001", _iter_sk: "X", _pk: "Y", _sk: "Z" }]];
      const cursor = encodeCursor({ ...noTenantCtx, queue });
      const { queue: decoded } = decodeCursor(cursor, noTenantCtx);
      expect(decoded).toEqual(queue);
    });

    test("treats undefined and null tenantId equivalently", () => {
      const queue = [[0, { _iter_pk: "iu#iter#000", _iter_sk: "X", _pk: "Y", _sk: "Z" }]];
      const cursor = encodeCursor({
        modelPrefix: "iu",
        tenantId: undefined,
        iterationBuckets: 5,
        queue,
      });
      const { queue: decoded } = decodeCursor(cursor, { modelPrefix: "iu", tenantId: null, iterationBuckets: 5 });
      expect(decoded).toEqual(queue);
    });
  });

  describe("validation rejects mismatches", () => {
    const queue = [[0, { _iter_pk: "[tenant-a]#iu#iter#000", _iter_sk: "X", _pk: "Y", _sk: "Z" }]];
    const cursor = encodeCursor({ ...ctx, queue });

    test("wrong model prefix", () => {
      expect(() => decodeCursor(cursor, { ...ctx, modelPrefix: "su" })).toThrow(
        /model mismatch/,
      );
    });

    test("wrong tenant", () => {
      expect(() => decodeCursor(cursor, { ...ctx, tenantId: "tenant-b" })).toThrow(
        /tenant mismatch/,
      );
    });

    test("changed bucket count", () => {
      expect(() => decodeCursor(cursor, { ...ctx, iterationBuckets: 10 })).toThrow(
        /bucket count changed/,
      );
    });

    test("bucket number outside valid range", () => {
      const badQueue = [[7, { _iter_pk: "x", _iter_sk: "X", _pk: "Y", _sk: "Z" }]];
      const badCursor = encodeCursor({ ...ctx, queue: badQueue });
      expect(() => decodeCursor(badCursor, ctx)).toThrow(/malformed queue entry/);
    });
  });

  describe("validation rejects malformed input", () => {
    test("empty string", () => {
      expect(() => decodeCursor("", ctx)).toThrow(QueryError);
    });

    test("non-string", () => {
      expect(() => decodeCursor(null, ctx)).toThrow(/non-empty string/);
      expect(() => decodeCursor(123, ctx)).toThrow(/non-empty string/);
    });

    test("garbage base64", () => {
      expect(() => decodeCursor("not-valid-json-base64", ctx)).toThrow(QueryError);
    });

    test("valid base64 but not an object", () => {
      const cursor = Buffer.from(JSON.stringify("a string"), "utf8").toString("base64url");
      expect(() => decodeCursor(cursor, ctx)).toThrow(/payload is not an object/);
    });

    test("unsupported version", () => {
      const cursor = Buffer.from(
        JSON.stringify({ v: 999, m: "iu", t: "tenant-a", n: 5, b: [] }),
        "utf8",
      ).toString("base64url");
      expect(() => decodeCursor(cursor, ctx)).toThrow(/unsupported version/);
    });

    test("queue not an array", () => {
      const cursor = Buffer.from(
        JSON.stringify({ v: CURSOR_VERSION, m: "iu", t: "tenant-a", n: 5, b: { foo: "bar" } }),
        "utf8",
      ).toString("base64url");
      expect(() => decodeCursor(cursor, ctx)).toThrow(/queue must be an array/);
    });

    test("malformed queue entry shapes", () => {
      const cases = [
        [["not-a-tuple"]],
        [[0]],
        [[0, "not-an-object"]],
        [[-1, { _iter_pk: "x", _iter_sk: "y", _pk: "p", _sk: "s" }]],
      ];
      for (const b of cases) {
        const cursor = Buffer.from(
          JSON.stringify({ v: CURSOR_VERSION, m: "iu", t: "tenant-a", n: 5, b }),
          "utf8",
        ).toString("base64url");
        expect(() => decodeCursor(cursor, ctx)).toThrow(/malformed queue entry/);
      }
    });
  });

  describe("encoding format", () => {
    test("uses base64url (no +, /, or = padding)", () => {
      const queue = Array.from({ length: 20 }, (_, i) => [
        i % 5,
        { _iter_pk: `[tenant-a]#iu#iter#${String(i % 5).padStart(3, "0")}`, _iter_sk: `id-${i}`, _pk: `pk-${i}`, _sk: `sk-${i}` },
      ]);
      const cursor = encodeCursor({ ...ctx, queue });
      expect(cursor).not.toMatch(/[+/=]/);
    });
  });
});
