// Ngwg-core public API.
//
//   import { build, startDevServer } from "ngwg-core";
//
//   await build("/path/to/site");              // one-shot build (steps 1-9)
//   await startDevServer({ rootDir, port });   // dev daemon with live-reload
//
// Everything else (Engine, EventQueue, plugin protocols) is exported for
// advanced use and for tests.

export * from "./types.ts";
export { EventQueue, Steps, EventInjectionDenied } from "./events/queue.ts";
export {
  PARSER_PROTOCOL,
  DEPLOYER_PROTOCOL,
  HELPER_PROTOCOL,
  KNOWN_PROTOCOLS,
  validatePluginModule,
} from "./plugin/protocol.ts";
export type {
  ParserPluginV1,
  DeployerPluginV1,
  HelperPluginV1,
  PluginModule,
  ProtocolObject,
} from "./plugin/protocol.ts";
export { loadAllPlugins, readManifest, resolvePluginDir, pluginStoreDir, PluginLoadError } from "./plugin/loader.ts";
export { Engine, CORE_VERSION, RunInterrupted } from "./core/engine.ts";
export { parseYaml, splitFrontmatter } from "./config/yaml.ts";
export {
  loadUserConfig,
  loadThemeConfig,
  validateUserConfig,
  findConfigFile,
  ConfigError,
} from "./config/loader.ts";
export { resolveThemeDir, loadTheme, ThemeError } from "./core/theme.ts";
export { buildSiteData, parseDate } from "./core/data.ts";
export { buildRenderTasks, slugify } from "./core/tasks.ts";
export { startDevServer } from "./dev/server.ts";
export { Watcher, planReload } from "./dev/watcher.ts";
export { Logger, setLogLevel, getLogLevel, trace, type LogLevel } from "./util/log.ts";
export { Pool, PoolAborted } from "./util/pool.ts";

import { Engine, type EngineOptions } from "./core/engine.ts";
import { Logger } from "./util/log.ts";

/** Run one full build (pipeline steps 1-9) for the site rooted at rootDir. */
export async function build(
  rootDir: string,
  opts: EngineOptions & { log?: Logger } = {},
): Promise<Engine> {
  const engine = new Engine(rootDir, opts);
  await engine.run({ reset: "all" });
  return engine;
}
