// The plugin's package, as LM Studio loads it.

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("the package does not declare itself an ES module", () => {
  // LM Studio bundles the plugin into CommonJS as `.lmstudio/production.js`. Under "type": "module", Node reads
  // that `.js` file as an ES module, where `require` does not exist, and the plugin fails to start.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
  expect(pkg.type ?? "commonjs").toBe("commonjs");
});
