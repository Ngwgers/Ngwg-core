// ngwg.yaml discovery, parsing and schema validation.

import * as path from "node:path";
import { exists, readText } from "../util/fs.ts";
import { trace } from "../util/log.ts";
import { parseYaml } from "./yaml.ts";
import type { ThemeConfig, UserConfig } from "../types.ts";

export const CONFIG_FILENAMES = ["ngwg.yaml", "ngwg.yml"];

export class ConfigError extends Error {}

export async function findConfigFile(rootDir: string): Promise<string> {
  for (const name of CONFIG_FILENAMES) {
    const p = path.join(rootDir, name);
    if (await exists(p)) {
      trace(`config: found ${p}`);
      return p;
    }
  }
  throw new ConfigError(
    `no configuration file found in ${rootDir} (expected one of: ${CONFIG_FILENAMES.join(", ")}). ` +
      `Run \`ngwg init\` to create one.`,
  );
}

/** Step 2: read and parse ngwg.yaml. Throws ConfigError on parse failure. */
export async function loadUserConfig(rootDir: string): Promise<UserConfig> {
  const file = await findConfigFile(rootDir);
  trace(`config: load ${file}`);
  let text: string;
  try {
    text = await readText(file);
  } catch (e) {
    throw new ConfigError(`cannot read ${file}: ${(e as Error).message}`);
  }
  let doc: any;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new ConfigError(`failed to parse ${file}: ${(e as Error).message}`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new ConfigError(`${file}: top level must be a YAML map`);
  }
  return doc as UserConfig;
}

/** Step 4: read the theme's theme.yaml. */
export async function loadThemeConfig(themeRoot: string): Promise<ThemeConfig> {
  const file = path.join(themeRoot, "theme.yaml");
  if (!(await exists(file))) {
    throw new ConfigError(`theme at ${themeRoot} has no theme.yaml`);
  }
  let doc: any;
  try {
    doc = parseYaml(await readText(file));
  } catch (e) {
    throw new ConfigError(`failed to parse ${file}: ${(e as Error).message}`);
  }
  if (typeof doc !== "object" || doc === null) {
    throw new ConfigError(`${file}: top level must be a YAML map`);
  }
  return doc as ThemeConfig;
}

/**
 * Step 3: schema validation. Required fields are enforced; unknown top-level
 * fields are tolerated (plugins may read extra options from config.plugin).
 *
 * `fallbackPluginKeys` lists plugin keys for which the caller can inject a
 * default source (the CLI passes the official files/feature keys here):
 * declarations for those keys may omit the URL — the plugin loader falls
 * back to the injected source.
 */
