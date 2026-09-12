// Plugin loading & management.
//
// Plugins are declared by URL in ngwg.yaml (user) and theme.yaml (theme).
// URLs may be local paths (./path, ../path, /abs, file://) or remote repos
// (https://..., git@...). Remote plugins are fetched into <root>/.ngwg/plugins
// by the Fish management script (scripts/ngwg-plugins.fish); when a plugin is
// missing, Core invokes that script itself before giving up.
//
// Each plugin directory must contain a manifest `ngwg-plugin.yaml`:
//   name: my-plugin
//   version: 1.0.0
//   entry: src/index.ts
// Core imports the entry with Bun, then runtime-validates the protocols the
// plugin implements (see protocol.ts).

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { exists, readText } from "../util/fs.ts";
import { trace } from "../util/log.ts";
import { parseYaml } from "../config/yaml.ts";
import { Logger } from "../util/log.ts";
import {
  validatePluginModule,
  type DeployerUnitV1,
  type HelperUnitV1,
  type ParserUnitV1,
  type PluginLoadResult,
} from "./protocol.ts";
import type { PluginContext, ThemeConfig, UserConfig } from "../types.ts";
import type { EventQueue } from "../events/queue.ts";

export interface PluginManifest {
  name: string;
  version: string;
  entry: string;
  protocols?: string[];
}

export interface LoadedPlugin {
  /** key from the config that declared this plugin */
  key: string;
  /** url/path as written in the config */
  url: string;
  /** absolute local directory of the plugin */
  root: string;
  manifest: PluginManifest;
  result: PluginLoadResult;
}

export class PluginLoadError extends Error {
  constructor(message: string) {
    super(message);
  }
}

const CORE_ROOT = path.resolve(import.meta.dir, "../..");
/**
 * Path of the plugin-management fish script. Resolved relative to THIS file
 * so it stays correct no matter where the core itself was loaded from
 * (monorepo checkout, ~/.ngwg or a project's .ngwg/core download).
 */
export const PLUGIN_SCRIPT = path.join(CORE_ROOT, "scripts", "ngwg-plugins.fish");

export function pluginStoreDir(rootDir: string): string {
  return process.env.NGWG_PLUGIN_DIR || path.join(rootDir, ".ngwg", "plugins");
}

function isRemoteUrl(url: string): boolean {
  return /^https?:\/\//.test(url) || url.startsWith("git@") || url.endsWith(".git");
}

function localPathFromUrl(url: string, rootDir: string): string | null {
  if (url.startsWith("file://")) return path.normalize(url.slice("file://".length));
  if (url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) {
    return path.resolve(rootDir, url);
  }
  return null;
}

/** Locate (or fetch) the local directory for a plugin declared by URL. */
export async function resolvePluginDir(
  key: string,
  url: string,
  rootDir: string,
  log: Logger,
): Promise<string> {
  const local = localPathFromUrl(url, rootDir);
  if (local) {
    if (await exists(local)) {
      trace(`plugin "${key}": resolved to local path ${local}`);
      return local;
    }
    throw new PluginLoadError(
      `plugin "${key}" not found at "${url}" (resolved to ${local}). ` +
        `Check the path in ngwg.yaml, or run \`ngwg plugin install ${key} "${url}"\`.`,
    );
  }

  // Remote URL: managed copy lives in the plugin store.
  const store = pluginStoreDir(rootDir);
  const dir = path.join(store, key);
  if (await exists(path.join(dir, "ngwg-plugin.yaml"))) {
    trace(`plugin "${key}": resolved from plugin store ${dir}`);
    return dir;
  }

  log.warn(`plugin "${key}" (${url}) is not installed yet — fetching via ${PLUGIN_SCRIPT}`);
  installPlugin(rootDir, key, url, log);
  if (await exists(path.join(dir, "ngwg-plugin.yaml"))) return dir;
  throw new PluginLoadError(
    `failed to install plugin "${key}" from ${url}. ` +
      `Try manually: fish ${PLUGIN_SCRIPT} install ${key} "${url}"`,
  );
}

