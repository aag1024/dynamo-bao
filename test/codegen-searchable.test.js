const { applyModelDefaults } = require("../bin/lib/process-models");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { generateModelFiles } = require("../bin/generators/model");
const FieldResolver = require("../src/fieldResolver");
const builtInFields = require("../src/fields");

function makePost(overrides = {}) {
  return {
    Post: {
      modelPrefix: "p",
      fields: {
        postId: { type: "UlidField", autoAssign: true },
        title: { type: "StringField", required: true },
        body: { type: "StringField" },
        viewCount: { type: "IntegerField" },
        ...(overrides.fields || {}),
      },
      primaryKey: { partitionKey: "postId" },
      ...(overrides.modelOverrides || {}),
    },
  };
}

describe("applyModelDefaults — iterable/iterationBuckets defaults (existing behavior preserved)", () => {
  test("defaults iterable to true for standard tables", () => {
    const models = makePost();
    applyModelDefaults(models);
    expect(models.Post.iterable).toBe(true);
  });

  test("defaults iterationBuckets to 10 when iterable is true", () => {
    const models = makePost();
    applyModelDefaults(models);
    expect(models.Post.iterationBuckets).toBe(10);
  });

  test("defaults iterable to false for mapping tables", () => {
    const models = makePost({ modelOverrides: { tableType: "mapping" } });
    applyModelDefaults(models);
    expect(models.Post.iterable).toBe(false);
  });
});

describe("applyModelDefaults — searchable defaults", () => {
  test("defaults searchable to false when omitted", () => {
    const models = makePost();
    applyModelDefaults(models);
    expect(models.Post.searchable).toBe(false);
  });

  test("preserves searchable: false explicitly", () => {
    const models = makePost({ modelOverrides: { searchable: false } });
    applyModelDefaults(models);
    expect(models.Post.searchable).toBe(false);
  });

  test("normalizes searchable object with required defaults", () => {
    const models = makePost({
      modelOverrides: { searchable: { fields: ["title", "body"] } },
    });
    applyModelDefaults(models);
    expect(models.Post.searchable).toEqual({
      fields: ["title", "body"],
      caseSensitive: false,
      minTermLength: 1,
      dedupe: false,
    });
  });

  test("preserves explicit searchable options", () => {
    const models = makePost({
      modelOverrides: {
        searchable: {
          fields: ["title"],
          caseSensitive: true,
          minTermLength: 3,
          dedupe: true,
        },
      },
    });
    applyModelDefaults(models);
    expect(models.Post.searchable).toEqual({
      fields: ["title"],
      caseSensitive: true,
      minTermLength: 3,
      dedupe: true,
    });
  });
});

