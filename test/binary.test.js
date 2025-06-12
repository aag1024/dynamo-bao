const dynamoBao = require("../src");
const { TenantContext } = dynamoBao;
const testConfig = require("./config");
const { BaoModel, PrimaryKeyConfig } = require("../src/model");
const { StringField, BinaryField } = require("../src/fields");
const { cleanupTestDataByIteration, verifyCleanup, initTestModelsWithTenant } = require("./utils/test-utils");
const { ulid } = require("ulid");
const { ValidationError } = require("../src/exceptions");

let testId;

class TestBinary extends BaoModel {
  static modelPrefix = "tb";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    binaryId: StringField({ required: true }),
    name: StringField(),
    data: BinaryField(),
    requiredData: BinaryField({ required: true }),
  };

  static primaryKey = PrimaryKeyConfig("binaryId");
}

describe("Binary Field Tests", () => {
  let testBinary;

  beforeEach(async () => {
    testId = ulid();

    const manager = initTestModelsWithTenant(testConfig, testId);

    manager.registerModel(TestBinary);

    if (testId) {
      await cleanupTestDataByIteration(testId, [TestBinary]);
      await verifyCleanup(testId, [TestBinary]);
    }

    // Create a test instance with sample binary data
    testBinary = await TestBinary.create({
      binaryId: `test-binary-${Date.now()}`,
      name: "Test Binary",
      data: Buffer.from("Hello World"),
      requiredData: Buffer.from("Required Data"),
    });
  });

  afterEach(async () => {
    TenantContext.clearTenant();
    if (testId) {
      await cleanupTestDataByIteration(testId, [TestBinary]);
      await verifyCleanup(testId, [TestBinary]);
    }
  });

  test("should store Buffer and retrieve as Uint8Array", async () => {
    const fetchedBinary = await TestBinary.find(testBinary.binaryId);

    expect(fetchedBinary.data instanceof Uint8Array).toBe(true);
    expect(Buffer.from(fetchedBinary.data).toString()).toBe("Hello World");
    expect(Buffer.from(fetchedBinary.requiredData).toString()).toBe(
      "Required Data",
    );
  });

  test("should handle null values for optional binary fields", async () => {
    const binary = await TestBinary.create({
      binaryId: `test-binary-${Date.now()}-2`,
      name: "Test Binary 2",
      requiredData: Buffer.from("Required"),
    });

    const fetchedBinary = await TestBinary.find(binary.binaryId);
    expect(fetchedBinary.data).toBeNull();
  });

  test("should reject non-Buffer values", async () => {
    await expect(async () => {
      await TestBinary.create({
        binaryId: `test-binary-${Date.now()}-3`,
        data: "not a buffer",
        requiredData: Buffer.from("Required"),
      });
    }).rejects.toThrow(ValidationError);
  });

  test("should enforce required field constraint", async () => {
    await expect(async () => {
      await TestBinary.create({
        binaryId: `test-binary-${Date.now()}-4`,
        name: "Test Binary 4",
        data: Buffer.from("Optional"),
      });
    }).rejects.toThrow(ValidationError);
  });

  test("should update binary data and return Uint8Array", async () => {
    const newData = Buffer.from("Updated Data");
    const result = await TestBinary.update(testBinary.binaryId, {
      data: newData,
    });

    expect(result.data instanceof Uint8Array).toBe(true);
    expect(Buffer.from(result.data).toString()).toBe("Updated Data");
  });

  test("should reject GSI conversion", async () => {
    const binary = await TestBinary.create({
      binaryId: `test-binary-${Date.now()}-5`,
      requiredData: Buffer.from("Required"),
    });

    expect(() => {
      BinaryField().toGsi(binary.data);
    }).toThrow(ValidationError);
  });

  test("should handle large binary data", async () => {
    const largeData = Buffer.alloc(256 * 1024); // 256KB of data
    largeData.fill("x");

    const binary = await TestBinary.create({
      binaryId: `test-binary-${Date.now()}-6`,
      data: largeData,
      requiredData: Buffer.from("Required"),
    });

    const fetchedBinary = await TestBinary.find(binary.binaryId);
    expect(fetchedBinary.data instanceof Uint8Array).toBe(true);
    expect(fetchedBinary.data.length).toBe(largeData.length);
    expect(Buffer.from(fetchedBinary.data).equals(largeData)).toBe(true);
  });

  test("should accept both Buffer and Uint8Array for writes", async () => {
    // Test with Buffer
    const withBuffer = await TestBinary.create({
      binaryId: `test-binary-${Date.now()}-7`,
      data: Buffer.from("Buffer Data"),
      requiredData: Buffer.from("Required Buffer"),
    });

    // Test with Uint8Array
    const uint8Array = new TextEncoder().encode("Uint8Array Data");
    const withUint8Array = await TestBinary.create({
      binaryId: `test-binary-${Date.now()}-8`,
      data: uint8Array,
      requiredData: new TextEncoder().encode("Required Uint8Array"),
    });

    // Verify both reads return Uint8Array
    const fetchedBuffer = await TestBinary.find(withBuffer.binaryId);
    const fetchedUint8Array = await TestBinary.find(withUint8Array.binaryId);

    expect(fetchedBuffer.data instanceof Uint8Array).toBe(true);
    expect(fetchedUint8Array.data instanceof Uint8Array).toBe(true);

    expect(Buffer.from(fetchedBuffer.data).toString()).toBe("Buffer Data");
    expect(Buffer.from(fetchedUint8Array.data).toString()).toBe(
      "Uint8Array Data",
    );
  });
});
