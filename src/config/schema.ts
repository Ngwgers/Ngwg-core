import type { ObjectSchema } from "../util/schema.ts";
import { isPlainObject } from "../util/schema.ts";

const THEME_MISSING =
  'required field "theme" is missing — set it to a theme name or path, e.g. theme: pacific';

export interface CreateUserConfigSchemaOptions {
  /**
   * Plugin keys for which the caller injects a default source. Declarations
   * for these keys may omit the URL — the plugin loader falls back to the
   * injected source.
   */
  fallbackPluginKeys?: ReadonlySet<string>;
}

/**
 * Declarative description of `ngwg.yaml`. All the "what is valid" knowledge
 * lives here; `validateSchema` owns the "how".
 */
export function createUserConfigSchema(
  options: CreateUserConfigSchemaOptions = {},
): ObjectSchema {
  const isFallback = (key: string) => options.fallbackPluginKeys?.has(key) ?? false;

  return {
    type: "object",
    fields: {
      title: {
        type: "string",
        required: true,
        nonEmpty: true,
        message: 'required field "title" is missing or empty',
      },

      theme: {
        type: "union",
        required: true,
        message: THEME_MISSING,
        variants: [
          {
            match: (v) => typeof v === "string",
            schema: { type: "string", nonEmpty: true, message: THEME_MISSING },
          },
          {
            match: isPlainObject,
            schema: {
              type: "record",
              values: {
                type: "object",
                message: (p) => `${p} must be a map of theme-config overrides (e.g. per_page: 5)`,
              },
              check: (value, ctx) => {
                const keys = Object.keys(value);
                if (keys.length === 0) {
                  ctx.report(
                    '"theme" map needs exactly one theme name/path key with an overrides map',
                  );
                }
                if (keys.length > 1) {
                  ctx.report(
                    `"theme" map supports exactly one theme key, got: ${keys.join(", ")}`,
                  );
                }
              },
            },
          },
        ],
        invalid: () =>
          '"theme" must be a theme name/path or a { <name>: { overrides } } map',
      },

      baseurl: {
        type: "string",
        message: '"baseurl" must be a string like "/"',
      },

      url: {
        type: "string",
        nonEmpty: true,
        message: '"url" must be a site origin string like "https://example.com"',
      },

      source_dir: {
        type: "string",
        nonEmpty: true,
        message: '"source_dir" must be a non-empty string',
      },

      public_dir: {
        type: "string",
        nonEmpty: true,
        message: '"public_dir" must be a non-empty string',
      },

      language: {
        type: "string",
        nonEmpty: true,
        message: '"language" must be a non-empty language tag (e.g. "zh-CN", "en_US")',
      },

      themes: {
        type: "record",
        message: '"themes" must be a map of { name: url-or-declaration }',
        values: {
          type: "union",
          variants: [
            {
              match: (v) => typeof v === "string",
              schema: {
                type: "string",
                nonEmpty: true,
                message: (p) => `${p} must be a theme repo URL or path string`,
              },
            },
            {
              match: isPlainObject,
              schema: {
                type: "object",
                fields: {
                  url: {
                    type: "string",
                    required: true,
                    nonEmpty: true,
                    message: (p) => `${p} must be a theme repo URL or path string`,
                  },
                  options: {
                    type: "object",
                    message: (p) => `${p} must be a map of theme-config overrides`,
                  },
                },
              },
            },
          ],
          invalid: (p) => `${p} must be a URL/path string or a { url, options } map`,
        },
      },

      dev_speed: {
        type: "number",
        message: '"dev_speed" must be a number (KB/s; 0 or negative disables throttling)',
      },

      plugins: {
        type: "record",
        message: '"plugins" must be a map of { name: url-or-declaration }',
        values: (key) => {
          const hasDefault = isFallback(key);
          return {
            type: "union",
            variants: [
              {
                match: (v) => typeof v === "string",
                schema: {
                  type: "string",
                  // Keys with an injected default source tolerate an empty
                  // declaration (option-only entries).
                  nonEmpty: !hasDefault,
                  message: (p) => `${p} must be a URL or path string`,
                },
              },
              {
                match: isPlainObject,
                schema: {
                  type: "object",
                  fields: {
                    url: {
                      type: "string",
                      required: !hasDefault,
                      nonEmpty: !hasDefault,
                      message: (p) => `${p} must be a URL or path string`,
                    },
                    option: {
                      type: "object",
                      message: (p) => `${p} must be a map of options`,
                      fields: {
                        private: {
                          type: "object",
                          message: (p) => `${p} must be a map of private options`,
                        },
                      },
                    },
                    security: {
                      type: "object",
                      message: (p) => `${p} must be a map of security switches`,
                      fields: {
                        allowCustomEvent: {
                          type: "boolean",
                          message: (p) => `${p} must be a boolean`,
                        },
                      },
                    },
                  },
                },
              },
              // `pluginName: null` is legal only when a default source exists.
              ...(hasDefault
                ? [
                    {
                      match: (v: unknown) => v === null,
                      schema: { type: "custom" as const, validate: () => {} },
                    },
                  ]
                : []),
            ],
            invalid: (p) => `${p} must be a URL/path string or a { url, option } map`,
          };
        },
      },

      plugin: {
        type: "record",
        message: '"plugin" must be a map of { name: { <plugin settings> } }',
        values: {
          type: "object",
          message: (p) => `${p} must be a map of options`,
          check: (value, ctx) => {
            if (value.allowCustomEvent !== undefined) {
              // The trust flag moved; silently ignoring it here would look like
              // a granted trust that never takes effect — fail loudly instead.
              ctx.report(
                `${ctx.path}.allowCustomEvent is no longer read — ` +
                  `move it to plugins.<key>.security.allowCustomEvent under the plugin's ` +
                  `declaration key <key> in ngwg.yaml, then rerun ngwg build`,
              );
            }
          },
        },
      },
    },
  };
}
