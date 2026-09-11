// Theme discovery & loading. A theme directory looks like:
//
//   theme.yaml        — manifest (name, layouts, plugins, per_page)
//   layout/*.html     — page layouts
//   partial/*.html    — reusable partials
//   assets/**         — static files copied verbatim into public/

import * as path from "node:path";
import { exists, isDir, readBytes, readText, walkFiles } from "../util/fs.ts";
import { trace } from "../util/log.ts";
import { loadThemeConfig } from "../config/loader.ts";
import type { ThemeConfig, ThemeObject } from "../types.ts";

const CORE_ROOT = path.resolve(import.meta.dir, "../..");
const DEFAULT_THEME_NAME = "pacific";

export class ThemeError extends Error {}

/**
 * Resolve the configured theme to a directory.
 *  - path containing "/" or starting with "." → relative to project root
 *  - bare name → look in $NGWG_THEMES, ~/.ngwg/themes/<name>, then bundled
 *    default theme when the name matches (default: "pacific").
 */
export async function resolveThemeDir(theme: string, rootDir: string): Promise<string> {
  const candidates: string[] = [];

  if (theme.includes("/") || theme.startsWith(".")) {
    candidates.push(path.resolve(rootDir, theme));
  } else {
    if (process.env.NGWG_THEMES) candidates.push(path.join(process.env.NGWG_THEMES, theme));
    const home = process.env.HOME;
    if (home) candidates.push(path.join(home, ".ngwg", "themes", theme));
    if (theme === DEFAULT_THEME_NAME) candidates.push(path.resolve(CORE_ROOT, "..", "Ngwg-default-theme"));
  }

  for (const c of candidates) {
    if (await isDir(c)) return c;
  }
  throw new ThemeError(
    `theme "${theme}" not found. Searched:\n  ` +
      candidates.join("\n  ") +
      `\nSet "theme" in ngwg.yaml to a theme name or a filesystem path.`,
  );
}

const DEFAULT_LAYOUTS: Record<string, string> = {
  index: "index",
  post: "post",
  page: "page",
  archive: "archive",
  tag: "tag",
  category: "category",
};

export async function loadTheme(themeRoot: string): Promise<ThemeObject> {
  const config: ThemeConfig = await loadThemeConfig(themeRoot);
  if (!config.name) throw new ThemeError(`theme.yaml at ${themeRoot} is missing required field "name"`);

  const layouts: Record<string, string> = {};
  const layoutDir = path.join(themeRoot, "layout");
  if (await isDir(layoutDir)) {
    for (const rel of await walkFiles(layoutDir)) {
      if (!/\.(html|htm)$/.test(rel)) continue;
      const name = rel.replace(/\.(html|htm)$/, "");
      trace(`theme: load layout "${name}"`);
      layouts[name] = await readText(path.join(layoutDir, rel));
    }
  }
  if (Object.keys(layouts).length === 0) {
    throw new ThemeError(`theme "${config.name}" has no layout/*.html templates`);
  }

  const partials: Record<string, string> = {};
  const partialDir = path.join(themeRoot, "partial");
  if (await isDir(partialDir)) {
    for (const rel of await walkFiles(partialDir)) {
      if (!/\.(html|htm)$/.test(rel)) continue;
      const name = rel.replace(/\.(html|htm)$/, "");
      trace(`theme: load partial "${name}"`);
      partials[name] = await readText(path.join(partialDir, rel));
    }
  }

  const assets: ThemeObject["assets"] = [];
  const assetsDir = path.join(themeRoot, "assets");
  if (await isDir(assetsDir)) {
    for (const rel of await walkFiles(assetsDir)) {
      // keep the assets/ prefix so URLs match /assets/...
      trace(`theme: load asset "assets/${rel}"`);
      assets.push({ relPath: `assets/${rel}`, content: await readBytes(path.join(assetsDir, rel)) });
    }
  }

  // merge layout overrides onto defaults
  const layoutMap = { ...DEFAULT_LAYOUTS, ...(config.layouts ?? {}) };
  for (const [kind, name] of Object.entries(layoutMap)) {
    if (!layouts[name]) {
      // index is mandatory; others may fall back to "page" then "index"
      if (kind === "index") {
        throw new ThemeError(`theme "${config.name}" is missing required layout "${name}" (for ${kind})`);
      }
      if (!layouts[layoutMap.page] && !layouts.index) {
        throw new ThemeError(`theme "${config.name}" has no usable layout for ${kind}`);
      }
    }
  }

  return { config, root: themeRoot, layouts, partials, assets };
}

export function themeLayoutMap(theme: ThemeObject): Record<string, string> {
  return { ...DEFAULT_LAYOUTS, ...(theme.config.layouts ?? {}) };
}

/** Check an output file is inside publicDir (guards against path traversal). */
export function safeJoin(publicDir: string, relPath: string): string {
  const abs = path.resolve(publicDir, relPath);
  if (!abs.startsWith(path.resolve(publicDir) + path.sep) && abs !== path.resolve(publicDir)) {
    throw new ThemeError(`refusing to write outside public dir: ${relPath}`);
  }
  return abs;
}

export { exists };
