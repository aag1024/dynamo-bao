class ObjectNotFound {
    constructor(consumedCapacity) {
      this.consumedCapacity = consumedCapacity;
    }
  
    // Makes the object coerce to false in boolean contexts
    valueOf() {
      return false;
    }
  
    // Optional - for better debugging
    toString() {
      return `ObjectNotFound (consumed ${this.consumedCapacity} capacity units)`
    }

    getNumericConsumedCapacity(type, includeRelated = false) {
      if (this.consumedCapacity && type === 'read') {
        return this.consumedCapacity.CapacityUnits;
      }

      return 0;
    }
  }

  module.exports = {
    ObjectNotFound
  }