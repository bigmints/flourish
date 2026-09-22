#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const standalone = join(root, ".next", "standalone");

if (!existsSync(standalone)) {
  throw new Error("Next.js standalone output was not created");
}

const staticSource = join(root, ".next", "static");
const staticTarget = join(standalone, ".next", "static");
mkdirSync(staticTarget, { recursive: true });
cpSync(staticSource, staticTarget, { recursive: true, force: true });

const publicSource = join(root, "public");
if (existsSync(publicSource)) {
  cpSync(publicSource, join(standalone, "public"), { recursive: true, force: true });
}

// Runtime finance data is mounted separately and must never be part of a release.
rmSync(join(standalone, "data"), { recursive: true, force: true });

console.log("Prepared standalone assets");
