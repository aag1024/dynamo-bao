const {
  buildSearchText,
  normalizeSearchTerm,
  tokenizeSearchQuery,
} = require("../src/utils/search-text");

describe("buildSearchText", () => {
  describe("basic concat + normalize", () => {
    test("returns empty string for empty values map", () => {
      const result = buildSearchText({}, { fields: ["title"] });
      expect(result).toBe("");
    });

    test("concats listed fields in order", () => {
      const result = buildSearchText(
        { title: "Hello", body: "World" },
        { fields: ["title", "body"] },
      );
      expect(result).toBe("hello world");
    });

    test("respects field order from config, not values map order", () => {
      const result = buildSearchText(
        { body: "World", title: "Hello" },
        { fields: ["title", "body"] },
      );
      expect(result).toBe("hello world");
    });

    test("ignores fields not listed in config", () => {
      const result = buildSearchText(
        { title: "Hello", body: "World", secret: "DO NOT INDEX" },
        { fields: ["title", "body"] },
      );
      expect(result).toBe("hello world");
    });

    test("skips null and undefined values", () => {
      const result = buildSearchText(
        { title: "Hello", body: null, summary: undefined },
        { fields: ["title", "body", "summary"] },
      );
      expect(result).toBe("hello");
    });

    test("returns empty string when all source fields are null", () => {
      const result = buildSearchText(
        { title: null, body: null },
        { fields: ["title", "body"] },
      );
      expect(result).toBe("");
    });
  });

  describe("case sensitivity", () => {
    test("lowercases by default (caseSensitive: false implicit)", () => {
      const result = buildSearchText(
        { title: "Hello WORLD" },
        { fields: ["title"] },
      );
      expect(result).toBe("hello world");
    });

    test("preserves case when caseSensitive is true", () => {
      const result = buildSearchText(
        { title: "Hello WORLD" },
        { fields: ["title"], caseSensitive: true },
      );
      expect(result).toBe("Hello WORLD");
    });
  });

  describe("punctuation and whitespace normalization", () => {
    test("strips punctuation to spaces", () => {
      const result = buildSearchText(
        { title: "Hello, world! How's it going?" },
        { fields: ["title"] },
      );
      expect(result).toBe("hello world how s it going");
    });

    test("collapses multiple whitespace into one", () => {
      const result = buildSearchText(
        { title: "hello    world\n\tfoo" },
        { fields: ["title"] },
      );
      expect(result).toBe("hello world foo");
    });

    test("trims leading and trailing whitespace", () => {
      const result = buildSearchText(
        { title: "   hello   " },
        { fields: ["title"] },
      );
      expect(result).toBe("hello");
    });
  });

  describe("dedupe option", () => {
    test("does not dedupe by default", () => {
      const result = buildSearchText(
        { title: "foo foo foo bar" },
        { fields: ["title"] },
      );
      expect(result).toBe("foo foo foo bar");
    });

    test("dedupes when dedupe: true (first-seen order)", () => {
      const result = buildSearchText(
        { title: "foo foo bar foo" },
        { fields: ["title"], dedupe: true },
      );
      expect(result).toBe("foo bar");
    });

    test("dedupes across multiple fields", () => {
      const result = buildSearchText(
        { title: "foo bar", body: "bar baz" },
        { fields: ["title", "body"], dedupe: true },
      );
      expect(result).toBe("foo bar baz");
    });
  });

  describe("minTermLength option", () => {
    test("does not filter when minTermLength is 1 (default)", () => {
      const result = buildSearchText(
        { title: "a an the foo" },
        { fields: ["title"] },
      );
      expect(result).toBe("a an the foo");
    });

    test("drops tokens shorter than minTermLength", () => {
      const result = buildSearchText(
        { title: "a an the foo" },
        { fields: ["title"], minTermLength: 3 },
      );
      expect(result).toBe("the foo");
    });

    test("counts characters not bytes for minTermLength", () => {
      // CJK characters are each one char
      const result = buildSearchText(
        { title: "a 中 中文 hello" },
        { fields: ["title"], minTermLength: 2 },
      );
      expect(result).toBe("中文 hello");
    });
  });

  describe("Unicode preservation", () => {
    test("preserves Chinese characters", () => {
      const result = buildSearchText(
        { title: "苹果手机, iPhone" },
        { fields: ["title"] },
      );
      expect(result).toBe("苹果手机 iphone");
    });

    test("preserves Cyrillic characters", () => {
      const result = buildSearchText(
        { title: "Привет, мир!" },
        { fields: ["title"] },
      );
      expect(result).toBe("привет мир");
    });

    test("preserves Arabic characters", () => {
      const result = buildSearchText(
        { title: "مرحبا بالعالم" },
        { fields: ["title"] },
      );
      expect(result).toBe("مرحبا بالعالم");
    });

    test("preserves Japanese characters and lowercases ASCII", () => {
      const result = buildSearchText(
        { title: "日本語 Test 123" },
        { fields: ["title"] },
      );
      expect(result).toBe("日本語 test 123");
    });

    test("strips full-width Chinese punctuation", () => {
      const result = buildSearchText(
        { title: "你好，世界。" },
        { fields: ["title"] },
      );
      expect(result).toBe("你好 世界");
    });
  });

  describe("number handling", () => {
    test("preserves digits", () => {
      const result = buildSearchText(
        { title: "iPhone 15 Pro" },
        { fields: ["title"] },
      );
      expect(result).toBe("iphone 15 pro");
    });

    test("coerces numeric values to string", () => {
      const result = buildSearchText(
        { title: "Item", price: 42 },
        { fields: ["title", "price"] },
      );
      expect(result).toBe("item 42");
    });
  });
});

