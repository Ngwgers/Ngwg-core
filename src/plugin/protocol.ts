// Plugin protocol definitions and runtime validation.
//
// Like Wayland, an Ngwg plugin implements a *subset* of the available
// protocols and Core discovers at load time which ones it speaks. A plugin
// may implement just one protocol (e.g. only ngwg-helper-v1) and nothing else.
//
// A plugin module's default export may be:
//   - a single protocol object, or
//   - an array of protocol objects (one plugin can ship several), or
//   - { plugins: [...] } (explicit form)
// plus optional `onLoad(ctx)` / `onUnload()` lifecycle hooks on any object.

import type {
  DeployEnv,
  PluginContext,
  RenderTask,
  SourceObject,
} from "../types.ts";

export const PARSER_PROTOCOL = "ngwg-parser-v1";
export const DEPLOYER_PROTOCOL = "ngwg-deployer-v1";
export const HELPER_PROTOCOL = "ngwg-helper-v1";

export const KNOWN_PROTOCOLS = [PARSER_PROTOCOL, DEPLOYER_PROTOCOL, HELPER_PROTOCOL] as const;

export interface ParserPluginV1 {
  protocol: typeof PARSER_PROTOCOL;
  name: string;
  version: string;
  /** file extensions this parser handles, lowercase with dot, e.g. [".md"] */
  extensions: string[];
  /** convert one file into a SourceObject (or null to skip it) */
  parseFile(ctx: PluginContext, filePath: string, content: Uint8Array): Promise<SourceObject | null> | SourceObject | null;
}

export interface DeployerPluginV1 {
  protocol: typeof DEPLOYER_PROTOCOL;
  name: string;
  version: string;
  /** render every task and write results into env.publicDir */
  deploy(ctx: PluginContext, env: DeployEnv, tasks: RenderTask[]): Promise<void> | void;
}

export interface HelperPluginV1 {
  protocol: typeof HELPER_PROTOCOL;
  name: string;
  version: string;
  /** functions exposed to themes as `h.<name>` inside templates */
  helpers: Record<string, (...args: any[]) => any>;
  /** optional: contribute extra data to site.data during pipeline step 7 */
  buildData?(ctx: PluginContext, site: any, sources: SourceObject[]): Promise<Record<string, any>> | Record<string, any>;
  /**
   * optional: called once after the primary deployer wrote public/ — lets a
   * helper plugin generate extra artifacts (e.g. sitemap.xml, rss.xml).
   * Writing outside env.publicDir is a protocol violation.
   */
  afterDeploy?(ctx: PluginContext, env: DeployEnv): Promise<void> | void;
}

export type ProtocolObject = ParserPluginV1 | DeployerPluginV1 | HelperPluginV1;

export interface PluginModule {
  plugins?: ProtocolObject[];
  onLoad?(ctx: PluginContext): void | Promise<void>;
  onUnload?(): void | Promise<void>;
}

export interface PluginLoadResult {
  ok: boolean;
  /** which protocols the module implements (empty when invalid) */
  protocols: string[];
  pluginNames: string[];
  errors: string[];
  module?: PluginModule;
  objects: ProtocolObject[];
}

function isObject(v: any): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateProtocolObject(obj: any, label: string, errors: string[]): ProtocolObject | null {
  if (!isObject(obj)) {
    errors.push(`${label}: expected an object, got ${typeof obj}`);
    return null;
  }
  const proto = obj.protocol;
  const name = obj.name;
  const version = obj.version;
  if (typeof name !== "string" || !name) errors.push(`${label}: missing "name"`);
  if (typeof version !== "string" || !version) errors.push(`${label}: missing "version"`);

  switch (proto) {
    case PARSER_PROTOCOL: {
      if (!Array.isArray(obj.extensions) || obj.extensions.length === 0 || obj.extensions.some((e: any) => typeof e !== "string" || !e.startsWith("."))) {
        errors.push(`${label}: parser plugin must declare a non-empty "extensions" array of dot-prefixed strings`);
      }
      if (typeof obj.parseFile !== "function") {
        errors.push(`${label}: parser plugin must implement parseFile(ctx, filePath, content)`);
      }
      break;
    }
    case DEPLOYER_PROTOCOL: {
      if (typeof obj.deploy !== "function") {
        errors.push(`${label}: deployer plugin must implement deploy(ctx, env, tasks)`);
      }
      break;
    }
    case HELPER_PROTOCOL: {
      if (!isObject(obj.helpers)) {
        errors.push(`${label}: helper plugin must provide a "helpers" object of functions`);
      } else {
        for (const [k, fn] of Object.entries(obj.helpers)) {
          if (typeof fn !== "function") errors.push(`${label}: helper "${k}" is not a function`);
        }
      }
      if (obj.afterDeploy !== undefined && typeof obj.afterDeploy !== "function") {
        errors.push(`${label}: helper plugin "afterDeploy" must be a function when provided`);
      }
      break;
    }
    default:
      errors.push(
        `${label}: unknown protocol ${JSON.stringify(proto)}; known protocols: ${KNOWN_PROTOCOLS.join(", ")}`,
      );
      return null;
  }
  return obj as ProtocolObject;
}

/**
 * Runtime-validate an imported plugin module. Returns everything Core needs
 * to decide whether the plugin can be used and which protocols it speaks.
 * A plugin implementing no known protocol is a load failure.
 */
export function validatePluginModule(mod: any, label: string): PluginLoadResult {
  const errors: string[] = [];
  const objects: ProtocolObject[] = [];
  let candidates: any[];

  if (Array.isArray(mod)) candidates = mod;
  else if (isObject(mod) && Array.isArray(mod.plugins)) candidates = mod.plugins;
  else candidates = [mod];

  for (let i = 0; i < candidates.length; i++) {
    const validated = validateProtocolObject(candidates[i], `${label}[${i}]`, errors);
    if (validated) objects.push(validated);
  }

  if (objects.length === 0 && errors.length === 0) {
    errors.push(`${label}: module implements none of the known protocols (${KNOWN_PROTOCOLS.join(", ")})`);
  }

  return {
    ok: errors.length === 0 && objects.length > 0,
    protocols: [...new Set(objects.map((o) => o.protocol))],
    pluginNames: [...new Set(objects.map((o) => o.name))],
    errors,
    module: isObject(mod) ? (mod as PluginModule) : undefined,
    objects,
  };
}
