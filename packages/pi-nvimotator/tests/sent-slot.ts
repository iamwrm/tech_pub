import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileStore } from "../src/file-store.ts";

/** Test-only. Production Send is Lua `file_store.write_annotation`. */
export async function markSlotSent(
  store: FileStore,
  id: number,
  annotation: string,
): Promise<{ id: number; annotationPath: string; lastPath: string }> {
  const meta = await store.readMeta(id);
  if (!meta) throw new Error(`Nvimotator slot ${id} does not exist.`);
  const body = annotation.endsWith("\n") ? annotation : `${annotation}\n`;
  const annotationPath = store.annotationPath(id);
  const lastDir = join(store.root, "last");
  const lastPath = store.lastAnnotationPath();
  await writeFile(annotationPath, body);
  await chmod(annotationPath, 0o600);
  await mkdir(lastDir, { recursive: true, mode: 0o700 });
  await chmod(lastDir, 0o700);
  await writeFile(lastPath, body);
  await chmod(lastPath, 0o600);
  const metaPath = join(store.slotDir(id), "meta.json");
  await writeFile(metaPath, `${JSON.stringify({ ...meta, status: "sent", sentAt: new Date().toISOString() }, null, 2)}\n`);
  await chmod(metaPath, 0o600);
  return { id, annotationPath, lastPath };
}
