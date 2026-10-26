const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const { BaoModel, PrimaryKeyConfig } = require("../src/model");
const { StringField, DateTimeField, UlidField } = require("../src/fields");
const { ValidationError } = require("../src/exceptions");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");

let testId;

class Event extends BaoModel {
  static modelPrefix = "evt";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    eventId: UlidField({ autoAssign: true }),
    name: StringField({ required: true }),
    startsAt: DateTimeField(),
  };
  static primaryKey = PrimaryKeyConfig("eventId");
}

describe("DateTimeField", () => {
  beforeEach(async () => {
    await runWithBatchContext(async () => {
      testId = ulid();
      const manager = initTestModelsWithTenant(testConfig, testId);
      manager.registerModel(Event);
    });
  });

  afterEach(async () => {
    await runWithBatchContext(async () => {
      TenantContext.clearTenant();
      if (testId) {
        await cleanupTestDataByIteration(testId, [Event]);
        await verifyCleanup(testId, [Event]);
      }
    });
  });

  test("save() on a new instance leaves an unset field absent", async () => {
    await runWithBatchContext(async () => {
      const event = await new Event({ name: "Launch" }).save();

      const stored = await Event.find(event.eventId, {
        batchDelay: 0,
        bypassCache: true,
      });
      expect(stored.name).toBe("Launch");
      expect(stored._dyData.startsAt).toBeUndefined();
    });
  });

  test("update with null clears the field", async () => {
    await runWithBatchContext(async () => {
      const event = await Event.create({
        name: "Launch",
        startsAt: new Date("2026-11-01T00:00:00Z"),
      });

      const updated = await Event.update(event.eventId, { startsAt: null });
      expect(updated.startsAt).toBeNull();
      expect(updated._dyData.startsAt).toBeUndefined();
    });
  });

  test("still rejects a value of the wrong type", () => {
    expect(() => Event._getField("startsAt").validate({})).toThrow(
      ValidationError,
    );
  });

  test("a required field still rejects null", () => {
    expect(() => DateTimeField({ required: true }).validate(null)).toThrow(
      "Field is required",
    );
  });
});
