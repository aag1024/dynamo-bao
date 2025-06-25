/**
 * Cloudflare Workers Demo
 *
 * This example shows how to use DynamoBao in Cloudflare Workers
 * with proper request-scoped batching.
 */

const { runWithBatchContext, BaoModel, PrimaryKeyConfig } = require("../src");
const { StringField, UlidField } = require("../src/fields");

// Example model for demonstration
class ExampleModel extends BaoModel {
  static modelPrefix = "ex";
  static fields = {
    id: UlidField({ autoAssign: true, required: true }),
    name: StringField({ required: true }),
    value: StringField(),
  };
  static primaryKey = PrimaryKeyConfig("id");
}

// Simulate concurrent requests
async function simulateConcurrentRequests() {
  console.log("Simulating concurrent requests with request isolation...\n");

  // Request 1: Wrapped with batch context
  const request1 = runWithBatchContext(async () => {
    console.log("Request 1 started");
    // Simulate finding multiple items with batching
    const results = await Promise.all([
      ExampleModel.find("01HJ12345", { batchDelay: 10 }),
      ExampleModel.find("01HJ12346", { batchDelay: 10 }),
      ExampleModel.find("01HJ12347", { batchDelay: 10 }),
    ]);
    console.log("Request 1 completed with", results.length, "results");
    return results;
  });

  // Request 2: Wrapped with batch context (isolated from request 1)
  const request2 = runWithBatchContext(async () => {
    console.log("Request 2 started");
    // Simulate finding different items with batching
    const results = await Promise.all([
      ExampleModel.find("01HJ22345", { batchDelay: 10 }),
      ExampleModel.find("01HJ22346", { batchDelay: 10 }),
    ]);
    console.log("Request 2 completed with", results.length, "results");
    return results;
  });

  // Wait for both requests to complete
  try {
    await Promise.all([request1, request2]);
    console.log(
      "\n✅ Both requests completed successfully with proper isolation",
    );
  } catch (error) {
    console.log("\n❌ Error occurred:", error.message);
    console.log("This is expected since we're not connected to DynamoDB");
  }
}

// Cloudflare Workers fetch handler example
function cloudflareWorkerExample() {
  console.log("\nCloudflare Workers fetch handler example:\n");

  const workerCode = `
export default {
  async fetch(request, env, ctx) {
    return runWithBatchContext(async () => {
      const url = new URL(request.url);
      const userId = url.searchParams.get('userId');
      
      if (!userId) {
        return new Response('Missing userId parameter', { status: 400 });
      }
      
      try {
        // This will use request-scoped batching
        const user = await User.find(userId);
        
        if (!user.exists()) {
          return new Response('User not found', { status: 404 });
        }
        
        // Load related data efficiently with batching
        await user.loadRelatedData(['profileId', 'organizationId']);
        
        return new Response(JSON.stringify({
          user: user.toJSON(),
          profile: user.getRelated('profileId')?.toJSON(),
          organization: user.getRelated('organizationId')?.toJSON()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
        
      } catch (error) {
        return new Response('Internal Server Error', { status: 500 });
      }
    });
  }
};`;

  console.log(workerCode);
}

// Run the demo
async function runDemo() {
  console.log("🚀 DynamoBao Cloudflare Workers Demo\n");
  console.log("This demo shows how to use request-scoped batching for");
  console.log("proper isolation in Cloudflare Workers environments.\n");

  await simulateConcurrentRequests();
  cloudflareWorkerExample();

  console.log("\n📚 Key Benefits:");
  console.log("- Request isolation: Each request has its own batch context");
  console.log(
    "- Automatic cleanup: Context is cleaned up when request completes",
  );
  console.log(
    "- Optimal batching: Multiple finds are still batched efficiently",
  );
  console.log("- No global state: Safe for concurrent request processing");
  console.log("\n✨ Ready for Cloudflare Workers deployment!");
}

// Only run demo if this file is executed directly
if (require.main === module) {
  runDemo().catch(console.error);
}

module.exports = {
  simulateConcurrentRequests,
  cloudflareWorkerExample,
  runDemo,
};
