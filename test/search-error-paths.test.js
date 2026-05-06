// Targeted tests for two error paths that were silently broken in earlier
// drafts of the searchable feature:
//   1) The "missing iter_search_index → friendly error" translation in
//      _iterateSingleBucket. The original regex (/index.*not.*found/i)
//      didn't match the actual DynamoDB error and the catch block was dead
//      code.
//   2) The model-registration check that fails loudly when a class has
//      `searchable: true` but no `searchConfig`. Previously this silently
//      skipped _searchText computation on every save.

const dynamoBao = require("../src");
const testConfig = require("./config");
const { initTestModelsWithTenant } = require("./utils/test-utils");
const { ulid } = require("ulid");
const { ConfigurationError } = require("../src/exceptions");

describe("missing iter_search_index → friendly error", () => {
  let testId, ModelClass, manager;

  class IterableForMissingIndex extends dynamoBao.BaoModel {
    static modelPrefix = "mix";
    static iterable = true;
    static iterationBuckets = 1;
    static fields = {
      id: dynamoBao.fields.UlidField({ autoAssign: true, required: true }),
      title: dynamoBao.fields.StringField(),
    };
    static primaryKey = dynamoBao.PrimaryKeyConfig("id", "modelPrefix");
  }

  beforeEach(() => {
    testId = ulid();
    manager = initTestModelsWithTenant(testConfig, testId);
    manager.registerModel(IterableForMissingIndex);
    ModelClass = manager.getModel("IterableForMissingIndex");
  });

  test("translates the real DynamoDB ValidationException message", async () => {
    // Stub documentClient.send to throw the actual message format DynamoDB
    // returns when an index isn't on the table. This is the message that
    // tripped up the original regex.
    const realSend = ModelClass.documentClient.send.bind(
      ModelClass.documentClient,
    );
    ModelClass.documentClient.send = async () => {
      const err = new Error(
        "The table does not have the specified index: iter_search_index",
      );
      err.name = "ValidationException";
      throw err;
    };

    try {
      await expect(async () => {
        for await (const _ of ModelClass.iterateAll()) {
          // unreachable
        }
      }).rejects.toThrow(
        /Index 'iter_search_index' is missing on table.*Run 'bao-update-table'/i,
      );
    } finally {
      ModelClass.documentClient.send = realSend;
    }
  });

  test("translates ResourceNotFoundException only if message mentions an index", async () => {
    const realSend = ModelClass.documentClient.send.bind(
      ModelClass.documentClient,
    );
    ModelClass.documentClient.send = async () => {
      const err = new Error("Requested index not found");
      err.name = "ResourceNotFoundException";
      throw err;
    };

    try {
      await expect(async () => {
        for await (const _ of ModelClass.iterateAll()) {
          // unreachable
        }
      }).rejects.toThrow(/Index 'iter_search_index' is missing/i);
    } finally {
      ModelClass.documentClient.send = realSend;
    }
  });

  test("does NOT translate ResourceNotFoundException for missing table (no 'index' in message)", async () => {
    // Critical: a missing-table error must surface as-is, not get masked as a
    // missing-index error with the wrong remediation.
    const realSend = ModelClass.documentClient.send.bind(
      ModelClass.documentClient,
    );
    ModelClass.documentClient.send = async () => {
      const err = new Error("Cannot do operations on a non-existent table");
      err.name = "ResourceNotFoundException";
      throw err;
    };

    try {
      await expect(async () => {
        for await (const _ of ModelClass.iterateAll()) {
          // unreachable
        }
      }).rejects.toThrow(/non-existent table/i);
    } finally {
      ModelClass.documentClient.send = realSend;
    }
  });

  test("does not translate unrelated errors", async () => {
    const realSend = ModelClass.documentClient.send.bind(
      ModelClass.documentClient,
    );
    ModelClass.documentClient.send = async () => {
      const err = new Error("Some other unrelated DynamoDB error");
      err.name = "InternalServerError";
      throw err;
    };

    try {
      await expect(async () => {
        for await (const _ of ModelClass.iterateAll()) {
          // unreachable
        }
      }).rejects.toThrow(/Some other unrelated DynamoDB error/i);
    } finally {
      ModelClass.documentClient.send = realSend;
    }
  });
});

