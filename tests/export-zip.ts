import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** Extract only into a fresh test directory. Reject traversal before writing any entry. */
export async function extractExportEntries(directory: string, entries: Record<string, Uint8Array>): Promise<void> {
  const root = resolve(directory);
  const safe = Object.entries(entries).map(([name, bytes]) => {
    assert.ok(name && !name.includes("\\") && !name.includes(":") && !/[\x00-\x1f]/.test(name) && !isAbsolute(name));
    assert.ok(name.split("/").every(part => part && part !== "." && part !== ".."));
    const path = resolve(root, name), inside = relative(root, path);
    assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside));
    return { path, bytes };
  });
  for (const { path, bytes } of safe) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: "wx" });
  }
}
