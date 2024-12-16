// test/dynamoTestUtils.js
const { defaultLogger: logger } = require("../src/utils/logger");

function sumConsumedCapacity(capacityArray) {
  if (!capacityArray) return { ReadCapacityUnits: 0, WriteCapacityUnits: 0 };

  // Handle single capacity object
  if (!Array.isArray(capacityArray)) {
    return {
      ReadCapacityUnits: capacityArray.ReadCapacityUnits || 0,
      WriteCapacityUnits: capacityArray.WriteCapacityUnits || 0,
    };
  }

  // Sum up capacity from array
  return capacityArray.reduce(
    (total, current) => ({
      ReadCapacityUnits:
        (total.ReadCapacityUnits || 0) + (current.ReadCapacityUnits || 0),
      WriteCapacityUnits:
        (total.WriteCapacityUnits || 0) + (current.WriteCapacityUnits || 0),
    }),
    { ReadCapacityUnits: 0, WriteCapacityUnits: 0 },
  );
}

function printCapacityUsage(operation, rcu, wcu, duration) {
  logger.log(`\nOperation Capacity Usage:`);
  logger.log(`- Read Capacity Units (RCU): ${rcu || 0}`);
  logger.log(`- Write Capacity Units (WCU): ${wcu || 0}`);
  logger.log(`- Duration: ${duration}ms`);
}

async function verifyCapacityUsage(
  operation,
  expectedRCU,
  expectedWCU,
  allowance = 2.0,
) {
  const startTime = Date.now();
  const result = await operation();
  const duration = Date.now() - startTime;

  // Calculate total capacity from raw DynamoDB response
  // This is an item model
  let writeCapacity, readCapacity;
  if (result.getNumericConsumedCapacity) {
    // const totalCapacity = result.getNumericConsumedCapacity('total', true);
    writeCapacity = result.getNumericConsumedCapacity("write", true);
    readCapacity = result.getNumericConsumedCapacity("read", true);
  } else {
    // This is a query model
    readCapacity = result.consumedCapacity.CapacityUnits;
    readCapacity += result.items.reduce(
      (sum, item) => sum + (item.getNumericConsumedCapacity("read", true) || 0),
      0,
    );
  }

  printCapacityUsage(
    operation.name || "Operation",
    readCapacity,
    writeCapacity,
    duration,
  );

  const rcuWithinRange =
    Math.abs((readCapacity || 0) - expectedRCU) <= allowance;
  const wcuWithinRange =
    Math.abs((writeCapacity || 0) - expectedWCU) <= allowance;

  if (!rcuWithinRange || !wcuWithinRange) {
    logger.log("Actual capacity:", totalCapacity);
    logger.log("Expected RCU:", expectedRCU, "WCU:", expectedWCU);
    throw new Error(
      `Unexpected capacity usage!\n` +
        `RCU: Expected ~${expectedRCU}, got ${readCapacity}\n` +
        `WCU: Expected ~${expectedWCU}, got ${writeCapacity}`,
    );
  }

  return result;
}

module.exports = {
  verifyCapacityUsage,
  sumConsumedCapacity,
  printCapacityUsage,
};
