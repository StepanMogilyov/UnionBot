import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { TestContext } from "node:test";

export async function createTestDirectory(context: TestContext) {
  const testRoot = resolve(__dirname);
  const directory = await mkdtemp(join(testRoot, ".unionbot-test-"));
  context.after(async () => {
    if (!resolve(directory).startsWith(`${testRoot}${sep}.unionbot-test-`)) {
      throw new Error("Test cleanup path is outside the test workspace");
    }
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
