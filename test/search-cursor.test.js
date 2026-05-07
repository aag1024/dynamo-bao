// Unit tests for cursor encode/decode and predicateHash. Both back the
// resume support on searchAll/searchBucket.

const {
  encodeCursor,
  decodeCursor,
  predicateHash,
} = require("../src/utils/search-text");

describe("predicateHash", () => {
  const cfg = {
    fields: ["title"],
    caseSensitive: false,
    minTermLength: 1,
    dedupe: false,
  };

  test("returns the same hash for the same inputs", () => {
    const a = predicateHash(["foo", "bar"], "$and", cfg);
    const b = predicateHash(["foo", "bar"], "$and", cfg);
    expect(a).toBe(b);
  });

  test("differs when terms differ", () => {
    expect(predicateHash(["foo"], "$and", cfg)).not.toBe(
      predicateHash(["bar"], "$and", cfg),
    );
  });

  test("differs when operator differs", () => {
    expect(predicateHash(["foo", "bar"], "$and", cfg)).not.toBe(
      predicateHash(["foo", "bar"], "$or", cfg),
    );
  });

  test("differs when caseSensitive differs (changes how terms normalize)", () => {
    expect(predicateHash(["Foo"], "$and", cfg)).not.toBe(
      predicateHash(["Foo"], "$and", { ...cfg, caseSensitive: true }),
    );
  });

  test("differs when minTermLength differs", () => {
    // 'a' (1 char) drops at minTermLength: 2, kept at minTermLength: 1.
    // The dropped-vs-kept change must be reflected in the hash so a
    // resume with a different config doesn't return wrong results.
    expect(predicateHash(["a", "fox"], "$and", cfg)).not.toBe(
      predicateHash(["a", "fox"], "$and", { ...cfg, minTermLength: 2 }),
    );
  });

  test("returns a stable opaque string", () => {
    const h = predicateHash(["foo"], "$and", cfg);
    expect(typeof h).toBe("string");
    expect(h.length).toBeGreaterThan(0);
  });
});

describe("encodeCursor / decodeCursor", () => {
  const sampleState = {
    bucketCursors: {
      0: { _iter_pk: "p#iter#000", _iter_sk: "abc" },
      2: { _iter_pk: "p#iter#002", _iter_sk: "xyz" },
    },
    predicateHash: "abc123",
    modelPrefix: "p",
    scope: [0, 1, 2, 3, 4],
    pendingItemKeys: ["id1", "id2", "id3"],
  };

  test("round-trips a full cursor", () => {
    const encoded = encodeCursor(sampleState);
    expect(typeof encoded).toBe("string");
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(sampleState);
  });

  test("round-trips with empty pendingItemKeys", () => {
    const state = { ...sampleState, pendingItemKeys: [] };
    expect(decodeCursor(encodeCursor(state))).toEqual(state);
  });

  test("round-trips with scope=[N] for searchBucket cursors", () => {
    const state = { ...sampleState, scope: [2] };
    expect(decodeCursor(encodeCursor(state))).toEqual(state);
  });

  test("encodeCursor without explicit pendingItemKeys defaults to []", () => {
    const state = {
      bucketCursors: {},
      predicateHash: "x",
      modelPrefix: "p",
      scope: [0],
    };
    const decoded = decodeCursor(encodeCursor(state));
    expect(decoded.pendingItemKeys).toEqual([]);
  });

  test("encoded form is base64-ish and opaque (not raw JSON)", () => {
    const encoded = encodeCursor(sampleState);
    // Should not look like JSON to the caller.
    expect(encoded).not.toMatch(/^\{/);
    expect(encoded).toMatch(/^[A-Za-z0-9+/=_-]+$/);
  });

  test("round-trips an empty bucketCursors map", () => {
    const state = {
      bucketCursors: {},
      predicateHash: "x",
      modelPrefix: "p",
      scope: [3],
      pendingItemKeys: [],
    };
    expect(decodeCursor(encodeCursor(state))).toEqual(state);
  });

  test("base64url round-trip survives all base64-special characters", () => {
    // Use a state whose JSON serialization contains characters that base64
    // encodes to + and / — verifies our manual base64url variant correctly
    // emits - and _ instead, and decodeCursor round-trips them.
    const state = {
      bucketCursors: { 0: { _iter_pk: "??>>>", _iter_sk: ">>>" } },
      predicateHash: "h",
      modelPrefix: "p",
      scope: [0],
      pendingItemKeys: [],
    };
    const encoded = encodeCursor(state);
    expect(encoded).not.toMatch(/[+/]/); // url-safe alphabet only
    expect(decodeCursor(encoded)).toEqual(state);
  });

  test("decodeCursor throws on cursor missing required scope field", () => {
    // Simulate a cursor produced before the `scope` field existed.
    const legacyJson = JSON.stringify({
      bucketCursors: {},
      predicateHash: "x",
      modelPrefix: "p",
      pendingItemKeys: [],
    });
    const legacyCursor = Buffer.from(legacyJson, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(() => decodeCursor(legacyCursor)).toThrow(/cursor.*scope/i);
  });

  test("decodeCursor throws on malformed input (truncated)", () => {
    const encoded = encodeCursor(sampleState);
    const truncated = encoded.slice(0, encoded.length - 5);
    expect(() => decodeCursor(truncated)).toThrow(/cursor/i);
  });

  test("decodeCursor throws on malformed input (not base64)", () => {
    expect(() => decodeCursor("$$not-base64$$")).toThrow(/cursor/i);
  });

  test("decodeCursor throws on valid base64 but non-JSON payload", () => {
    const garbage = Buffer.from("not json").toString("base64url");
    expect(() => decodeCursor(garbage)).toThrow(/cursor/i);
  });

  test("decodeCursor throws on JSON payload missing required fields", () => {
    const bad = Buffer.from(JSON.stringify({ wrong: "shape" })).toString(
      "base64url",
    );
    expect(() => decodeCursor(bad)).toThrow(/cursor/i);
  });

  test("decodeCursor throws on null/empty", () => {
    expect(() => decodeCursor(null)).toThrow(/cursor/i);
    expect(() => decodeCursor("")).toThrow(/cursor/i);
    expect(() => decodeCursor(undefined)).toThrow(/cursor/i);
  });
});
