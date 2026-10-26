const dynamoBao = require("../src");
const { TenantContext, runWithBatchContext, getBatchContextCapacity } =
  dynamoBao;
const testConfig = require("./config");
const { BaoModel, PrimaryKeyConfig } = require("../src/model");
const { StringField } = require("../src/fields");
const {
  cleanupTestDataByIteration,
  initTestModelsWithTenant,
} = require("./utils/test-utils");
const { ulid } = require("ulid");

class CacheItemA extends BaoModel {
  static modelPrefix = "lca";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    id: StringField({ required: true }),
    label: StringField(),
  };
  static primaryKey = PrimaryKeyConfig("id");
}

class CacheItemB extends BaoModel {
  static modelPrefix = "lcb";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    id: StringField({ required: true }),
    label: StringField(),
  };
  static primaryKey = PrimaryKeyConfig("id");
}

class CacheComposite extends BaoModel {
  static modelPrefix = "lcc";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    app: StringField({ required: true }),
    name: StringField({ required: true }),
    label: StringField(),
  };
  static primaryKey = PrimaryKeyConfig("app", "name");
}

const MODELS = [CacheItemA, CacheItemB, CacheComposite];
let tenant1, tenant2;

// Record the DynamoDB commands sent while fn runs.
const recordCommands = async (fn) => {
  const commands = [];
  const client = CacheItemA.documentClient;
  const send = client.send.bind(client);
  const spy = jest.spyOn(client, "send").mockImplementation((command) => {
    commands.push(command.constructor.name);
    return send(command);
  });
  try {
    const result = await fn();
    return { result, commands };
  } finally {
    spy.mockRestore();
  }
};

describe("Loader cache", () => {
  beforeEach(() => {
    tenant1 = ulid();
    tenant2 = ulid();
    for (const tenantId of [tenant1, tenant2]) {
      const manager = initTestModelsWithTenant(testConfig, tenantId);
      MODELS.forEach((Model) => manager.registerModel(Model));
    }
  });

  afterEach(async () => {
    for (const tenantId of [tenant1, tenant2]) {
      await runWithBatchContext(() =>
        TenantContext.runWithTenant(tenantId, () =>
          cleanupTestDataByIteration(tenantId, MODELS),
        ),
      );
    }
    TenantContext.clearTenant();
  });

  test("bypassCache reads the table even with the default batch delay", async () => {
    await runWithBatchContext(() =>
      TenantContext.runWithTenant(tenant1, async () => {
        await CacheItemA.create({ id: "item", label: "v1" });

        const { commands } = await recordCommands(() =>
          CacheItemA.find("item", { bypassCache: true }),
        );
        expect(commands).toEqual(["GetCommand"]);
      }),
    );
  });

  test("the same id in another model is not served from the cache", async () => {
    await runWithBatchContext(() =>
      TenantContext.runWithTenant(tenant1, async () => {
        await CacheItemA.create({ id: "same", label: "A row" });

        const found = await CacheItemB.find("same");
        expect(found.exists()).toBe(false);
      }),
    );
  });

  test("the same id in another tenant is not served from the cache", async () => {
    await runWithBatchContext(async () => {
      await TenantContext.runWithTenant(tenant1, () =>
        CacheItemA.create({ id: "shared", label: "tenant1 row" }),
      );

      const found = await TenantContext.runWithTenant(tenant2, () =>
        CacheItemA.find("shared"),
      );
      expect(found.exists()).toBe(false);
    });
  });

  test("concurrent finds in different tenants are not batched together", async () => {
    await runWithBatchContext(() =>
      TenantContext.runWithTenant(tenant1, () =>
        CacheItemA.create({ id: "only-t1", label: "t1" }),
      ),
    );
    await runWithBatchContext(() =>
      TenantContext.runWithTenant(tenant2, () =>
        CacheItemA.create({ id: "only-t2", label: "t2" }),
      ),
    );

    await runWithBatchContext(async () => {
      const [t1Own, t2Other, t2Own] = await Promise.all([
        TenantContext.runWithTenant(tenant1, () => CacheItemA.find("only-t1")),
        TenantContext.runWithTenant(tenant2, () => CacheItemA.find("only-t1")),
        TenantContext.runWithTenant(tenant2, () => CacheItemA.find("only-t2")),
      ]);
      expect(t1Own.exists()).toBe(true);
      expect(t2Other.exists()).toBe(false);
      expect(t2Own.exists()).toBe(true);
      expect(t2Own.label).toBe("t2");
    });
  });

  test("string and object ids share one cache entry", async () => {
    await runWithBatchContext(() =>
      TenantContext.runWithTenant(tenant1, async () => {
        const item = await CacheComposite.create({
          app: "a",
          name: "n",
          label: "v1",
        });

        const { result: byObject, commands } = await recordCommands(() =>
          CacheComposite.find({ app: "a", name: "n" }),
        );
        expect(commands).toEqual([]);
        expect(byObject.label).toBe("v1");

        await CacheComposite.delete({ app: "a", name: "n" });
        const byString = await CacheComposite.find(item.getPrimaryId());
        expect(byString.exists()).toBe(false);
      }),
    );
  });

  test("repeated updates report only their own capacity", async () => {
    await runWithBatchContext(() =>
      TenantContext.runWithTenant(tenant1, async () => {
        let unitsSent = 0;
        const client = CacheItemA.documentClient;
        const send = client.send.bind(client);
        const spy = jest
          .spyOn(client, "send")
          .mockImplementation(async (command) => {
            const response = await send(command);
            unitsSent += response?.ConsumedCapacity?.CapacityUnits || 0;
            return response;
          });

        try {
          await CacheItemA.create({ id: "counted", label: "v0" });
          const perUpdate = [];
          for (let i = 1; i <= 3; i++) {
            const updated = await CacheItemA.update("counted", {
              label: `v${i}`,
            });
            perUpdate.push(updated.getNumericConsumedCapacity("total"));
          }

          expect(new Set(perUpdate).size).toBe(1);
          const context = getBatchContextCapacity();
          expect(context.read + context.write).toBe(unitsSent);
        } finally {
          spy.mockRestore();
        }
      }),
    );
  });
});
