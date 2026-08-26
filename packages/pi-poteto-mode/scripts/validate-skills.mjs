#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertValidGeneratedPackage } from "./lib.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = assertValidGeneratedPackage(packageRoot);
console.log(`validated ${result.skillDirs.length} Pi-facing skills`);
