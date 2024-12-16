const path = require("path");
const fs = require("fs").promises;
const os = require("os");
const chokidar = require("chokidar");

async function testChokidar() {
  let tempDir = path.join(os.tmpdir(), "chokidar-test-" + Date.now());
  await fs.mkdir(tempDir, { recursive: true });

  const testFile = path.join(tempDir, "test-file.js");
  await fs.writeFile(testFile, "// Initial content");

  console.log("Watching directory:", tempDir);
  console.log("Test file path:", testFile);

  // DON'T DO THIS tempDir = path.join(tempDir, '**/*.js');

  const watcher = chokidar.watch(tempDir, {
    // Changed to watch entire directory
    persistent: true,
    ignoreInitial: false, // Changed to false to see initial add events
    usePolling: true,
    interval: 100,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 100,
    },
  });

  watcher
    .on("add", (path) => console.log(`File ${path} has been added`))
    .on("change", (filepath) => {
      console.log("Change detected:", filepath);
    })
    .on("error", (error) => console.log(`Watcher error: ${error}`))
    .on("ready", () => {
      console.log("Watcher is ready");

      setTimeout(async () => {
        console.log("Modifying file");
        try {
          await fs.writeFile(testFile, "// Modified content");
          console.log("File modification completed");
        } catch (err) {
          console.error("Error modifying file:", err);
        }
      }, 1000);
    });

  // Keep process alive longer
  setTimeout(() => {
    console.log("Closing watcher");
    watcher.close();
  }, 10000); // Increased timeout to 10 seconds
}

testChokidar().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
