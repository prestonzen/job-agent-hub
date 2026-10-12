import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = await mkdtemp(join(tmpdir(), "job-hub-tests-"));
try {
  const file = join(dir, "dispatch.test.mjs");
  await build({ entryPoints: ["tests/dispatch.test.ts"], outfile: file, bundle: true, platform: "node", format: "esm" });
  const result = spawnSync(process.execPath, ["--test", file], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally { await rm(dir, { recursive: true, force: true }); }