function installPlugin(rootDir: string, key: string, url: string, log: Logger): void {
  const res = spawnSync("fish", [PLUGIN_SCRIPT, "install", key, url], {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    log.error(`plugin install failed for "${key}":\n${res.stderr || res.stdout}`);
  } else {
    log.info(res.stdout.trim());
  }
}

export async function readManifest(pluginRoot: string): Promise<PluginManifest> {
  const manifestPath = path.join(pluginRoot, "ngwg-plugin.yaml");
  if (!(await exists(manifestPath))) {
    throw new PluginLoadError(`plugin at ${pluginRoot} has no ngwg-plugin.yaml manifest`);
  }
  let raw: any;
  try {
    raw = parseYaml(await readText(manifestPath));
  } catch (e) {
    throw new PluginLoadError(`invalid manifest at ${manifestPath}: ${(e as Error).message}`);
  }
  for (const field of ["name", "version", "entry"] as const) {
    if (typeof raw?.[field] !== "string" || !raw[field]) {
      throw new PluginLoadError(`manifest ${manifestPath} is missing required field "${field}"`);
    }
  }
  return { name: raw.name, version: raw.version, entry: raw.entry, protocols: raw.protocols };
}

/** Import a plugin entry and validate which protocols it implements. */
export async function importPlugin(pluginRoot: string, manifest: PluginManifest, log: Logger): Promise<PluginLoadResult> {
  const entry = path.resolve(pluginRoot, manifest.entry);
  trace(`plugin "${manifest.name}": import entry ${entry}`);
  if (!(await exists(entry))) {
    return {
      ok: false,
      protocols: [],
      unitNames: [],
      errors: [`entry "${manifest.entry}" not found in plugin ${manifest.name}`],
      parsers: [],
      deployers: [],
      helpers: [],
    };
  }
  // plugins may declare npm dependencies ("必要时预编译"): install them
  // automatically when node_modules is missing (local/store plugins alike)
  const pkgJson = path.join(pluginRoot, "package.json");
  const nodeModules = path.join(pluginRoot, "node_modules");
  if ((await exists(pkgJson)) && !(await exists(nodeModules))) {
    const raw = await readText(pkgJson);
    if (raw.includes('"dependencies"')) {
      log.info(`plugin "${manifest.name}" has npm dependencies — running bun install`);
      const res = spawnSync("bun", ["install"], { cwd: pluginRoot, encoding: "utf8" });
      if (res.status !== 0) {
        return {
          ok: false,
          protocols: [],
          unitNames: [],
          errors: [`bun install failed in ${pluginRoot}: ${res.stderr || res.stdout}`],
          parsers: [],
          deployers: [],
          helpers: [],
        };
      }
    }
  }
  let mod: any;
  try {
    // cache-buster keeps dev-reload honest when plugin files change
    mod = await import(pathToFileURL(entry).href + "?t=" + Date.now());
  } catch (e) {
    return {
      ok: false,
      protocols: [],
      unitNames: [],
      errors: [`import failed: ${(e as Error).message}`],
      parsers: [],
      deployers: [],
      helpers: [],
    };
  }
  const exported = mod?.default ?? mod;
  const result = validatePluginModule(exported, manifest.name);

  // manifest-declared protocols are a contract; warn when the code disagrees
  if (manifest.protocols && result.ok) {
    for (const p of manifest.protocols) {
      if (!result.protocols.includes(p)) {
        log.warn(`plugin ${manifest.name} declares protocol ${p} in its manifest but does not implement it`);
      }
    }
  }
  return result;
}

export interface LoadAllOptions {
  rootDir: string;
  config: UserConfig;
  themeConfig?: ThemeConfig;
  log: Logger;
  queue: EventQueue;
  /** creates the per-plugin context (engine wires events/config in) */
  makeContext: (pluginName: string, trusted: boolean) => PluginContext;
  /**
   * fallback declarations injected by the caller (the CLI hardcodes the
   * official files/feature URLs there). Used only when neither the user
   * config nor the theme declares a plugin with that key — Core itself
   * ships no bundled plugins and knows no default URLs.
   */
  defaultPlugins?: Record<string, string>;
}

/** A protocol unit together with the manifest name of the module providing it. */
export interface LoadedUnit<T> {
  /** manifest name of the plugin module that declared the unit */
  plugin: string;
  unit: T;
}

export interface LoadAllResult {
  loaded: LoadedPlugin[];
  parsers: LoadedUnit<ParserUnitV1>[];
  deployers: LoadedUnit<DeployerUnitV1>[];
  helpers: HelperUnitV1[];
  /** merged helper namespace exposed to themes as `h` */
  helperMap: Record<string, (...args: any[]) => any>;
}

/**
 * Load every declared plugin (user config + theme config), falling back to
 * caller-provided defaults for keys nobody declared (the CLI passes the
 * official files/feature URLs there). Any load failure aborts the build:
 * we log a warning and throw so the CLI exits non-zero.
 */
export async function loadAllPlugins(opts: LoadAllOptions): Promise<LoadAllResult> {
  const { rootDir, config, themeConfig, log, queue } = opts;

  // merge declarations: user config wins over theme required plugins
  const declarations: Record<string, string> = {};
  for (const [k, v] of Object.entries(themeConfig?.plugins?.required ?? {})) {
    if (typeof v !== "string") throw new PluginLoadError(`theme config: plugin "${k}" needs a URL string`);
    declarations[k] = v;
  }
  Object.assign(declarations, config.plugins ?? {});
  // caller defaults last: they only fill keys nobody declared explicitly
  for (const [k, v] of Object.entries(opts.defaultPlugins ?? {})) {
    if (!declarations[k]) declarations[k] = v;
  }

  // optional theme plugins: never fetched, only hinted — and only when the
  // user (or theme required section) did not already declare them
  const optional = themeConfig?.plugins?.optional ?? {};
  for (const [k, url] of Object.entries(optional)) {
    if (declarations[k]) continue;
    const dir = localPathFromUrl(url, rootDir) ?? path.join(pluginStoreDir(rootDir), k);
    if (!(await exists(dir))) {
      log.warn(`安装这些插件可能获得更好体验: theme optional plugin "${k}" (${url}) — run \`ngwg plugin install ${k} "${url}"\``);
    }
  }

  const loaded: LoadedPlugin[] = [];
  const parsers: LoadedUnit<ParserUnitV1>[] = [];
  const deployers: LoadedUnit<DeployerUnitV1>[] = [];
  const helpers: HelperUnitV1[] = [];
  const helperMap: Record<string, (...args: any[]) => any> = {};

  for (const [key, url] of Object.entries(declarations)) {
    let pluginRoot: string;
    try {
      pluginRoot = await resolvePluginDir(key, url, rootDir, log);
    } catch (e) {
      log.error(`plugin "${key}" could not be resolved: ${(e as Error).message}`);
      throw e;
    }

    let manifest: PluginManifest;
    try {
      manifest = await readManifest(pluginRoot);
    } catch (e) {
      log.error(`plugin "${key}" failed to load: ${(e as Error).message}`);
      throw e;
    }

    const result = await importPlugin(pluginRoot, manifest, log);
    if (!result.ok) {
      const msg = `plugin "${key}" (${manifest.name} v${manifest.version}) failed to load:\n  ` + result.errors.join("\n  ");
      log.error(msg);
      throw new PluginLoadError(msg);
    }

    // trust gate for custom event injection: plugin.<name>.allowCustomEvent
    const trusted =
      config.plugin?.[manifest.name]?.allowCustomEvent === true ||
      config.plugin?.[key]?.allowCustomEvent === true;
    if (trusted) queue.trustPlugin(manifest.name);
    const ctx = opts.makeContext(manifest.name, trusted);

    try {
      await result.module?.onLoad?.(ctx);
    } catch (e) {
      const msg = `plugin "${key}" onLoad() failed: ${(e as Error).message}`;
      log.error(msg);
      throw new PluginLoadError(msg);
    }

    for (const unit of result.parsers) parsers.push({ plugin: manifest.name, unit });
    for (const unit of result.deployers) deployers.push({ plugin: manifest.name, unit });
    for (const unit of result.helpers) {
      helpers.push(unit);
      for (const [hname, fn] of Object.entries(unit.helpers)) {
        if (helperMap[hname]) log.warn(`helper "${hname}" from plugin ${unit.name} shadows an existing helper`);
        helperMap[hname] = fn;
      }
    }

    loaded.push({ key, url, root: pluginRoot, manifest, result });
    log.debug(`loaded plugin ${manifest.name} v${manifest.version} [${result.protocols.join(", ")}] from ${pluginRoot}`);
  }

  log.info(`plugins loaded: ${loaded.map((p) => p.manifest.name).join(", ")} ` +
    `(parsers: ${parsers.length}, deployers: ${deployers.length}, helpers: ${helpers.length})`);

  if (deployers.length === 0) {
    const msg = "no deployer plugin loaded — nothing can write the site. Install a plugin providing ngwg-deployer-v1 (the bundled Ngwg-files provides one).";
    log.error(msg);
    throw new PluginLoadError(msg);
  }

  return { loaded, parsers, deployers, helpers, helperMap };
}
