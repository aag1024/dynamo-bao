const { computeSearchTextUpdate } = require("../src/utils/search-text");

const config = {
  fields: ["title", "body"],
  caseSensitive: false,
  minTermLength: 1,
  dedupe: false,
};

function currentItem(data) {
  return { _dyData: data };
}

describe("computeSearchTextUpdate", () => {
  test("returns undefined when no searchConfig", () => {
    expect(
      computeSearchTextUpdate({
        searchConfig: null,
        dyUpdatesToSave: { title: "x" },
        currentItem: null,
        isNew: true,
      }),
    ).toBeUndefined();
  });

  describe("isNew (insert)", () => {
    test("computes from provided fields when source fields populated", () => {
      const r = computeSearchTextUpdate({
        searchConfig: config,
        dyUpdatesToSave: { title: "Hello", body: "World" },
        currentItem: null,
        isNew: true,
      });
      expect(r).toBe("hello world");
    });

    test("returns undefined when result is empty (no point REMOVE on insert)", () => {
      const r = computeSearchTextUpdate({
        searchConfig: config,
        dyUpdatesToSave: { title: "", body: null },
        currentItem: null,
        isNew: true,
      });
      expect(r).toBeUndefined();
    });

    test("returns undefined when source fields are all undefined", () => {
      const r = computeSearchTextUpdate({
        searchConfig: config,
        dyUpdatesToSave: {},
        currentItem: null,
        isNew: true,
      });
      expect(r).toBeUndefined();
    });

    test("ignores currentItem on insert (currentItem should be null)", () => {
      const r = computeSearchTextUpdate({
        searchConfig: config,
        dyUpdatesToSave: { title: "Only Title" },
        currentItem: null,
        isNew: true,
      });
      expect(r).toBe("only title");
    });
  });

  describe("update (not isNew, not forceReindex)", () => {
    test("returns undefined when no source field is touched", () => {
      const r = computeSearchTextUpdate({
        searchConfig: config,
        dyUpdatesToSave: { status: "active" },
        currentItem: currentItem({ title: "Hello", body: "World" }),
        isNew: false,
      });
      expect(r).toBeUndefined();
    });

    test("recomputes when one source field is touched, backfills others", () => {
      const r = computeSearchTextUpdate({
        searchConfig: config,
        dyUpdatesToSave: { title: "New Title" },
        currentItem: currentItem({ title: "Old Title", body: "Old Body" }),
        isNew: false,
      });
      expect(r).toBe("new title old body");
    });

    test("returns null (REMOVE) when recompute yields empty", () => {
      const r = computeSearchTextUpdate({
        searchConfig: config,
        dyUpdatesToSave: { title: null, body: null },
        currentItem: currentItem({ title: "Old Title", body: "Old Body" }),
        isNew: false,
      });
      expect(r).toBeNull();
    });

    test("source field set to null on update is treated as cleared", () => {
      const r = computeSearchTextUpdate({
        searchConfig: config,
        dyUpdatesToSave: { title: null },
        currentItem: currentItem({ title: "Old Title", body: "Body" }),
        isNew: false,
      });
      expect(r).toBe("body");
    });

    test("recomputes correctly when all source fields are touched at once", () => {
      const r = computeSearchTextUpdate({
        searchConfig: config,
        dyUpdatesToSave: { title: "Foo", body: "Bar" },
        currentItem: currentItem({ title: "Old", body: "Stuff" }),
        isNew: false,
      });
      expect(r).toBe("foo bar");
    });

    test("touching a non-source field alongside a source field still recomputes", () => {
      const r = computeSearchTextUpdate({
        searchConfig: config,
        dyUpdatesToSave: { title: "X", status: "active" },
        currentItem: currentItem({ title: "Y", body: "Z" }),
        isNew: false,
      });
      expect(r).toBe("x z");
    });
  });

  describe("forceReindex", () => {
    test("recomputes from currentItem when no fields are in dyUpdatesToSave", () => {
      const r = computeSearchTextUpdate({
        searchConfig: config,
        dyUpdatesToSave: {},
        currentItem: currentItem({ title: "Hello", body: "World" }),
        isNew: false,
        forceReindex: true,
      });
      expect(r).toBe("hello world");
    });

    test("merges dyUpdatesToSave on top of currentItem", () => {
      const r = computeSearchTextUpdate({
        searchConfig: config,
        dyUpdatesToSave: { title: "New" },
        currentItem: currentItem({ title: "Old", body: "Body" }),
        isNew: false,
        forceReindex: true,
      });
      expect(r).toBe("new body");
    });

    test("returns null when force reindex yields empty", () => {
      const r = computeSearchTextUpdate({
        searchConfig: config,
        dyUpdatesToSave: {},
        currentItem: currentItem({ title: null, body: null }),
        isNew: false,
        forceReindex: true,
      });
      expect(r).toBeNull();
    });
  });

  describe("config edge cases", () => {
    test("respects caseSensitive true on save-time computation", () => {
      const r = computeSearchTextUpdate({
        searchConfig: { ...config, caseSensitive: true },
        dyUpdatesToSave: { title: "Hello" },
        currentItem: null,
        isNew: true,
      });
      expect(r).toBe("Hello");
    });

    test("respects dedupe option", () => {
      const r = computeSearchTextUpdate({
        searchConfig: { ...config, dedupe: true },
        dyUpdatesToSave: { title: "foo foo bar" },
        currentItem: null,
        isNew: true,
      });
      expect(r).toBe("foo bar");
    });

    test("respects minTermLength", () => {
      const r = computeSearchTextUpdate({
        searchConfig: { ...config, minTermLength: 2 },
        dyUpdatesToSave: { title: "a foo bar" },
        currentItem: null,
        isNew: true,
      });
      expect(r).toBe("foo bar");
    });
  });
});