describe("normalizeSearchTerm", () => {
  test("matches buildSearchText normalization for a single term", () => {
    expect(normalizeSearchTerm("Hello, World!", {})).toBe("hello world");
  });

  test("preserves case when caseSensitive: true", () => {
    expect(normalizeSearchTerm("Hello", { caseSensitive: true })).toBe("Hello");
  });

  test("returns empty string for whitespace-only term", () => {
    expect(normalizeSearchTerm("   ", {})).toBe("");
  });

  test("preserves CJK characters", () => {
    expect(normalizeSearchTerm("苹果", {})).toBe("苹果");
  });

  test("is idempotent", () => {
    const once = normalizeSearchTerm("Hello, World!", {});
    const twice = normalizeSearchTerm(once, {});
    expect(twice).toBe(once);
  });
});

describe("tokenizeSearchQuery", () => {
  test("splits simple whitespace-separated words", () => {
    expect(tokenizeSearchQuery("foo bar baz")).toEqual(["foo", "bar", "baz"]);
  });

  test("returns empty array for empty input", () => {
    expect(tokenizeSearchQuery("")).toEqual([]);
  });

  test("returns empty array for whitespace-only input", () => {
    expect(tokenizeSearchQuery("   ")).toEqual([]);
  });

  test("trims leading/trailing whitespace", () => {
    expect(tokenizeSearchQuery("   foo bar   ")).toEqual(["foo", "bar"]);
  });

  test("collapses inner whitespace", () => {
    expect(tokenizeSearchQuery("foo    bar")).toEqual(["foo", "bar"]);
  });

  test("honors double-quoted phrases as single terms", () => {
    expect(tokenizeSearchQuery('"hello world" foo')).toEqual([
      "hello world",
      "foo",
    ]);
  });

  test("supports multiple quoted phrases", () => {
    expect(tokenizeSearchQuery('"foo bar" "baz qux"')).toEqual([
      "foo bar",
      "baz qux",
    ]);
  });

  test("handles mixed quoted and bare", () => {
    expect(tokenizeSearchQuery('alice "bob carol" dave')).toEqual([
      "alice",
      "bob carol",
      "dave",
    ]);
  });

  test("drops empty quoted phrases", () => {
    expect(tokenizeSearchQuery('"" foo')).toEqual(["foo"]);
  });

  test("treats unmatched trailing quote as literal start of phrase", () => {
    // "foo bar with no closing quote — treat as one phrase to end of input
    expect(tokenizeSearchQuery('"foo bar')).toEqual(["foo bar"]);
  });

  test("handles non-ASCII text in quotes", () => {
    expect(tokenizeSearchQuery('"苹果 手机" iphone')).toEqual([
      "苹果 手机",
      "iphone",
    ]);
  });
});
