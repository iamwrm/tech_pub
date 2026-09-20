import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliIo } from "../src/file-cli.ts";

export function collectingIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: { write(chunk: string) { stdout.push(String(chunk)); } },
    stderr: { write(chunk: string) { stderr.push(String(chunk)); } },
  };
  return {
    io,
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

export async function withStoreRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "nvimotator-cli-"));
  const previous = process.env.NVIMOTATOR_STORE;
  try {
    await chmod(root, 0o700);
    process.env.NVIMOTATOR_STORE = root;
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.NVIMOTATOR_STORE;
    else process.env.NVIMOTATOR_STORE = previous;
    await rm(root, { recursive: true, force: true });
  }
}
