// Theme discovery & loading. A theme directory looks like:
//
//   theme.yaml        — manifest (name, layouts, plugins, per_page)
//   layout/*          — page layouts (any extension; the engine that renders
//                       them is decided by the deployer claiming page tasks)
//   partial/*         — reusable partials (any extension, same rule)
//   i18n/<lang>.yaml  — optional translation strings per language; file names
//                       are normalized language tags (zh_CN.yaml, en_US.yaml)
//   assets/**         — static files copied verbatim into public/
//
// Layout and partial names are the file names WITHOUT extension — a theme
// may use .html, .pug, .liquid, … freely; the names in theme.yaml `layouts`
// and `{{> partial }}` references never carry an extension.

import * as path from "node:path";
import { exists, isDir, readBytes, readText, walkFiles } from "../util/fs.ts";
import { trace } from "../util/log.ts";
import { loadThemeConfig } from "../config/loader.ts";
import { parseYaml } from "../config/yaml.ts";
import { normalizeLanguage } from "./i18n.ts";
import type { ThemeConfig, ThemeObject } from "../types.ts";

export class ThemeError extends Error {}

export interface DefaultTheme {
  /** theme name this fallback answers to (e.g. "pacific") */
  name: string;
  /** local directory of the fallback theme (ensured by the CLI) */
  dir: string;
}

/**
 * Resolve the configured theme to a directory.
 *  - path containing "/" or starting with "." → relative to project root
 *  - bare name → look in $NGWG_THEMES, ~/.ngwg/themes/<name>, then the
 *    caller-provided fallback (the CLI ensures the official default theme;
 *    Core itself knows no default theme directories).
 */
export async function resolveThemeDir(
  theme: string,
  rootDir: string,
  fallback?: DefaultTheme,
): Promise<string> {
  const candidates: string[] = [];

  if (theme.includes("/") || theme.startsWith(".")) {
    candidates.push(path.resolve(rootDir, theme));
  } else {
    if (process.env.NGWG_THEMES) candidates.push(path.join(process.env.NGWG_THEMES, theme));
    const home = process.env.HOME;
    if (home) candidates.push(path.join(home, ".ngwg", "themes", theme));
    if (fallback && theme === fallback.name) candidates.push(fallback.dir);
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

/**
 * Deep-merge user overrides onto the theme's own config. Plain objects are
 * merged key-by-key (so `layouts` and `plugins.required` overrides add to
 * the theme's own entries); everything else (scalars, arrays) replaces.
 */
export function mergeThemeConfig(base: ThemeConfig, overrides: Record<string, any>): ThemeConfig {
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    const cur = out[k];
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)
        ? mergeThemeConfig(cur as ThemeConfig, v as Record<string, any>)
        : v;
  }
  return out as ThemeConfig;
}

export async function loadTheme(themeRoot: string, overrides?: Record<string, any>, declared?: string): Promise<ThemeObject> {
  const config = mergeThemeConfig(await loadThemeConfig(themeRoot), overrides ?? {});
  if (!config.name) throw new ThemeError(`theme.yaml at ${themeRoot} is missing required field "name"`);
  // errors mention both names: the theme's own name may differ from what the
  // user declared in ngwg.yaml (a name or a path) — searching for the
  // declared spelling must not dead-end
  const label = `"${config.name}"` + (declared && declared !== config.name ? ` (declared as "${declared}")` : "");

  const collectTemplates = async (dir: string, kind: string): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    const files: Record<string, string> = {};
    if (!(await isDir(dir))) return out;
    for (const rel of await walkFiles(dir)) {
      const name = path.parse(rel).name;
      if (out[name] !== undefined) {
        throw new ThemeError(
          `theme ${label} has two ${kind} templates named "${name}" (${files[name]} and ${rel}) — template names are file names without extension; keep one file per name`,
        );
      }
      trace(`theme: load ${kind} "${name}" (${rel})`);
      out[name] = await readText(path.join(dir, rel));
      files[name] = rel;
    }
    return out;
  };

  const layouts = await collectTemplates(path.join(themeRoot, "layout"), "layout");
  if (Object.keys(layouts).length === 0) {
    throw new ThemeError(`theme ${label} has no layout/ templates`);
  }

  const partials = await collectTemplates(path.join(themeRoot, "partial"), "partial");

  // i18n translation files: i18n/<lang>.yaml — the file name is the language
  // tag (normalized to lang_REGION); the document is the string table handed
  // to the deployer. i18n is optional: themes without translations just get
  // an empty map.
  const i18n: ThemeObject["i18n"] = {};
  const i18nDir = path.join(themeRoot, "i18n");
  if (await isDir(i18nDir)) {
    for (const rel of await walkFiles(i18nDir)) {
      const ext = path.extname(rel);
      if (ext !== ".yaml" && ext !== ".yml") continue;
      const lang = normalizeLanguage(path.basename(rel, ext));
      if (!lang) {
        throw new ThemeError(
          `theme ${label} has an i18n file with an invalid language name: i18n/${rel} — ` +
            `name it <lang>_<REGION>.yaml (e.g. zh_CN.yaml, en_US.yaml)`,
        );
      }
      if (i18n[lang] !== undefined) {
        throw new ThemeError(
          `theme ${label} has two i18n files for language "${lang}" — keep one file per language`,
        );
      }
      let doc: any;
      try {
        doc = parseYaml(await readText(path.join(i18nDir, rel)));
      } catch (e) {
        throw new ThemeError(`failed to parse theme ${label} i18n/${rel}: ${(e as Error).message}`);
      }
      if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
        throw new ThemeError(`theme ${label} i18n/${rel}: top level must be a YAML map of translation strings`);
      }
      trace(`theme: load i18n "${lang}" (${rel})`);
      i18n[lang] = doc;
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
        throw new ThemeError(`theme ${label} is missing required layout "${name}" (for ${kind})`);
      }
      if (!layouts[layoutMap.page] && !layouts.index) {
        throw new ThemeError(`theme ${label} has no usable layout for ${kind}`);
      }
    }
  }

  return { config, root: themeRoot, layouts, partials, i18n, assets };
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
