const {
  BaoModel,
  PrimaryKeyConfig,
  UniqueConstraintConfig,
} = require("../src/model");
const {
  StringField,
  IntegerField,
  FloatField,
  DateTimeField,
  CreateDateField,
  VersionField,
} = require("../src/fields");
const { FilterExpressionBuilder } = require("../src/filter-expression");
const { runWithBatchContext } = require("../src/mixins/batch-loading-mixin");
const { QueryError, ValidationError } = require("../src/exceptions");
const { UNIQUE_CONSTRAINT_ID1 } = require("../src/constants");

// Records every request and answers just enough for the write paths to finish.
function mockClient(storedItem = null) {
  const sent = [];
  return {
    sent,
    async send(command) {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command.input.Key && !command.input.UpdateExpression) {
        return { Item: storedItem, ConsumedCapacity: {} };
      }
      return { Attributes: { ...command.input.Key }, ConsumedCapacity: {} };
    },
  };
}

function useClient(Model, client) {
  Model.documentClient = client;
  Model.table = "test-table";
  Model._validateConfiguration();
}

class Doc extends BaoModel {
  static modelPrefix = "dc";
  static fields = {
    docId: StringField({ required: true }),
    n1: StringField(),
    v1: StringField(),
    owner: StringField(),
    secret: StringField(),
    createdAt: CreateDateField(),
    version: VersionField(),
  };
  static primaryKey = PrimaryKeyConfig("docId");
}

class Member extends BaoModel {
  static modelPrefix = "mb";
  static fields = {
    orgId: StringField({ required: true }),
    userId: StringField({ required: true }),
  };
  static primaryKey = PrimaryKeyConfig("orgId", "userId");
}

class Account extends BaoModel {
  static modelPrefix = "acu";
  static fields = {
    accountId: StringField({ required: true }),
    email: StringField(),
    name: StringField(),
  };
  static primaryKey = PrimaryKeyConfig("accountId");
  static uniqueConstraints = {
    uniqueEmail: UniqueConstraintConfig("email", UNIQUE_CONSTRAINT_ID1),
  };
}

const lastWrite = (client) =>
  client.sent.filter((s) => s.input.UpdateExpression).at(-1).input;

describe("conditional writes", () => {
  test("condition placeholders don't collide with field placeholders", async () => {
    const client = mockClient();
    useClient(Doc, client);

    await runWithBatchContext(() =>
      Doc.update(
        "d1",
        { n1: "new", v1: "also-new" },
        {
          condition: { owner: "alice" },
        },
      ),
    );

    const input = lastWrite(client);
    expect(input.ExpressionAttributeNames["#n1"]).toBe("n1");
    expect(input.ExpressionAttributeNames["#v1"]).toBe("v1");
    expect(input.ExpressionAttributeValues[":n1"]).toBe("new");
    expect(input.ExpressionAttributeValues[":v1"]).toBe("also-new");
    expect(Object.values(input.ExpressionAttributeValues)).toContain("alice");
  });

  test("an unchanged unique value guards the update on the stored value", async () => {
    const stored = {
      _pk: "acu#a1",
      _sk: "acu",
      accountId: "a1",
      email: "a@example.com",
      name: "A",
    };
    const client = mockClient(stored);
    useClient(Account, client);

    await runWithBatchContext(() =>
      Account.update("a1", { email: "a@example.com", name: "B" }),
    );

    const input = lastWrite(client);
    expect(input.ConditionExpression).toContain(
      "#__loadedGuard_email = :__loadedGuard_email",
    );
    expect(input.ExpressionAttributeValues[":__loadedGuard_email"]).toBe(
      "a@example.com",
    );
  });
});

describe("primary keys", () => {
  test("an update can't change the primary key field", async () => {
    useClient(Doc, mockClient());
    await expect(
      runWithBatchContext(() => Doc.update("d1", { docId: "d2" })),
    ).rejects.toThrow(ValidationError);
  });

  test("an update may re-send the current primary key value", async () => {
    const client = mockClient();
    useClient(Doc, client);
    await runWithBatchContext(() =>
      Doc.update("d1", { docId: "d1", owner: "x" }),
    );
    expect(lastWrite(client).Key._pk).toContain("d1");
  });

  test("composite key values can't contain the id separator", async () => {
    useClient(Member, mockClient());
    await expect(
      runWithBatchContext(() =>
        Member.create({ orgId: "evil##__SK__##victim", userId: "x" }),
      ),
    ).rejects.toThrow(ValidationError);
  });

  test("an id with more than one separator is rejected", () => {
    expect(() =>
      Member._parsePrimaryId("evil##__SK__##victim##__SK__##x"),
    ).toThrow(ValidationError);
  });
});

