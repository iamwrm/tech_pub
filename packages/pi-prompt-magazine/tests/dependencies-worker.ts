import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensureDatabaseDependency } from "../dependencies.ts";

await ensureDatabaseDependency({
  packageDir: process.argv[2],
  install: async (cwd) => {
    await appendFile(join(cwd, "installs"), "install\n");
    await delay(200);
    const root = join(cwd, "node_modules", "better-sqlite3");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "package.json"), '{"name":"better-sqlite3","main":"index.cjs"}');
    await writeFile(join(root, "index.cjs"), "module.exports = class { close() {} };");
  },
});
