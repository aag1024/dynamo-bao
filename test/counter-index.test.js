const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext } = dynamoBao;
const testConfig = require("./config");
const {
  BaoModel,
  PrimaryKeyConfig,
  IndexConfig,
  UniqueConstraintConfig,
} = require("../src/model");
const { StringField, CounterField, UlidField } = require("../src/fields");
const { ConditionalError } = require("../src/exceptions");
const {
  cleanupTestDataByIteration,
  verifyCleanup,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");
const { GSI_INDEX_ID1, UNIQUE_CONSTRAINT_ID1 } = require("../src/constants");

let testId;

// `score` is a GSI sort key; `views` is a plain counter.
class Player extends BaoModel {
  static modelPrefix = "ply";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    playerId: UlidField({ autoAssign: true }),
    league: StringField({ required: true }),
    handle: StringField(),
    score: CounterField(),
    views: CounterField(),
  };
  static primaryKey = PrimaryKeyConfig("playerId");
  static indexes = {
    byLeagueScore: IndexConfig("league", "score", GSI_INDEX_ID1),
  };
  static uniqueConstraints = {
    uniqueHandle: UniqueConstraintConfig("handle", UNIQUE_CONSTRAINT_ID1),
  };
}

const scoreKey = (value) => Player._getField("score").toGsi(value);

const readStored = (player) =>
  Player.find(player.playerId, { batchDelay: 0, bypassCache: true });

describe("Relative counters in index keys", () => {
  beforeEach(async () => {
    await runWithBatchContext(async () => {
      testId = ulid();
      const manager = initTestModelsWithTenant(testConfig, testId);
      manager.registerModel(Player);
    });
  });

  afterEach(async () => {
    await runWithBatchContext(async () => {
      TenantContext.clearTenant();
      if (testId) {
        await cleanupTestDataByIteration(testId, [Player]);
        await verifyCleanup(testId, [Player]);
      }
    });
  });

  test("create stores the number in the counter and the index key", async () => {
    await runWithBatchContext(async () => {
      const player = await Player.create({ league: "gold", score: "+3" });

      const stored = await readStored(player);
      expect(stored._dyData.score).toBe(3);
      expect(stored._dyData._gsi1_sk).toBe(scoreKey(3));
      expect(player._dyData).toEqual(stored._dyData);
    });
  });

  test("create through the unique-constraint transaction does the same", async () => {
    await runWithBatchContext(async () => {
      const player = await Player.create({
        league: "gold",
        handle: "ace",
        score: "+3",
      });

      const stored = await readStored(player);
      expect(stored._dyData.score).toBe(3);
      expect(stored._dyData._gsi1_sk).toBe(scoreKey(3));
      expect(player._dyData).toEqual(stored._dyData);
    });
  });

  test("update writes the new total to the counter and the index key", async () => {
    await runWithBatchContext(async () => {
      const player = await Player.create({ league: "gold", score: 5 });

      const updated = await Player.update(player.playerId, { score: "+2" });
      expect(updated.score).toBe(7);

      const stored = await readStored(player);
      expect(stored._dyData.score).toBe(7);
      expect(stored._dyData._gsi1_sk).toBe(scoreKey(7));

      const ranked = await Player.queryByIndex("byLeagueScore", "gold");
      expect(ranked.items.map((p) => p.score)).toEqual([7]);
    });
  });

  test("update of a counter that was never set starts from zero", async () => {
    await runWithBatchContext(async () => {
      const player = await Player.create({ league: "gold" });

      await Player.update(player.playerId, { score: "-4" });

      const stored = await readStored(player);
      expect(stored._dyData.score).toBe(-4);
      expect(stored._dyData._gsi1_sk).toBe(scoreKey(-4));
    });
  });

  test("a concurrent change to the counter fails the update instead of staling the index", async () => {
    const player = await runWithBatchContext(() =>
      Player.create({ league: "gold", score: 5 }),
    );

    await runWithBatchContext(async () => {
      // Load the row (score 5), then change it from another request.
      const loaded = await Player.find(player.playerId);
      await runWithBatchContext(() =>
        Player.update(player.playerId, { score: 10 }),
      );

      // Pass the stale row the way save() does (instance saves send absolute
      // values, so call update() to send a relative one).
      await expect(
        Player.update(
          player.playerId,
          { score: "+2" },
          { instanceObj: loaded },
        ),
      ).rejects.toThrow(ConditionalError);
    });

    await runWithBatchContext(async () => {
      const stored = await readStored(player);
      expect(stored._dyData.score).toBe(10);
      expect(stored._dyData._gsi1_sk).toBe(scoreKey(10));
    });
  });

  test("a counter outside any index keeps the atomic ADD", async () => {
    const player = await runWithBatchContext(() =>
      Player.create({ league: "gold", views: 1 }),
    );

    await runWithBatchContext(async () => {
      // A stale loaded value doesn't matter: ADD applies to the stored total.
      const loaded = await Player.find(player.playerId);
      await runWithBatchContext(() =>
        Player.update(player.playerId, { views: "+10" }),
      );

      const saved = await Player.update(
        player.playerId,
        { views: "+1" },
        { instanceObj: loaded },
      );
      expect(saved.views).toBe(12);
    });
  });
});
