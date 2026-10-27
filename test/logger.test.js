const { Logger } = require("../src/utils/logger");

describe("Logger level checks", () => {
  function at(level) {
    const logger = new Logger("test");
    logger.currentLevel = level;
    return logger;
  }

  test("isLevelEnabled follows the configured level", () => {
    const debug = at("DEBUG");
    expect(debug.isDebugEnabled()).toBe(true);
    expect(debug.isLevelEnabled("ERROR")).toBe(true);

    const error = at("ERROR");
    expect(error.isDebugEnabled()).toBe(false);
    expect(error.isLevelEnabled("WARN")).toBe(false);
    expect(error.isLevelEnabled("ERROR")).toBe(true);

    const off = at("OFF");
    expect(off.isLevelEnabled("ERROR")).toBe(false);
    expect(off.isDebugEnabled()).toBe(false);
  });

  test("an unknown level is never enabled", () => {
    // Guards against passing a message where the level goes.
    expect(at("DEBUG").isLevelEnabled("DynamoDB Query Params:")).toBe(false);
  });

  test("log prints only at or above the configured level", () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      const logger = at("WARN");
      logger.debug("hidden");
      logger.warn("shown");
      logger.error("shown too");
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[0][0]).toBe("[WARN] test:");
    } finally {
      spy.mockRestore();
    }
  });
});
