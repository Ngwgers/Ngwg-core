// Filesystem helpers built on node:fs/promises (Bun-compatible).
// Every read/write/delete is traced — visible only at --verbose.

import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { trace } from "./log.ts";

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

export async function rimraf(p: string): Promise<void> {
  trace(`delete ${p}`);
  await rm(p, { recursive: true, force: true });
}

export async function readText(p: string): Promise<string> {
  trace(`read ${p}`);
  return readFile(p, "utf8");
}

export async function readBytes(p: string): Promise<Uint8Array> {
  trace(`read ${p}`);
  return new Uint8Array(await readFile(p));
}

/** Recursively list all files under dir (relative paths, using "/"). */
export async function walkFiles(dir: string, prefix = ""): Promise<string[]> {
  if (!(await isDir(dir))) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(path.join(dir, entry.name), rel)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  trace(`walk ${dir} → ${out.length} file(s)`);
  return out;
}

export function extOf(p: string): string {
  return path.extname(p).toLowerCase();
}
