#!/usr/bin/env node

/**
 * Multi-Tenancy Demo for DynamoBao
 * 
 * This demo shows how to use the multi-tenancy features:
 * 1. Setting tenant context
 * 2. Data isolation between tenants
 * 3. Using tenant resolvers
 * 4. Cross-tenant operations
 */

const { TenantContext, initModels } = require('../src');
const { BaoModel, PrimaryKeyConfig } = require('../src/model');
const { StringField, UlidField } = require('../src/fields');
const { ulid } = require('ulid');

// Demo configuration
const config = {
  aws: { region: 'us-west-2' },
  db: { tableName: 'dynamo-bao-demo' },
  tenancy: { enabled: true },
};

// Simple demo model
class DemoUser extends BaoModel {
  static modelPrefix = 'demo_user';
  
  static fields = {
    userId: UlidField({ autoAssign: true, required: true }),
    name: StringField({ required: true }),
    email: StringField({ required: true }),
    tenantName: StringField(), // For demo purposes
  };
  
  static primaryKey = PrimaryKeyConfig('userId');
}

async function demonstrateMultiTenancy() {
  console.log('=== DynamoBao Multi-Tenancy Demo ===\n');
  
  try {
    // Initialize models with tenancy enabled
    const manager = initModels(config);
    manager.registerModel(DemoUser);
    
    // Demo 1: Basic tenant isolation using runWithTenant (concurrency-safe)
    console.log('Demo 1: Basic Tenant Isolation (Concurrency-Safe)');
    console.log('---------------------------------------------------');
    
    // Create users in different tenants using concurrency-safe method
    const tenant1 = ulid();
    const tenant2 = ulid();
    
    // Create users concurrently to demonstrate safety
    const [user1, user2] = await Promise.all([
      TenantContext.runWithTenant(tenant1, async () => {
        const user = await DemoUser.create({
          name: 'Alice (Tenant 1)',
          email: 'alice@tenant1.com',
          tenantName: 'Company A'
        });
        console.log(`Created user in tenant ${tenant1}: ${user.name}`);
        return user;
      }),
      
      TenantContext.runWithTenant(tenant2, async () => {
        const user = await DemoUser.create({
          name: 'Bob (Tenant 2)', 
          email: 'bob@tenant2.com',
          tenantName: 'Company B'
        });
        console.log(`Created user in tenant ${tenant2}: ${user.name}`);
        return user;
      })
    ]);
    
    // Demo 2: Data isolation verification
    console.log('\nDemo 2: Data Isolation Verification');
    console.log('-----------------------------------');
    
    // Count users in both tenants concurrently
    const [tenant1Count, tenant2Count] = await Promise.all([
      TenantContext.withTenant(tenant1, () => DemoUser.count()),
      TenantContext.withTenant(tenant2, () => DemoUser.count())
    ]);
    
    console.log(`Users in tenant ${tenant1}: ${tenant1Count.count}`);
    console.log(`Users in tenant ${tenant2}: ${tenant2Count.count}`);
    
    // Demo 3: Using tenant resolvers
    console.log('\nDemo 3: Using Tenant Resolvers');
    console.log('------------------------------');
    
    // Clear current tenant
    TenantContext.clearTenant();
    
    // Set up resolver
    let currentRequestTenant = tenant1;
    TenantContext.addResolver(() => {
      console.log(`Resolver: Returning tenant ${currentRequestTenant}`);
      return currentRequestTenant;
    });
    
    // Operations will now use resolver
    const users = await DemoUser.find(user1.userId);
    console.log(`Found user via resolver: ${users.name}`);
    
    // Change resolver tenant
    currentRequestTenant = tenant2;
    const users2 = await DemoUser.find(user2.userId);
    console.log(`Found user via resolver: ${users2.name}`);
    
    // Demo 4: Cross-tenant operations
    console.log('\nDemo 4: Cross-Tenant Operations');
    console.log('-------------------------------');
    
    const tenantStats = [];
    for (const tenantId of [tenant1, tenant2]) {
      const previousTenant = TenantContext.getCurrentTenant();
      
      try {
        TenantContext.setCurrentTenant(tenantId);
        const count = await DemoUser.count();
        tenantStats.push({
          tenantId,
          userCount: count.count
        });
      } finally {
        TenantContext.setCurrentTenant(previousTenant);
      }
    }
    
    console.log('Tenant statistics:');
    tenantStats.forEach(stat => {
      console.log(`  Tenant ${stat.tenantId}: ${stat.userCount} users`);
    });
    
    // Demo 5: Concurrency Safety Test
    console.log('\nDemo 5: Concurrency Safety Test');
    console.log('-------------------------------');
    
    // Simulate concurrent operations that could cause race conditions
    // if not properly isolated
    const concurrentOps = Array.from({ length: 5 }, (_, i) => 
      TenantContext.runWithTenant(`concurrent-tenant-${i}`, async () => {
        // Simulate async work that might cause context switching
        await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
        
        const user = await DemoUser.create({
          name: `Concurrent User ${i}`,
          email: `user${i}@concurrent.com`,
          tenantName: `Concurrent Tenant ${i}`
        });
        
        // More async work
        await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
        
        // Verify we still see the correct tenant
        const foundUser = await DemoUser.find(user.userId);
        
        return {
          created: user.name,
          found: foundUser.name,
          tenantMatches: user.tenantName === foundUser.tenantName
        };
      })
    );
    
    const concurrentResults = await Promise.all(concurrentOps);
    
    console.log('Concurrent operations results:');
    concurrentResults.forEach((result, i) => {
      console.log(`  Op ${i}: ${result.created} -> ${result.found} (Isolated: ${result.tenantMatches})`);
    });
    
    // Cleanup
    console.log('\nDemo 6: Cleanup');
    console.log('---------------');
    
    await Promise.all([
      TenantContext.withTenant(tenant1, () => DemoUser.delete(user1.userId)),
      TenantContext.withTenant(tenant2, () => DemoUser.delete(user2.userId))
    ]);
    
    console.log(`Deleted users from both tenants`);
    
    // Cleanup concurrent test users
    for (let i = 0; i < 5; i++) {
      await TenantContext.withTenant(`concurrent-tenant-${i}`, async () => {
        const users = await DemoUser.queryByIndex('byStatus', 'active');
        for (const user of users.items) {
          await DemoUser.delete(user.userId);
        }
      });
    }
    
    console.log('Cleaned up concurrent test users');
    console.log('\n=== Demo Complete ===');
    
  } catch (error) {
    console.error('Demo failed:', error);
    process.exit(1);
  } finally {
    TenantContext.clearTenant();
    TenantContext.clearResolvers();
  }
}

// Only run if called directly
if (require.main === module) {
  demonstrateMultiTenancy().catch(console.error);
}

module.exports = { demonstrateMultiTenancy, DemoUser };