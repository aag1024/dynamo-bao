const { TenantContext } = require("../src/tenant-context");
const { ModelManager } = require("../src/model-manager");

describe("TenantContext", () => {
  beforeEach(() => {
    // Reset tenant context before each test
    TenantContext.reset();
  });

  describe("setCurrentTenant and getCurrentTenant", () => {
    it("should set and get the current tenant", () => {
      TenantContext.setCurrentTenant("tenant-123");
      expect(TenantContext.getCurrentTenant()).toBe("tenant-123");
    });

    it("should return null when no tenant is set", () => {
      expect(TenantContext.getCurrentTenant()).toBeNull();
    });

    it("should update tenant when called multiple times", () => {
      TenantContext.setCurrentTenant("tenant-123");
      TenantContext.setCurrentTenant("tenant-456");
      expect(TenantContext.getCurrentTenant()).toBe("tenant-456");
    });
  });

  describe("clearTenant", () => {
    it("should clear the current tenant", () => {
      TenantContext.setCurrentTenant("tenant-123");
      TenantContext.clearTenant();
      expect(TenantContext.getCurrentTenant()).toBeNull();
    });
  });

  describe("addResolver", () => {
    it("should add resolver functions and call them in order", () => {
      const resolver1 = jest.fn().mockReturnValue(null);
      const resolver2 = jest.fn().mockReturnValue("tenant-from-resolver");

      TenantContext.addResolver(resolver1);
      TenantContext.addResolver(resolver2);

      const tenant = TenantContext.getCurrentTenant();

      expect(resolver1).toHaveBeenCalled();
      expect(resolver2).toHaveBeenCalled();
      expect(tenant).toBe("tenant-from-resolver");
    });

    it("should stop at first resolver that returns a value", () => {
      const resolver1 = jest.fn().mockReturnValue("tenant-1");
      const resolver2 = jest.fn().mockReturnValue("tenant-2");

      TenantContext.addResolver(resolver1);
      TenantContext.addResolver(resolver2);

      const tenant = TenantContext.getCurrentTenant();

      expect(resolver1).toHaveBeenCalled();
      expect(resolver2).not.toHaveBeenCalled();
      expect(tenant).toBe("tenant-1");
    });

    it("should prefer explicitly set tenant over resolvers", () => {
      const resolver = jest.fn().mockReturnValue("tenant-from-resolver");
      TenantContext.addResolver(resolver);
      TenantContext.setCurrentTenant("explicit-tenant");

      const tenant = TenantContext.getCurrentTenant();

      expect(resolver).not.toHaveBeenCalled();
      expect(tenant).toBe("explicit-tenant");
    });

    it("should throw error when adding non-function resolver", () => {
      expect(() => {
        TenantContext.addResolver("not-a-function");
      }).toThrow("Resolver must be a function");
    });
  });

  describe("clearResolvers", () => {
    it("should clear all resolvers", () => {
      const resolver = jest.fn().mockReturnValue("tenant-123");
      TenantContext.addResolver(resolver);
      TenantContext.clearResolvers();

      const tenant = TenantContext.getCurrentTenant();

      expect(resolver).not.toHaveBeenCalled();
      expect(tenant).toBeNull();
    });
  });

  describe("getInstance", () => {
    it("should return ModelManager instance for tenant", () => {
      const manager = TenantContext.getInstance("tenant-123");
      expect(manager).toBeInstanceOf(ModelManager);
      expect(manager.getTenantId()).toBe("tenant-123");
    });

    it("should return same instance for same tenant", () => {
      const manager1 = TenantContext.getInstance("tenant-123");
      const manager2 = TenantContext.getInstance("tenant-123");
      expect(manager1).toBe(manager2);
    });

    it("should return different instances for different tenants", () => {
      const manager1 = TenantContext.getInstance("tenant-123");
      const manager2 = TenantContext.getInstance("tenant-456");
      expect(manager1).not.toBe(manager2);
    });

    it("should return default instance when tenant is null", () => {
      const manager = TenantContext.getInstance(null);
      expect(manager).toBeInstanceOf(ModelManager);
      expect(manager.getTenantId()).toBeNull();
    });
  });

  describe("validateTenantRequired", () => {
    it("should not throw when tenancy is disabled", () => {
      const config = { tenancy: { enabled: false } };
      expect(() => {
        TenantContext.validateTenantRequired(config);
      }).not.toThrow();
    });

    it("should not throw when tenancy config is missing", () => {
      const config = {};
      expect(() => {
        TenantContext.validateTenantRequired(config);
      }).not.toThrow();
    });

    it("should not throw when tenancy is enabled and tenant is set", () => {
      const config = { tenancy: { enabled: true } };
      TenantContext.setCurrentTenant("tenant-123");
      expect(() => {
        TenantContext.validateTenantRequired(config);
      }).not.toThrow();
    });

    it("should throw when tenancy is enabled but no tenant is set", () => {
      const config = { tenancy: { enabled: true } };
      expect(() => {
        TenantContext.validateTenantRequired(config);
      }).toThrow(
        "Tenant context is required when tenancy is enabled. " +
        "Use TenantContext.runWithTenant(tenantId, callback) or add tenant resolvers."
      );
    });

    it("should not throw when tenancy is enabled and resolver provides tenant", () => {
      const config = { tenancy: { enabled: true } };
      TenantContext.addResolver(() => "tenant-from-resolver");
      expect(() => {
        TenantContext.validateTenantRequired(config);
      }).not.toThrow();
    });
  });

  describe("reset", () => {
    it("should reset all state", () => {
      // Set up some state
      TenantContext.setCurrentTenant("tenant-123");
      TenantContext.addResolver(() => "tenant-resolver");
      const manager = TenantContext.getInstance("tenant-456");

      // Reset
      TenantContext.reset();

      // Verify everything is cleared
      expect(TenantContext.getCurrentTenant()).toBeNull();
      
      // New instance should be created
      const newManager = TenantContext.getInstance("tenant-456");
      expect(newManager).not.toBe(manager);
    });
  });

  describe("runWithTenant and withTenant", () => {
    it("should run callback with tenant context", async () => {
      const result = await TenantContext.runWithTenant("test-tenant", () => {
        return TenantContext.getCurrentTenant();
      });
      
      expect(result).toBe("test-tenant");
    });

    it("should handle async callbacks", async () => {
      const result = await TenantContext.runWithTenant("async-tenant", async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return TenantContext.getCurrentTenant();
      });
      
      expect(result).toBe("async-tenant");
    });

    it("should isolate tenant context between concurrent operations", async () => {
      const results = await Promise.all([
        TenantContext.runWithTenant("tenant-1", async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return TenantContext.getCurrentTenant();
        }),
        TenantContext.runWithTenant("tenant-2", async () => {
          await new Promise(resolve => setTimeout(resolve, 5));
          return TenantContext.getCurrentTenant();
        }),
        TenantContext.runWithTenant("tenant-3", async () => {
          await new Promise(resolve => setTimeout(resolve, 15));
          return TenantContext.getCurrentTenant();
        })
      ]);
      
      expect(results).toEqual(["tenant-1", "tenant-2", "tenant-3"]);
    });

    it("should support withTenant alias", async () => {
      const result = await TenantContext.withTenant("alias-tenant", () => {
        return TenantContext.getCurrentTenant();
      });
      
      expect(result).toBe("alias-tenant");
    });
  });

  describe("concurrency safety", () => {
    it("should handle concurrent tenant operations without interference", async () => {
      const tenant1Operations = TenantContext.runWithTenant("tenant-1", async () => {
        // Simulate some async work
        await new Promise(resolve => setTimeout(resolve, Math.random() * 20));
        
        // Should always see tenant-1
        const currentTenant = TenantContext.getCurrentTenant();
        expect(currentTenant).toBe("tenant-1");
        
        // More async work
        await new Promise(resolve => setTimeout(resolve, Math.random() * 20));
        
        // Should still see tenant-1
        return TenantContext.getCurrentTenant();
      });

      const tenant2Operations = TenantContext.runWithTenant("tenant-2", async () => {
        // Simulate some async work
        await new Promise(resolve => setTimeout(resolve, Math.random() * 20));
        
        // Should always see tenant-2
        const currentTenant = TenantContext.getCurrentTenant();
        expect(currentTenant).toBe("tenant-2");
        
        // More async work
        await new Promise(resolve => setTimeout(resolve, Math.random() * 20));
        
        // Should still see tenant-2
        return TenantContext.getCurrentTenant();
      });

      const tenant3Operations = TenantContext.runWithTenant("tenant-3", async () => {
        // Simulate some async work
        await new Promise(resolve => setTimeout(resolve, Math.random() * 20));
        
        // Should always see tenant-3
        const currentTenant = TenantContext.getCurrentTenant();
        expect(currentTenant).toBe("tenant-3");
        
        // More async work
        await new Promise(resolve => setTimeout(resolve, Math.random() * 20));
        
        // Should still see tenant-3
        return TenantContext.getCurrentTenant();
      });

      // Run all operations concurrently
      const results = await Promise.all([
        tenant1Operations,
        tenant2Operations, 
        tenant3Operations
      ]);

      // Each operation should have maintained its tenant context
      expect(results).toEqual(["tenant-1", "tenant-2", "tenant-3"]);
    });

    it("should handle nested tenant contexts correctly", async () => {
      const result = await TenantContext.runWithTenant("outer-tenant", async () => {
        expect(TenantContext.getCurrentTenant()).toBe("outer-tenant");
        
        const innerResult = await TenantContext.runWithTenant("inner-tenant", async () => {
          expect(TenantContext.getCurrentTenant()).toBe("inner-tenant");
          return "inner-complete";
        });
        
        // Should be back to outer tenant
        expect(TenantContext.getCurrentTenant()).toBe("outer-tenant");
        return innerResult;
      });
      
      expect(result).toBe("inner-complete");
      expect(TenantContext.getCurrentTenant()).toBeNull();
    });

    it("should not leak tenant context between async operations", async () => {
      // Set a fallback tenant
      TenantContext.setCurrentTenant("fallback-tenant");
      
      const asyncOp1 = TenantContext.runWithTenant("async-1", async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return TenantContext.getCurrentTenant();
      });
      
      const asyncOp2 = TenantContext.runWithTenant("async-2", async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return TenantContext.getCurrentTenant();
      });
      
      // Outside async context should still see fallback
      expect(TenantContext.getCurrentTenant()).toBe("fallback-tenant");
      
      const [result1, result2] = await Promise.all([asyncOp1, asyncOp2]);
      
      expect(result1).toBe("async-1");
      expect(result2).toBe("async-2");
      
      // Should still see fallback after async operations complete
      expect(TenantContext.getCurrentTenant()).toBe("fallback-tenant");
    });
  });
});