// ngwg.yaml discovery, parsing and schema validation.

import * as path from "node:path";
import { exists, readText } from "../util/fs.ts";
import { trace } from "../util/log.ts";
import { parseYaml } from "./yaml.ts";
import type { ThemeConfig, UserConfig } from "../types.ts";
import { createUserConfigSchema } from "./schema.ts";
import { validateSchema } from "../util/schema.ts";

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
export function validateUserConfig(
  config: UserConfig,
  configFile: string,
  fallbackPluginKeys?: ReadonlySet<string>,
): string[] {
  const schema = createUserConfigSchema({ fallbackPluginKeys });
  return validateSchema(schema, config).map((issue) => `${configFile}: ${issue.message}`);
}

