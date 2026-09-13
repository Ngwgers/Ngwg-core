// YAML parsing — delegated to Bun's built-in parser (https://bun.com/docs/runtime/yaml).
// Full YAML support (anchors, block scalars, the works) with zero npm deps.
// parseYaml/splitFrontmatter keep their signatures: they are the public API
// plugins receive via ctx.yaml, and everything in Core parses through here.

/**
 * Parse a YAML document. Returns null for empty documents (callers decide
 * whether that is acceptable); throws on malformed input.
 */
export function parseYaml(text: string): any {
  return Bun.YAML.parse(text);
}

/** Parse a `---\nfrontmatter\n---` block. Returns meta and the remaining body. */
export function splitFrontmatter(text: string): { meta: Record<string, any>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  let meta: Record<string, any> = {};
  try {
    meta = Bun.YAML.parse(m[1]) ?? {};
  } catch (e) {
    throw new Error(`invalid frontmatter: ${(e as Error).message}`);
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) meta = {};
  return { meta, body: text.slice(m[0].length) };
}
