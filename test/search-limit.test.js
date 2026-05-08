// Unit tests for applyLimit (caps an async iterable of batches at N items
// total, slicing the last batch to fit) and validateLimit. Both back the
// `limit` option on searchAll/searchBucket.

const {
  applyLimit,
  validateLimit,
} = require("../src/utils/search-text");

async function* asyncIterable(batches) {
  for (const b of batches) yield b;
}

async function collect(iterable) {
  const out = [];
  for await (const batch of iterable) out.push(batch);
  return out;
}

describe("applyLimit", () => {
  test("yields all batches when total items < limit", async () => {
    const batches = await collect(
      applyLimit(asyncIterable([[1, 2], [3]]), 100),
    );
    expect(batches).toEqual([[1, 2], [3]]);
  });

  test("yields nothing when source is empty", async () => {
    const batches = await collect(applyLimit(asyncIterable([]), 100));
    expect(batches).toEqual([]);
  });

  test("respects exact limit at batch boundary (no further iteration)", async () => {
    const batches = await collect(
      applyLimit(asyncIterable([[1, 2, 3], [4, 5, 6]]), 3),
    );
    expect(batches).toEqual([[1, 2, 3]]);
  });

  test("slices the last batch to exactly fit the limit", async () => {
    const batches = await collect(
      applyLimit(asyncIterable([[1, 2], [3, 4, 5, 6]]), 4),
    );
    // 2 from first batch + 2 from second (sliced) = 4 total
    expect(batches).toEqual([[1, 2], [3, 4]]);
  });

  test("limit hit on first batch yields only what fits", async () => {
    const batches = await collect(
      applyLimit(asyncIterable([[1, 2, 3, 4, 5, 6, 7]]), 3),
    );
    expect(batches).toEqual([[1, 2, 3]]);
  });

  test("limit of 1 yields exactly one item", async () => {
    const batches = await collect(
      applyLimit(asyncIterable([[1, 2, 3]]), 1),
    );
    expect(batches).toEqual([[1]]);
  });

  test("limit = Infinity passes everything through", async () => {
    const batches = await collect(
      applyLimit(asyncIterable([[1, 2], [3], [4, 5, 6]]), Infinity),
    );
    expect(batches).toEqual([[1, 2], [3], [4, 5, 6]]);
  });

  test("stops pulling from the source iterable once limit is hit", async () => {
    // Track how many times the source was advanced. If applyLimit pulls
    // past the cap, we'd see calls > expected.
    let pulls = 0;
    async function* source() {
      pulls++;
      yield [1, 2];
      pulls++;
      yield [3, 4];
      pulls++;
      yield [5, 6];
    }
    await collect(applyLimit(source(), 3));
    // Should have pulled the first batch (yields [1,2]) and the second
    // (yields [3,4] sliced to [3]) — then stopped before pulling [5,6].
    expect(pulls).toBe(2);
  });

  test("preserves batch order and contents (does not mutate input batches)", async () => {
    const b1 = [1, 2];
    const b2 = [3, 4, 5];
    const out = await collect(applyLimit(asyncIterable([b1, b2]), 4));
    expect(out).toEqual([[1, 2], [3, 4]]);
    // Source arrays unmodified.
    expect(b1).toEqual([1, 2]);
    expect(b2).toEqual([3, 4, 5]);
  });

  test("empty batches in source don't count toward limit", async () => {
    const batches = await collect(
      applyLimit(asyncIterable([[], [1, 2], [], [3, 4]]), 3),
    );
    // Empty batches yielded as-is (caller handles), but only 3 items
    // counted toward limit so [3,4] becomes [3].
    expect(batches).toEqual([[], [1, 2], [], [3]]);
  });
});

describe("validateLimit", () => {
  test("accepts positive integers", () => {
    expect(() => validateLimit(1)).not.toThrow();
    expect(() => validateLimit(50)).not.toThrow();
    expect(() => validateLimit(1000000)).not.toThrow();
  });

  test("accepts Infinity", () => {
    expect(() => validateLimit(Infinity)).not.toThrow();
  });

  test("throws on zero", () => {
    expect(() => validateLimit(0)).toThrow(
      /limit must be a positive integer or Infinity/i,
    );
  });

  test("throws on negative", () => {
    expect(() => validateLimit(-1)).toThrow(
      /limit must be a positive integer or Infinity/i,
    );
    expect(() => validateLimit(-Infinity)).toThrow(
      /limit must be a positive integer or Infinity/i,
    );
  });

  test("throws on non-integer (other than Infinity)", () => {
    expect(() => validateLimit(1.5)).toThrow(
      /limit must be a positive integer or Infinity/i,
    );
  });

  test("throws on NaN", () => {
    expect(() => validateLimit(NaN)).toThrow(
      /limit must be a positive integer or Infinity/i,
    );
  });

  test("throws on non-number", () => {
    expect(() => validateLimit("100")).toThrow(
      /limit must be a positive integer or Infinity/i,
    );
    expect(() => validateLimit(null)).toThrow(
      /limit must be a positive integer or Infinity/i,
    );
    expect(() => validateLimit(undefined)).toThrow(
      /limit must be a positive integer or Infinity/i,
    );
  });
});
