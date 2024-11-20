class ModelRegistry {
  static _instance = null;
  _models = new Map();

  static getInstance() {
    if (!ModelRegistry._instance) {
      ModelRegistry._instance = new ModelRegistry();
    }
    return ModelRegistry._instance;
  }

  register(modelClass) {
    this._models.set(modelClass.name, modelClass);
    return modelClass;
  }

  get(modelName) {
    const model = this._models.get(modelName);
    if (!model) {
      throw new Error(`Model ${modelName} not found in registry. Available models: ${Array.from(this._models.keys()).join(', ')}`);
    }
    return model;
  }

  // Helper method for debugging
  listModels() {
    return Array.from(this._models.keys());
  }
}

module.exports = { ModelRegistry }; 