describe("server-managed fields", () => {
  test("a caller can't set the version or overwrite createdAt on update", async () => {
    const client = mockClient();
    useClient(Doc, client);

    await runWithBatchContext(() =>
      Doc.update("d1", {
        owner: "x",
        version: "01AAAAAAAAAAAAAAAAAAAAAAAA",
        createdAt: new Date(0),
      }),
    );

    const input = lastWrite(client);
    expect(input.ExpressionAttributeValues[":version"]).not.toBe(
      "01AAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(input.ExpressionAttributeNames["#createdAt"]).toBeUndefined();
  });
});

describe("filter validation", () => {
  const build = (filter, options) =>
    new FilterExpressionBuilder().build(filter, Doc, options);

  test("$not over several fields negates the whole conjunction", () => {
    const { FilterExpression } = build({ $not: { owner: "a", n1: "b" } });
    expect(FilterExpression).toBe("NOT (#__f1 = :__f1 AND #__f2 = :__f2)");
  });

  test.each([
    ['{"constructor":{"$exists":true}}'],
    ['{"__proto__":{"$exists":false}}'],
    ['{"toString":"x"}'],
  ])("prototype keys are unknown fields: %s", (json) => {
    expect(() => build(JSON.parse(json))).toThrow(QueryError);
  });

  test("deeply nested filters are rejected", () => {
    let filter = { owner: "a" };
    for (let i = 0; i < 1000; i++) filter = { $not: filter };
    expect(() => build(filter)).toThrow(QueryError);
  });

  test("allowedFields restricts which fields a filter may reference", () => {
    const options = { allowedFields: ["owner"] };
    expect(build({ owner: "a" }, options)).not.toBeNull();
    expect(() =>
      build(
        { $or: [{ owner: "a" }, { secret: { $beginsWith: "x" } }] },
        options,
      ),
    ).toThrow("Field not allowed in filter: secret");
  });
});

describe("field validation", () => {
  test("StringField rejects objects and enforces maxLength", () => {
    const field = StringField({ maxLength: 3 });
    expect(() => field.validate({ $gt: "" })).toThrow(ValidationError);
    expect(() => field.validate(["a"])).toThrow(ValidationError);
    expect(() => field.validate("abcd")).toThrow(ValidationError);
    expect(field.validate("abc")).toBe(true);
  });

  test("number fields reject values that aren't numbers", () => {
    expect(() => IntegerField().validate("abc")).toThrow(ValidationError);
    expect(() => IntegerField().validate(1.5)).toThrow(ValidationError);
    expect(IntegerField().validate("42")).toBe(true);
    expect(() => FloatField().validate("abc")).toThrow(ValidationError);
    expect(FloatField().validate(1.5)).toBe(true);
  });

  test("date fields reject unparseable strings and convert valid ones", () => {
    expect(() => DateTimeField().validate("not a date")).toThrow(
      ValidationError,
    );
    expect(CreateDateField().toDy("2026-01-01T00:00:00Z")).toBe(
      Date.parse("2026-01-01T00:00:00Z"),
    );
  });
});

describe("codegen", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const FieldResolver = require("../src/fieldResolver");
  const { generateModelFiles } = require("../bin/generators/model");

  const resolver = new FieldResolver(require("../src/fields"), null);
  let outDir;

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "bao-codegen-"));
  });
  afterEach(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  const model = (overrides = {}) => ({
    modelPrefix: "u",
    fields: { userId: { type: "UlidField" }, name: { type: "StringField" } },
    primaryKey: { partitionKey: "userId" },
    ...overrides,
  });

  test("YAML values are emitted as literals, not code", () => {
    const payload = "a', x: globalThis.__baoPwned = true, y: 'b";
    generateModelFiles(
      {
        User: model({
          modelPrefix: "u'; globalThis.__baoPwned = true; //",
          fields: {
            userId: { type: "UlidField" },
            name: { type: "StringField", defaultValue: payload },
          },
        }),
      },
      outDir,
      resolver,
    );

    const source = fs.readFileSync(path.join(outDir, "user.js"), "utf8");
    expect(source).toContain(`defaultValue: ${JSON.stringify(payload)}`);
    expect(source).toContain(
      `modelPrefix = ${JSON.stringify("u'; globalThis.__baoPwned = true; //")}`,
    );
    expect(
      () => new Function(source.replace(/require\(/g, "(() => ({}))(")),
    ).not.toThrow();
  });

  test.each([
    ["model name", { "../../escaped": model() }],
    [
      "field name",
      { User: model({ fields: { "a-b": { type: "StringField" } } }) },
    ],
    [
      "unique constraint id",
      {
        User: model({
          uniqueConstraints: {
            uniqueName: { field: "name", uniqueConstraintId: "uc1;x" },
          },
        }),
      },
    ],
  ])("rejects an invalid %s before writing anything", (_, models) => {
    expect(() => generateModelFiles(models, outDir, resolver)).toThrow(
      /Invalid/,
    );
    expect(fs.readdirSync(outDir)).toEqual([]);
  });
});

describe("tenant ids", () => {
  const { ModelManager } = require("../src/model-manager");
  const { ConfigurationError } = require("../src/exceptions");

  test.each([["a]#d#q"], ["a#b"], [5]])("rejects %p", (tenantId) => {
    expect(() => ModelManager.forTenant(tenantId)).toThrow(ConfigurationError);
  });
});

describe("config lookup", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { initConfig } = require("../src/config");

  test("refuses a generic config.js instead of loading it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bao-config-"));
    const marker = path.join(dir, "loaded");
    fs.writeFileSync(
      path.join(dir, "config.js"),
      `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");`,
    );
    const cwd = process.cwd();
    const envConfig = process.env.DYNAMO_BAO_CONFIG;
    delete process.env.DYNAMO_BAO_CONFIG;
    process.chdir(dir);
    try {
      await expect(initConfig()).rejects.toThrow(/rename it/);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      process.chdir(cwd);
      if (envConfig !== undefined) process.env.DYNAMO_BAO_CONFIG = envConfig;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
