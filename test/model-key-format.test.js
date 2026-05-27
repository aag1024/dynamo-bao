const { BaoModel, PrimaryKeyConfig } = require("../src/model");
const { StringField } = require("../src/fields");
const { ModelManager } = require("../src/model-manager");
const { TenantContext } = require("../src/tenant-context");

class ModelPrefixPartitionItem extends BaoModel {
  static modelPrefix = "mppi";

  static fields = {
    name: StringField({ required: true }),
  };

  static primaryKey = PrimaryKeyConfig("modelPrefix", "name");
}

describe("Model key formatting", () => {
  afterEach(() => {
    TenantContext.clearTenant();
    TenantContext.reset();
  });

  test("tenant-prefixes base-table partition keys when pk is modelPrefix", () => {
    const tenant1 = "tenant-one";
    const tenant2 = "tenant-two";

    ModelManager.getInstance(tenant1).registerModel(ModelPrefixPartitionItem);
    expect(
      ModelPrefixPartitionItem._getDyKeyForPkSk({
        pk: ModelPrefixPartitionItem.modelPrefix,
        sk: "shared-name",
      }),
    ).toEqual({
      _pk: `[${tenant1}]#${ModelPrefixPartitionItem.modelPrefix}#${ModelPrefixPartitionItem.modelPrefix}`,
      _sk: "shared-name",
    });

    ModelManager.getInstance(tenant2).registerModel(ModelPrefixPartitionItem);
    expect(
      ModelPrefixPartitionItem._getDyKeyForPkSk({
        pk: ModelPrefixPartitionItem.modelPrefix,
        sk: "shared-name",
      }),
    ).toEqual({
      _pk: `[${tenant2}]#${ModelPrefixPartitionItem.modelPrefix}#${ModelPrefixPartitionItem.modelPrefix}`,
      _sk: "shared-name",
    });
  });
});
