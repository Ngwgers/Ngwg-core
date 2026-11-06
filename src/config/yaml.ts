// YAML parsing — delegated to Bun's built-in parser (https://bun.com/docs/runtime/yaml).
// Full YAML support (anchors, block scalars, the works) with zero npm deps.
// parseYaml is the public API plugins receive via ctx.yaml, and everything in
// Core parses through here.

/**
 * Parse a YAML document. Returns null for empty documents (callers decide
 * whether that is acceptable); throws on malformed input.
 */
export function parseYaml(text: string): any {
  return Bun.YAML.parse(text);
}
