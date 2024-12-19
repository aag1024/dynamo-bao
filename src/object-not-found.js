class ObjectNotFound {
  /**
   * @constructor
   * @param {Object} consumedCapacity - The consumed capacity for the operation.
   */
  constructor(consumedCapacity) {
    this.consumedCapacity = consumedCapacity;
  }

  /**
   * @memberof ObjectNotFound
   * @description
   * Returns false, since the object was not found.
   * @returns {boolean} False.
   */
  exists() {
    return false;
  }

  toString() {
    return `ObjectNotFound (consumed ${this.consumedCapacity} capacity units)`;
  }

  /**
   * @memberof ObjectNotFound
   * @description
   * Returns the numeric consumed capacity for the operation. For compatibility this
   * method supports an includeRelated parameter, but it is ignored, since there are
   * no related objects to consider.
   * @param {string} type - The type of operation.
   * @param {boolean} [includeRelated=false] - Whether to include related capacity.
   * @returns {number} The numeric consumed capacity.
   */
  getNumericConsumedCapacity(type, includeRelated = false) {
    if (this.consumedCapacity && type === "read") {
      return this.consumedCapacity.CapacityUnits;
    }
    return 0;
  }
}

module.exports = {
  ObjectNotFound,
};
