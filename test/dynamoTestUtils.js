// test/dynamoTestUtils.js
const { defaultLogger: logger } = require('../src/utils/logger');

function extractCapacityUnits(capacity) {
    if (!capacity) return { read: 0, write: 0 };
  
    // Extract read/write units
    const readUnits = capacity.ReadCapacityUnits || 0;
    const writeUnits = capacity.WriteCapacityUnits || 0;
  
    // If we have specific read/write units, return those
    if (readUnits || writeUnits) {
      return { read: readUnits, write: writeUnits };
    }
  
    // Otherwise, assume it's a general capacity unit
    // If no specific read/write units are specified, 
    // assume it's a read operation if less than 1 unit (consistent reads are 0.5)
    // and a write operation if 1 or more units
    const units = capacity.CapacityUnits || 0;
    return units < 1 
      ? { read: units, write: 0 }
      : { read: 0, write: units };
  }
  
  function sumConsumedCapacity(capacityArray) {
    if (!capacityArray) return { ReadCapacityUnits: 0, WriteCapacityUnits: 0 };
    
    // Handle single capacity object
    if (!Array.isArray(capacityArray)) {
      return {
        ReadCapacityUnits: capacityArray.ReadCapacityUnits || 0,
        WriteCapacityUnits: capacityArray.WriteCapacityUnits || 0
      };
    }
  
    // Sum up capacity from array
    return capacityArray.reduce((total, current) => ({
      ReadCapacityUnits: (total.ReadCapacityUnits || 0) + (current.ReadCapacityUnits || 0),
      WriteCapacityUnits: (total.WriteCapacityUnits || 0) + (current.WriteCapacityUnits || 0)
    }), { ReadCapacityUnits: 0, WriteCapacityUnits: 0 });
  }
  
  function printCapacityUsage(operation, capacity, duration) {
    logger.log(`\nOperation Capacity Usage:`);
    logger.log(`- Read Capacity Units (RCU): ${capacity.ReadCapacityUnits || 0}`);
    logger.log(`- Write Capacity Units (WCU): ${capacity.WriteCapacityUnits || 0}`);
    logger.log(`- Duration: ${duration}ms`);
  }
  
  async function verifyCapacityUsage(operation, expectedRCU, expectedWCU, allowance = 2.0) {
    const startTime = Date.now();
    const result = await operation();
    const duration = Date.now() - startTime;
  
    // Get raw DynamoDB response from _response
    const dbResponse = result._response || {};
    
    // Calculate total capacity from raw DynamoDB response
    const totalCapacity = sumConsumedCapacity(dbResponse.ConsumedCapacity);
    
    printCapacityUsage(operation.name || 'Operation', totalCapacity, duration);
  
    const rcuWithinRange = Math.abs((totalCapacity.ReadCapacityUnits || 0) - expectedRCU) <= allowance;
    const wcuWithinRange = Math.abs((totalCapacity.WriteCapacityUnits || 0) - expectedWCU) <= allowance;
  
    if (!rcuWithinRange || !wcuWithinRange) {
      logger.log('Actual capacity:', totalCapacity);
      logger.log('Expected RCU:', expectedRCU, 'WCU:', expectedWCU);
      throw new Error(
        `Unexpected capacity usage!\n` +
        `RCU: Expected ~${expectedRCU}, got ${totalCapacity.ReadCapacityUnits || 0}\n` +
        `WCU: Expected ~${expectedWCU}, got ${totalCapacity.WriteCapacityUnits || 0}`
      );
    }
  
    return result;
  }
  
  module.exports = {
    verifyCapacityUsage,
    sumConsumedCapacity,
    printCapacityUsage
  };