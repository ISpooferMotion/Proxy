import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Keep the workflow entry point in JavaScript; Python's standard-library zipfile
// lets us validate runtime archives and assemble portable test bundles without
// adding another dependency to the automation checkout.
const script = join(dirname(fileURLToPath(import.meta.url)), "stage-test-builds.py");
const [artifacts = "artifacts", destination = "test-builds", version] = process.argv.slice(2);
if (!version) {
  console.error("Usage: node stage-test-builds.mjs <artifacts> <destination> <version>");
  process.exit(1);
}

try {
  execFileSync("python3", [script, artifacts, destination, version], { stdio: "inherit" });
} catch (error) {
  console.error("Failed to stage test builds:", error.message);
  process.exit(1);
}
