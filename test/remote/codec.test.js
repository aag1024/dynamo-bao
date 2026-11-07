const dynamoBao = require("../../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("../config");
const { BaoModel, PrimaryKeyConfig } = require("../../src/model");
const fields = require("../../src/fields");
const { ObjectNotFound } = require("../../src/object-not-found");
const { DetachedInstanceError } = require("../../src/exceptions");
const { encodeValue, decodeRow, CodecError } = require("../../src/remote/codec");
const {
  cleanupTestDataByIteration,
  initTestModelsWithTenant,
} = require("../utils/test-utils");
const { ulid } = require("ulid");

const {
  StringField,
  DateTimeField,
  CreateDateField,
  ModifiedDateField,
  UlidField,
  RelatedField,
  IntegerField,
  FloatField,
  CounterField,
  BinaryField,
  VersionField,
  BooleanField,
  TtlField,
  StringSetField,
  BaoBaseField,
} = { ...fields, BaoBaseField: Object.getPrototypeOf(fields.StringFieldClass) };

// One model with every field type in fields.js.
class RemoteEveryField extends BaoModel {
  static modelPrefix = "rmef";
  static iterable = true;
  static iterationBuckets = 1;
  static fields = {
    id: UlidField({ autoAssign: true }),
    name: StringField(),
    when: DateTimeField(),
    created: CreateDateField(),
    modified: ModifiedDateField(),
    owner: RelatedField("RemoteOwner"),
    count: IntegerField(),
    ratio: FloatField(),
    views: CounterField(),
    blob: BinaryField(),
    version: VersionField(),
    active: BooleanField(),
    ttl: TtlField(),
    tags: StringSetField(),
  };
  static primaryKey = PrimaryKeyConfig("id");
}

class RemoteOwner extends BaoModel {
  static modelPrefix = "rmow";
  static iterable = true;
  static iterationBuckets = 1;
  static fields = { ownerId: UlidField({ autoAssign: true }), label: StringField() };
  static primaryKey = PrimaryKeyConfig("ownerId");
}

// A custom field whose stored value is not JSON: the codec must refuse it
// and say which model and field.
class MapField extends BaoBaseField {
  toDy(value) {
    return value == null ? null : new Map(Object.entries(value));
  }
  fromDy(value) {
    return value instanceof Map ? Object.fromEntries(value) : value;
  }
}
class RemoteCustomField extends BaoModel {
  static modelPrefix = "rmcf";
  static fields = { id: UlidField({ autoAssign: true }), attrs: new MapField() };
  static primaryKey = PrimaryKeyConfig("id");
}

// A custom field with a JSON stored value passes through.
class UpperField extends BaoBaseField {
  toDy(value) {
    return value == null ? null : String(value).toUpperCase();
  }
}
class RemoteJsonCustom extends BaoModel {
  static modelPrefix = "rmjc";
  static fields = { id: UlidField({ autoAssign: true }), code: new UpperField() };
  static primaryKey = PrimaryKeyConfig("id");
}

const WHEN = Date.UTC(2026, 10, 7, 12, 30, 15, 123);
const EXPIRES_S = Math.floor(Date.UTC(2026, 11, 1) / 1000);

function sampleDy(overrides = {}) {
  return {
    id: "01JC0000000000000000000000",
    name: "row",
    when: WHEN,
    created: WHEN - 1000,
    modified: WHEN + 1000,
    owner: "01JC0000000000000000000001",
    count: 7,
    ratio: 0.25,
    views: 12,
    blob: Buffer.from([0, 1, 2, 250, 255]),
    version: "01JC0000000000000000000002",
    active: true,
    ttl: EXPIRES_S,
    tags: ["b", "a"],
    // System attributes the codec must not ship.
    _pk: "[t]#rmef#x",
    _sk: "rmef",
    _iter_pk: "whatever",
    ...overrides,
  };
}

let testId;
beforeAll(() => {
  testId = ulid();
  const manager = initTestModelsWithTenant(testConfig, testId);
  for (const M of [RemoteEveryField, RemoteOwner, RemoteCustomField, RemoteJsonCustom]) {
    manager.registerModel(M);
  }
});

afterAll(async () => {
  await cleanupTestDataByIteration(testId, [RemoteEveryField, RemoteOwner]);
  TenantContext.reset();
});

describe("encodeValue: model rows", () => {
  const encoded = () =>
    encodeValue(RemoteEveryField._createFromDyItem(sampleDy()));

  test("a model instance becomes { $model, data } with only declared fields", () => {
    const e = encoded();
    expect(e.$model).toBe("RemoteEveryField");
    expect(Object.keys(e.data).sort()).toEqual(
      Object.keys(RemoteEveryField.fields).sort(),
    );
    expect(e.data._pk).toBeUndefined();
  });

  test("the encoding survives JSON unchanged", () => {
    const e = encoded();
    expect(JSON.parse(JSON.stringify(e))).toEqual(e);
  });

  test.each([
    ["StringField", "name", "row"],
    ["UlidField", "id", "01JC0000000000000000000000"],
    ["RelatedField", "owner", "01JC0000000000000000000001"],
    ["IntegerField", "count", 7],
    ["FloatField", "ratio", 0.25],
    ["CounterField", "views", 12],
    ["VersionField", "version", "01JC0000000000000000000002"],
    ["BooleanField", "active", true],
  ])("%s passes through as JSON", (_type, field, wire) => {
    expect(encoded().data[field]).toEqual(wire);
  });

  test.each([
    ["DateTimeField", "when", WHEN],
    ["CreateDateField", "created", WHEN - 1000],
    ["ModifiedDateField", "modified", WHEN + 1000],
  ])("%s is epoch milliseconds", (_type, field, ms) => {
    expect(encoded().data[field]).toBe(ms);
  });

  test("TtlField is epoch milliseconds on the wire, though stored in seconds", () => {
    expect(encoded().data.ttl).toBe(EXPIRES_S * 1000);
  });

  test("BinaryField is base64 under $binary", () => {
    expect(encoded().data.blob).toEqual({
      $binary: Buffer.from([0, 1, 2, 250, 255]).toString("base64"),
    });
  });

  test("StringSetField is an array", () => {
    expect(encoded().data.tags).toEqual(["b", "a"]);
  });

  test("null fields stay null and absent fields stay absent", () => {
    const dy = sampleDy({ when: null, blob: null, tags: null, ttl: null });
    delete dy.name;
    const e = encodeValue(RemoteEveryField._createFromDyItem(dy));
    expect(e.data.when).toBeNull();
    expect(e.data.blob).toBeNull();
    expect(e.data.tags).toBeNull();
    expect(e.data.ttl).toBeNull();
    expect("name" in e.data).toBe(false);
  });

  test("a custom field with a JSON stored value passes through", () => {
    const row = RemoteJsonCustom._createFromDyItem({ id: "x", code: "ABC" });
    expect(encodeValue(row).data.code).toBe("ABC");
  });

  test("a custom field with a non-JSON stored value is refused, naming model and field", () => {
    const row = new RemoteCustomField({ attrs: { a: 1 } });
    expect(() => encodeValue(row)).toThrow(CodecError);
    expect(() => encodeValue(row)).toThrow(/RemoteCustomField\.attrs.*Map/);
  });

  test("rows nested in plain results are encoded in place", () => {
    const row = RemoteEveryField._createFromDyItem(sampleDy());
    const e = encodeValue({ rows: [row], next: null });
    expect(e.rows[0].$model).toBe("RemoteEveryField");
    expect(e.next).toBeNull();
  });

  test("ObjectNotFound encodes as null", () => {
    expect(encodeValue({ row: new ObjectNotFound({ CapacityUnits: 0.5 }) })).toEqual({
      row: null,
    });
  });

  test("models: 'refuse' rejects a model instance, for the plain-view rule", () => {
    const row = RemoteEveryField._createFromDyItem(sampleDy());
    expect(() => encodeValue({ row }, { models: "refuse" })).toThrow(
      /\$\.row.*RemoteEveryField.*encodeValue/,
    );
  });
});

describe("encodeValue: plain values", () => {
  test.each([
    null,
    true,
    0,
    -1.5,
    "s",
    [],
    {},
    { a: [1, { b: "c" }], d: null },
    Object.assign(Object.create(null), { a: 1 }),
  ])("accepts plain JSON %p", (value) => {
    expect(encodeValue(value)).toEqual(value);
  });

  test("drops undefined object members, as JSON does", () => {
    expect(encodeValue({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  test.each([
    ["a Date", { at: new Date() }, /\$\.at.*Date.*epoch milliseconds/],
    ["a Map", { m: new Map() }, /\$\.m.*Map/],
    ["a Set", { s: new Set(["a"]) }, /\$\.s.*Set/],
    ["a Buffer", { b: Buffer.from("x") }, /\$\.b.*Buffer/],
    ["a Uint8Array", [new Uint8Array(1)], /\$\[0\].*Uint8Array/],
    ["a class instance", { x: new (class Thing {})() }, /\$\.x.*Thing/],
    ["a function", { f: () => 1 }, /\$\.f.*function/],
    ["undefined in an array", [1, undefined], /\$\[1\].*undefined/],
    ["NaN", { n: NaN }, /\$\.n.*NaN/],
    ["Infinity", { n: Infinity }, /\$\.n.*Infinity/],
    ["a bigint", { n: 1n }, /\$\.n.*bigint/],
    ["a symbol", { s: Symbol("x") }, /\$\.s.*symbol/],
    ["an Error", { e: new Error("x") }, /\$\.e.*Error/],
  ])("refuses %s, naming its path", (_label, value, pattern) => {
    expect(() => encodeValue(value)).toThrow(CodecError);
    expect(() => encodeValue(value)).toThrow(pattern);
  });

  test("refuses a cycle", () => {
    const a = {};
    a.self = a;
    expect(() => encodeValue(a)).toThrow(/circular/);
  });

  test("a top-level undefined encodes as null", () => {
    expect(encodeValue(undefined)).toBeNull();
  });
});

describe("decodeRow", () => {
  const wire = () =>
    JSON.parse(JSON.stringify(encodeValue(RemoteEveryField._createFromDyItem(sampleDy()))));

  test("restores the stored representation of every field type", () => {
    const dy = decodeRow(RemoteEveryField, wire());
    const { _pk, _sk, _iter_pk, ...expected } = sampleDy();
    expect(dy).toEqual(expected);
    expect(Buffer.isBuffer(dy.blob)).toBe(true);
    expect(dy.ttl).toBe(EXPIRES_S);
  });

  test("refuses a row of another model", () => {
    expect(() => decodeRow(RemoteOwner, wire())).toThrow(/RemoteEveryField.*RemoteOwner/);
  });

  test.each([
    ["not an object", 5],
    ["no $model", { data: {} }],
    ["no data", { $model: "RemoteEveryField" }],
    ["data not an object", { $model: "RemoteEveryField", data: [] }],
  ])("refuses an encoded row that is %s", (_label, value) => {
    expect(() => decodeRow(RemoteEveryField, value)).toThrow(CodecError);
  });

  test.each([
    ["when", "2026-11-07", /when.*epoch milliseconds/],
    ["ttl", "soon", /ttl.*epoch milliseconds/],
    ["blob", "AAEC", /blob.*\$binary/],
    ["tags", "a", /tags.*array of strings/],
    ["tags", [1], /tags.*array of strings/],
  ])("refuses a malformed %s", (field, value, pattern) => {
    const w = wire();
    w.data[field] = value;
    expect(() => decodeRow(RemoteEveryField, w)).toThrow(pattern);
  });

  test("ignores fields the receiving model does not declare", () => {
    const w = wire();
    w.data.addedInANewerBundle = "x";
    expect(decodeRow(RemoteEveryField, w).addedInANewerBundle).toBeUndefined();
  });
});

describe("Model.fromRemote", () => {
  const wire = () =>
    JSON.parse(JSON.stringify(encodeValue(RemoteEveryField._createFromDyItem(sampleDy()))));

  test("hydrates an instance whose getters return the original JS values", () => {
    const row = RemoteEveryField.fromRemote(wire());
    expect(row).toBeInstanceOf(RemoteEveryField);
    expect(row.exists()).toBe(true);
    expect(row.isDetached()).toBe(true);
    expect(row.name).toBe("row");
    expect(row.when).toEqual(new Date(WHEN));
    expect(row.created).toEqual(new Date(WHEN - 1000));
    expect(row.modified).toEqual(new Date(WHEN + 1000));
    expect(row.ttl).toEqual(new Date(EXPIRES_S * 1000));
    expect(row.count).toBe(7);
    expect(row.ratio).toBe(0.25);
    expect(row.views).toBe(12);
    expect(row.active).toBe(true);
    expect(Buffer.from(row.blob)).toEqual(Buffer.from([0, 1, 2, 250, 255]));
    expect(row.tags).toBeInstanceOf(Set);
    expect([...row.tags].sort()).toEqual(["a", "b"]);
    expect(row.owner).toBe("01JC0000000000000000000001");
    expect(row.getPrimaryId()).toBe("01JC0000000000000000000000");
    expect(row.hasChanges()).toBe(false);
    expect(row.isLoaded()).toBe(true);
  });

  test("an instance loaded normally is not detached", () => {
    expect(RemoteEveryField._createFromDyItem(sampleDy()).isDetached()).toBe(false);
  });

  test.each(["save", "update", "delete", "loadRelatedData", "getOrLoadRelatedField"])(
    "%s throws on a detached instance, naming the procedure API",
    async (method) => {
      const row = RemoteEveryField.fromRemote(wire());
      const call = () => row[method]("owner");
      await expect(Promise.resolve().then(call)).rejects.toThrow(DetachedInstanceError);
      await expect(Promise.resolve().then(call)).rejects.toThrow(
        /RemoteEveryField.*detached.*procedure.*remote\(\.\.\.\)\.call/,
      );
    },
  );

  test("the detached guard does not shadow a field named update or delete", () => {
    class RemoteOddNames extends BaoModel {
      static modelPrefix = "rmon";
      static fields = {
        id: UlidField({ autoAssign: true }),
        update: StringField(),
        delete: StringField(),
      };
      static primaryKey = PrimaryKeyConfig("id");
    }
    const row = RemoteOddNames.fromRemote({
      $model: "RemoteOddNames",
      data: { id: "x", update: "u", delete: "d" },
    });
    expect(row.update).toBe("u");
    expect(row.delete).toBe("d");
    return expect(row.save()).rejects.toThrow(DetachedInstanceError);
  });

  test("guarded methods still work on a normal instance (no behavior change)", async () => {
    const row = RemoteEveryField._createFromDyItem(sampleDy({ owner: null }));
    await expect(row.loadRelatedData()).resolves.toBe(row);
    await expect(row.getOrLoadRelatedField("owner")).resolves.toBeNull();
    expect(row.update).toBeUndefined();
    expect(row.delete).toBeUndefined();
  });

  test("a detached instance is encodable again, e.g. to pass back as an argument", () => {
    const w = wire();
    expect(encodeValue(RemoteEveryField.fromRemote(w))).toEqual(w);
  });

  test("round trip through DynamoDB, JSON and fromRemote keeps every value", async () => {
    await TenantContext.runWithTenant(testId, () =>
      runWithBatchContext(async () => {
        const owner = await RemoteOwner.create({ label: "o" });
        const created = await RemoteEveryField.create({
          name: "stored",
          when: new Date(WHEN),
          owner: owner.ownerId,
          count: 3,
          ratio: 1.5,
          views: 2,
          blob: Buffer.from([9, 8, 7]),
          active: false,
          ttl: new Date(EXPIRES_S * 1000),
          tags: new Set(["x", "y"]),
        });
        const found = await RemoteEveryField.find(created.getPrimaryId(), {
          bypassCache: true,
        });
        const wireRow = JSON.parse(JSON.stringify(encodeValue(found)));
        const back = RemoteEveryField.fromRemote(wireRow);
        for (const f of Object.keys(RemoteEveryField.fields)) {
          if (f === "blob") {
            expect(Buffer.from(back.blob)).toEqual(Buffer.from(found.blob));
          } else if (f === "tags") {
            expect([...back.tags].sort()).toEqual([...found.tags].sort());
            expect([...back.tags].sort()).toEqual(["x", "y"]);
          } else {
            expect(back[f]).toEqual(found[f]);
          }
        }
      }),
    );
  });
});