describe("filter on non-projected attribute → friendly error before round-trip", () => {
  let testId, ModelClass;

  class IterableForFilterCheck extends dynamoBao.BaoModel {
    static modelPrefix = "ifc";
    static iterable = true;
    static iterationBuckets = 1;
    static searchable = true;
    static searchConfig = {
      fields: ["title"],
      caseSensitive: false,
      minTermLength: 1,
      dedupe: false,
    };
    static fields = {
      id: dynamoBao.fields.UlidField({ autoAssign: true, required: true }),
      title: dynamoBao.fields.StringField(),
      status: dynamoBao.fields.StringField(),
    };
    static primaryKey = dynamoBao.PrimaryKeyConfig("id", "modelPrefix");
  }

  beforeEach(() => {
    testId = ulid();
    const manager = initTestModelsWithTenant(testConfig, testId);
    manager.registerModel(IterableForFilterCheck);
    ModelClass = manager.getModel("IterableForFilterCheck");
  });

  test("iterateAll throws clear error before hitting DynamoDB", async () => {
    const sendCalls = [];
    const realSend = ModelClass.documentClient.send.bind(
      ModelClass.documentClient,
    );
    ModelClass.documentClient.send = async (cmd) => {
      sendCalls.push(cmd);
      return realSend(cmd);
    };

    try {
      await expect(async () => {
        for await (const _ of ModelClass.iterateAll({
          filter: { status: "active" },
        })) {
          // unreachable
        }
      }).rejects.toThrow(
        /references attribute\(s\) that aren't projected.*\[status\]/i,
      );
      // Confirm the failure happened pre-flight, no Query was issued.
      expect(sendCalls.length).toBe(0);
    } finally {
      ModelClass.documentClient.send = realSend;
    }
  });

  test("searchAll throws clear error before hitting DynamoDB", async () => {
    const sendCalls = [];
    const realSend = ModelClass.documentClient.send.bind(
      ModelClass.documentClient,
    );
    ModelClass.documentClient.send = async (cmd) => {
      sendCalls.push(cmd);
      return realSend(cmd);
    };

    try {
      await expect(async () => {
        for await (const _ of ModelClass.searchAll(["foo"], {
          filter: { status: "active" },
        })) {
          // unreachable
        }
      }).rejects.toThrow(/aren't projected.*\[status\]/i);
      expect(sendCalls.length).toBe(0);
    } finally {
      ModelClass.documentClient.send = realSend;
    }
  });

  test("error message lists every offending attribute", async () => {
    await expect(async () => {
      for await (const _ of ModelClass.iterateAll({
        filter: { status: "active", title: "x" },
      })) {
        // unreachable — title is also not in the iter_search_index projection
      }
    }).rejects.toThrow(/\[(?:status, title|title, status)\]/);
  });

  test("preflight unit-test on the allowlist directly", () => {
    // Direct unit test of _assertFilterFitsIterSearchIndex so we can confirm
    // each projected attribute is allowed without going through the user-facing
    // filter API (FilterExpressionBuilder's own validation rejects raw system
    // field names — that's tracked as a separate enhancement).
    expect(() =>
      ModelClass._assertFilterFitsIterSearchIndex({ "#n1": "_searchText" }),
    ).not.toThrow();
    expect(() =>
      ModelClass._assertFilterFitsIterSearchIndex({
        "#n1": "_pk",
        "#n2": "_sk",
        "#n3": "_iter_pk",
        "#n4": "_iter_sk",
      }),
    ).not.toThrow();
    expect(() =>
      ModelClass._assertFilterFitsIterSearchIndex({ "#n1": "title" }),
    ).toThrow(/aren't projected.*\[title\]/i);
  });
});

describe("searchable: true but searchConfig missing → registration fails", () => {
  test("registering a model with searchable=true and searchConfig=null throws", () => {
    class BrokenSearchable extends dynamoBao.BaoModel {
      static modelPrefix = "bsr";
      static iterable = true;
      static iterationBuckets = 1;
      static searchable = true;
      static searchConfig = null;
      static fields = {
        id: dynamoBao.fields.UlidField({ autoAssign: true, required: true }),
        title: dynamoBao.fields.StringField(),
      };
      static primaryKey = dynamoBao.PrimaryKeyConfig("id", "modelPrefix");
    }

    const testId = ulid();
    const manager = initTestModelsWithTenant(testConfig, testId);

    expect(() => manager.registerModel(BrokenSearchable)).toThrow(
      ConfigurationError,
    );
    expect(() => manager.registerModel(BrokenSearchable)).toThrow(
      /searchable: true.*no `searchConfig`/i,
    );
  });

  test("registering with searchConfig.fields empty throws", () => {
    class EmptyFields extends dynamoBao.BaoModel {
      static modelPrefix = "eft";
      static iterable = true;
      static iterationBuckets = 1;
      static searchable = true;
      static searchConfig = { fields: [] };
      static fields = {
        id: dynamoBao.fields.UlidField({ autoAssign: true, required: true }),
        title: dynamoBao.fields.StringField(),
      };
      static primaryKey = dynamoBao.PrimaryKeyConfig("id", "modelPrefix");
    }

    const testId = ulid();
    const manager = initTestModelsWithTenant(testConfig, testId);

    expect(() => manager.registerModel(EmptyFields)).toThrow(
      /searchConfig\.fields.*non-empty array/i,
    );
  });

  test("registering with searchConfig referencing a non-existent field throws", () => {
    class BadFieldRef extends dynamoBao.BaoModel {
      static modelPrefix = "bfr";
      static iterable = true;
      static iterationBuckets = 1;
      static searchable = true;
      static searchConfig = { fields: ["nope"] };
      static fields = {
        id: dynamoBao.fields.UlidField({ autoAssign: true, required: true }),
        title: dynamoBao.fields.StringField(),
      };
      static primaryKey = dynamoBao.PrimaryKeyConfig("id", "modelPrefix");
    }

    const testId = ulid();
    const manager = initTestModelsWithTenant(testConfig, testId);

    expect(() => manager.registerModel(BadFieldRef)).toThrow(
      /references "nope".*not defined/i,
    );
  });

  test("registering with searchable=false succeeds even with no searchConfig", () => {
    class FineNonSearchable extends dynamoBao.BaoModel {
      static modelPrefix = "fns";
      static iterable = true;
      static iterationBuckets = 1;
      static searchable = false;
      static searchConfig = null;
      static fields = {
        id: dynamoBao.fields.UlidField({ autoAssign: true, required: true }),
        title: dynamoBao.fields.StringField(),
      };
      static primaryKey = dynamoBao.PrimaryKeyConfig("id", "modelPrefix");
    }

    const testId = ulid();
    const manager = initTestModelsWithTenant(testConfig, testId);

    expect(() => manager.registerModel(FineNonSearchable)).not.toThrow();
  });
});
