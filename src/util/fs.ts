// Filesystem helpers built on node:fs/promises (Bun-compatible).
// Every read/write/delete is traced — visible only at --verbose.

import { mkdir, readdir, readFile, rm, stat, writeFile, copyFile } from "node:fs/promises";
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

export async function writeText(p: string, text: string): Promise<void> {
  trace(`write ${p}`);
  await ensureDir(path.dirname(p));
  await writeFile(p, text);
}

export async function writeBytes(p: string, data: Uint8Array): Promise<void> {
  trace(`write ${p}`);
  await ensureDir(path.dirname(p));
  await writeFile(p, data);
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

/** Copy a file, creating parent directories as needed. */
export async function copyFileTo(src: string, dest: string): Promise<void> {
  trace(`copy ${src} → ${dest}`);
  await ensureDir(path.dirname(dest));
  await copyFile(src, dest);
}

export function extOf(p: string): string {
  return path.extname(p).toLowerCase();
}

/** Join a site baseurl and a path safely ("/blog" + "/posts/a/" => "/blog/posts/a/"). */
export function joinUrl(base: string, p: string): string {
  if (!base || base === "/") return p;
  return base.replace(/\/+$/, "") + (p.startsWith("/") ? p : "/" + p);
}
