const fs = require("fs");
const path = require("path");

describe("ESM Generated Models", () => {
  beforeAll(() => {
    // Verify ESM files were generated with correct syntax
    const generatedDir = path.join(__dirname, "codegen", "esm-test", "generated");
    
    // Check if generated files exist
    expect(fs.existsSync(path.join(generatedDir, "user.js"))).toBe(true);
    expect(fs.existsSync(path.join(generatedDir, "post.js"))).toBe(true);
    expect(fs.existsSync(path.join(generatedDir, "comment.js"))).toBe(true);
  });

  describe("Generated File Syntax", () => {
    test("should generate ESM import/export syntax", () => {
      const userFile = fs.readFileSync(
        path.join(__dirname, "codegen", "esm-test", "generated", "user.js"),
        "utf-8"
      );
      
      // Check for ESM import statements
      expect(userFile).toMatch(/import\s+\{\s*BaoModel/);
      expect(userFile).toMatch(/import\s+\{\s*UlidField/);
      expect(userFile).toMatch(/import\s+\{\s*Post\s*\}\s+from\s+['"]\.\//);
      
      // Check for ESM export statements
      expect(userFile).toMatch(/export\s+\{\s*User\s*\}/);
      
      // Should NOT contain CommonJS syntax
      expect(userFile).not.toMatch(/require\(/);
      expect(userFile).not.toMatch(/module\.exports/);
    });

    test("should include .js extensions for ESM compatibility", () => {
      const userFile = fs.readFileSync(
        path.join(__dirname, "codegen", "esm-test", "generated", "user.js"),
        "utf-8"
      );
      
      // Check that imports include .js extensions
      expect(userFile).toMatch(/from\s+['"'][^'"]+\.js['"]/);
      expect(userFile).toMatch(/from\s+['"]\.\/.+\.js['"]/);
    });

    test("should generate correct imports for related models", () => {
      const postFile = fs.readFileSync(
        path.join(__dirname, "codegen", "esm-test", "generated", "post.js"),
        "utf-8"
      );
      
      // Check for related field imports  
      expect(postFile).toMatch(/RelatedField/);
      
      // Check for constants imports
      expect(postFile).toMatch(/GSI_INDEX_ID/);
    });

    test("should generate correct structure for all model types", () => {
      const commentFile = fs.readFileSync(
        path.join(__dirname, "codegen", "esm-test", "generated", "comment.js"),
        "utf-8"
      );
      
      // Verify it contains all necessary ESM elements
      expect(commentFile).toMatch(/import[\s\S]*BaoModel/);
      expect(commentFile).toMatch(/class Comment extends BaoModel/);
      expect(commentFile).toMatch(/export\s+\{\s*Comment\s*\}/);
      
      // Check for index configuration imports
      expect(commentFile).toMatch(/IndexConfig/);
    });
  });

  describe("Module System Configuration", () => {
    test("should respect codegen.moduleSystem config option", () => {
      const configFile = fs.readFileSync(
        path.join(__dirname, "codegen", "esm-test", "config.mjs"),
        "utf-8"
      );
      
      // Verify config contains ESM setting
      expect(configFile).toMatch(/moduleSystem.*['"]esm['"]/);
    });

    test("should use .mjs config extension for ESM config", () => {
      const configPath = path.join(__dirname, "codegen", "esm-test", "config.mjs");
      expect(fs.existsSync(configPath)).toBe(true);
      
      const configContent = fs.readFileSync(configPath, "utf-8");
      expect(configContent).toMatch(/^import/m); // Starts with import
      expect(configContent).toMatch(/export default/);
    });
  });

  describe("Generated Model Structure", () => {
    test("should generate proper model class structure", () => {
      const esmUser = fs.readFileSync(
        path.join(__dirname, "codegen", "esm-test", "generated", "user.js"),
        "utf-8"
      );
      
      // Should have the correct class structure
      expect(esmUser).toMatch(/class User extends BaoModel/);
      expect(esmUser).toMatch(/static modelPrefix = ['"]u['"]/);
      expect(esmUser).toMatch(/static fields = \{/);
      expect(esmUser).toMatch(/static primaryKey =/);
      
      // Check for generated methods
      expect(esmUser).toMatch(/async.*findBy.*Email/);
    });

    test("should generate unique constraint methods in ESM", () => {
      const userFile = fs.readFileSync(
        path.join(__dirname, "codegen", "esm-test", "generated", "user.js"),
        "utf-8"
      );
      
      // Should generate unique constraint lookup methods
      expect(userFile).toMatch(/static async.*findBy.*Email/);
      expect(userFile).toMatch(/findByUniqueConstraint/);
    });

    test("should generate related field methods in ESM", () => {
      const commentFile = fs.readFileSync(
        path.join(__dirname, "codegen", "esm-test", "generated", "comment.js"),
        "utf-8"
      );
      
      // Should generate getter methods for related fields
      expect(commentFile).toMatch(/async.*getPost\(\)/);
      expect(commentFile).toMatch(/async.*getAuthor\(\)/);
      expect(commentFile).toMatch(/getOrLoadRelatedField/);
    });
  });

  describe("Cross-module References", () => {
    test("should properly reference other ESM modules", () => {
      const postFile = fs.readFileSync(
        path.join(__dirname, "codegen", "esm-test", "generated", "post.js"),
        "utf-8"
      );
      
      // Should import Comment for query methods
      expect(postFile).toMatch(/import.*Comment.*from/);
      
      const commentFile = fs.readFileSync(
        path.join(__dirname, "codegen", "esm-test", "generated", "comment.js"),
        "utf-8"
      );
      
      // Comment model doesn't import other models since it has no query methods for them
      // Just verify it has proper ESM structure
      expect(commentFile).toMatch(/import[\s\S]*from/);
      expect(commentFile).toMatch(/export.*Comment/);
    });
  });
});

describe("ESM Syntax Validation", () => {
  test("should use only ESM syntax, no CommonJS", () => {
    const esmUser = fs.readFileSync(
      path.join(__dirname, "codegen", "esm-test", "generated", "user.js"),
      "utf-8"
    );
    
    // ESM should use import/export
    expect(esmUser).toMatch(/^import/m);
    expect(esmUser).toMatch(/export\s+\{/);
    
    // Should NOT contain CommonJS syntax
    expect(esmUser).not.toMatch(/require\(/);
    expect(esmUser).not.toMatch(/module\.exports/);
  });

  test("should generate valid ESM module structure", () => {
    const esmPost = fs.readFileSync(
      path.join(__dirname, "codegen", "esm-test", "generated", "post.js"),
      "utf-8"
    );
    
    // Should start with imports (after header comments)
    expect(esmPost).toMatch(/import.*{[\s\S]*}.*from.*['"][^'"]+\.js['"]/);
    
    // Should end with export
    expect(esmPost).toMatch(/export\s+\{\s*Post\s*\};\s*$/);
    
    // Should not mix module systems
    expect(esmPost).not.toMatch(/require\(/);
    expect(esmPost).not.toMatch(/module\.exports/);
  });
});