export function validateUserConfig(config: UserConfig, configFile: string, fallbackPluginKeys?: ReadonlySet<string>): string[] {
  const errors: string[] = [];

  if (typeof config.title !== "string" || !config.title.trim()) {
    errors.push(`${configFile}: required field "title" is missing or empty`);
  }
  if (config.theme === undefined || config.theme === null || config.theme === "") {
    errors.push(`${configFile}: required field "theme" is missing — set it to a theme name or path, e.g. theme: pacific`);
  } else if (typeof config.theme === "object") {
    const keys = Object.keys(config.theme);
    if (keys.length === 0) {
      errors.push(`${configFile}: "theme" map needs exactly one theme name/path key with an overrides map`);
    }
    for (const k of keys) {
      const v = (config.theme as Record<string, any>)[k];
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        errors.push(`${configFile}: theme.${k} must be a map of theme-config overrides (e.g. per_page: 5)`);
      }
    }
    if (keys.length > 1) {
      errors.push(`${configFile}: "theme" map supports exactly one theme key, got: ${keys.join(", ")}`);
    }
  } else if (typeof config.theme !== "string" || !config.theme.trim()) {
    errors.push(`${configFile}: "theme" must be a theme name/path or a { <name>: { overrides } } map`);
  }
  if (config.baseurl !== undefined && typeof config.baseurl !== "string") {
    errors.push(`${configFile}: "baseurl" must be a string like "/"`);
  }
  if (config.url !== undefined && (typeof config.url !== "string" || !config.url.trim())) {
    errors.push(`${configFile}: "url" must be a site origin string like "https://example.com"`);
  }
  if (config.source_dir !== undefined && (typeof config.source_dir !== "string" || !config.source_dir.trim())) {
    errors.push(`${configFile}: "source_dir" must be a non-empty string`);
  }
  if (config.public_dir !== undefined && (typeof config.public_dir !== "string" || !config.public_dir.trim())) {
    errors.push(`${configFile}: "public_dir" must be a non-empty string`);
  }
  if (config.language !== undefined && (typeof config.language !== "string" || !config.language.trim())) {
    errors.push(`${configFile}: "language" must be a non-empty language tag (e.g. "zh-CN", "en_US")`);
  }
  if (config.themes !== undefined) {
    if (typeof config.themes !== "object" || config.themes === null || Array.isArray(config.themes)) {
      errors.push(`${configFile}: "themes" must be a map of { name: url-or-declaration }`);
    } else {
      for (const [k, v] of Object.entries(config.themes)) {
        if (typeof v === "string") {
          if (!v.trim()) errors.push(`${configFile}: themes.${k} must be a theme repo URL or path string`);
        } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
          if (typeof (v as any).url !== "string" || !(v as any).url.trim()) {
            errors.push(`${configFile}: themes.${k}.url must be a theme repo URL or path string`);
          }
          if (
            (v as any).options !== undefined &&
            (typeof (v as any).options !== "object" || (v as any).options === null || Array.isArray((v as any).options))
          ) {
            errors.push(`${configFile}: themes.${k}.options must be a map of theme-config overrides`);
          }
        } else {
          errors.push(`${configFile}: themes.${k} must be a URL/path string or a { url, options } map`);
        }
      }
    }
  }
  if (config.dev_speed !== undefined && typeof config.dev_speed !== "number") {
    errors.push(`${configFile}: "dev_speed" must be a number (KB/s; 0 or negative disables throttling)`);
  }
  if (config.plugins !== undefined) {
    if (typeof config.plugins !== "object" || config.plugins === null || Array.isArray(config.plugins)) {
      errors.push(`${configFile}: "plugins" must be a map of { name: url-or-declaration }`);
    } else {
      for (const [k, v] of Object.entries(config.plugins)) {
        // keys with an injected default source tolerate a url-less
        // declaration (option-only maps, empty values)
        const hasDefault = fallbackPluginKeys?.has(k) ?? false;
        if (typeof v === "string") {
          if (!v.trim() && !hasDefault) errors.push(`${configFile}: plugins.${k} must be a URL or path string`);
        } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
          if ((typeof (v as any).url !== "string" || !(v as any).url.trim()) && !hasDefault) {
            errors.push(`${configFile}: plugins.${k}.url must be a URL or path string`);
          }
          if (
            (v as any).option !== undefined &&
            (typeof (v as any).option !== "object" || (v as any).option === null || Array.isArray((v as any).option))
          ) {
            errors.push(`${configFile}: plugins.${k}.option must be a map of options`);
          } else if ((v as any).option?.private !== undefined && typeof (v as any).option.private !== "object") {
            errors.push(`${configFile}: plugins.${k}.option.private must be a map of private options`);
          }
          const security = (v as any).security;
          if (security !== undefined) {
            if (typeof security !== "object" || security === null || Array.isArray(security)) {
              errors.push(`${configFile}: plugins.${k}.security must be a map of security switches`);
            } else if (security.allowCustomEvent !== undefined && typeof security.allowCustomEvent !== "boolean") {
              errors.push(`${configFile}: plugins.${k}.security.allowCustomEvent must be a boolean`);
            }
          }
        } else if (!(hasDefault && v === null)) {
          errors.push(`${configFile}: plugins.${k} must be a URL/path string or a { url, option } map`);
        }
      }
    }
  }
  if (config.plugin !== undefined) {
    if (typeof config.plugin !== "object" || config.plugin === null || Array.isArray(config.plugin)) {
      errors.push(`${configFile}: "plugin" must be a map of { name: { <plugin settings> } }`);
    } else {
      for (const [name, opts] of Object.entries(config.plugin)) {
        if (typeof opts !== "object" || opts === null) {
          errors.push(`${configFile}: plugin.${name} must be a map of options`);
        } else if (opts.allowCustomEvent !== undefined) {
          // the trust flag moved; silently ignoring it here would look like a
          // granted trust that never takes effect — fail loudly instead
          errors.push(
            `${configFile}: plugin.${name}.allowCustomEvent is no longer read — ` +
              `move it to plugins.<key>.security.allowCustomEvent under the plugin's ` +
              `declaration key <key> in ngwg.yaml, then rerun ngwg build`,
          );
        }
      }
    }
  }
  return errors;
}
