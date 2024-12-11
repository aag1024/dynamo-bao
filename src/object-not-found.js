class ObjectNotFound {
    constructor(consumedCapacity) {
      this.consumedCapacity = consumedCapacity;
    }

    exists() {
      return false;
    }

    toString() {
      return `ObjectNotFound (consumed ${this.consumedCapacity} capacity units)`;
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