describe("applyModelDefaults — searchable validation errors", () => {
  test("throws when searchable is a non-boolean, non-object value", () => {
    const models = makePost({ modelOverrides: { searchable: "yes" } });
    expect(() => applyModelDefaults(models)).toThrow(
      /Post.*searchable.*must be either a boolean or an object/i,
    );
  });

  test("throws when searchable.fields is missing", () => {
    const models = makePost({ modelOverrides: { searchable: {} } });
    expect(() => applyModelDefaults(models)).toThrow(
      /Post.*searchable\.fields.*non-empty array/i,
    );
  });

  test("throws when searchable.fields is empty array", () => {
    const models = makePost({
      modelOverrides: { searchable: { fields: [] } },
    });
    expect(() => applyModelDefaults(models)).toThrow(
      /Post.*searchable\.fields.*non-empty array/i,
    );
  });

  test("throws when searchable.fields is not an array", () => {
    const models = makePost({
      modelOverrides: { searchable: { fields: "title" } },
    });
    expect(() => applyModelDefaults(models)).toThrow(
      /Post.*searchable\.fields.*non-empty array/i,
    );
  });

  test("throws when searchable.fields references a non-existent field", () => {
    const models = makePost({
      modelOverrides: { searchable: { fields: ["nope"] } },
    });
    expect(() => applyModelDefaults(models)).toThrow(
      /Post.*searchable\.fields.*"nope".*not defined/i,
    );
  });

  test("throws when searchable.fields references a non-string field type", () => {
    const models = makePost({
      modelOverrides: { searchable: { fields: ["title", "viewCount"] } },
    });
    expect(() => applyModelDefaults(models)).toThrow(
      /Post.*searchable\.fields.*"viewCount".*StringField.*IntegerField/i,
    );
  });

  test("throws when searchable.minTermLength is not a positive integer", () => {
    const cases = [-1, 0, 1.5, "2", null];
    for (const bad of cases) {
      const models = makePost({
        modelOverrides: {
          searchable: { fields: ["title"], minTermLength: bad },
        },
      });
      expect(() => applyModelDefaults(models)).toThrow(
        /Post.*searchable\.minTermLength.*positive integer/i,
      );
    }
  });

  test("throws when searchable.dedupe is non-boolean", () => {
    const models = makePost({
      modelOverrides: { searchable: { fields: ["title"], dedupe: "yes" } },
    });
    expect(() => applyModelDefaults(models)).toThrow(
      /Post.*searchable\.dedupe.*boolean/i,
    );
  });

  test("throws when searchable.caseSensitive is non-boolean", () => {
    const models = makePost({
      modelOverrides: {
        searchable: { fields: ["title"], caseSensitive: 1 },
      },
    });
    expect(() => applyModelDefaults(models)).toThrow(
      /Post.*searchable\.caseSensitive.*boolean/i,
    );
  });

  test("throws when an unknown searchable option is provided", () => {
    const models = makePost({
      modelOverrides: {
        searchable: { fields: ["title"], stopwords: ["a"] },
      },
    });
    expect(() => applyModelDefaults(models)).toThrow(
      /Post.*searchable.*unknown option.*stopwords/i,
    );
  });
});

describe("model generator emits searchable static properties", () => {
  let outputDir;
  let resolver;
  beforeAll(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "dynamo-bao-codegen-"));
    resolver = new FieldResolver(builtInFields, null);
  });

  afterAll(() => {
    if (outputDir) fs.rmSync(outputDir, { recursive: true, force: true });
  });

  function generate(models) {
    applyModelDefaults(models);
    generateModelFiles(models, outputDir, resolver, "commonjs");
  }

  test("emits searchable=false and searchConfig=null when omitted", () => {
    generate(makePost());
    const code = fs.readFileSync(path.join(outputDir, "post.js"), "utf8");
    expect(code).toMatch(/static searchable = false;/);
    expect(code).toMatch(/static searchConfig = null;/);
  });

  test("emits searchable=true and searchConfig literal when configured", () => {
    generate(
      makePost({
        modelOverrides: {
          searchable: { fields: ["title", "body"], minTermLength: 2 },
        },
      }),
    );
    const code = fs.readFileSync(path.join(outputDir, "post.js"), "utf8");
    expect(code).toMatch(/static searchable = true;/);
    expect(code).toMatch(/static searchConfig = \{[^}]*"fields":\["title","body"\]/);
    expect(code).toMatch(/"minTermLength":2/);
    expect(code).toMatch(/"caseSensitive":false/);
    expect(code).toMatch(/"dedupe":false/);
  });
});

describe("applyModelDefaults — searchable: true shortcut", () => {
  // Plan v1 says searchable is YAML-driven; the boolean true form would need a
  // plugin override which we explicitly cut from v1. So `searchable: true`
  // (without an object) must be rejected with a clear pointer to the object form.
  test("throws when searchable is set to true without a fields array", () => {
    const models = makePost({ modelOverrides: { searchable: true } });
    expect(() => applyModelDefaults(models)).toThrow(
      /Post.*searchable.*provide an object with `fields`/i,
    );
  });
});
