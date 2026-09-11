// Tiny dependency-free YAML subset parser.
// Supports: nested maps by indentation, block lists ("- item"), inline lists/maps,
// quoted strings, numbers, booleans, null, and comments. This is enough for
// ngwg.yaml, theme.yaml and markdown frontmatter — real YAML documents that use
// anchors, block scalars or exotic syntax are out of scope on purpose.

class YamlError extends Error {}

interface Line {
  indent: number;
  text: string;
  no: number;
}

function stripComment(raw: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      out += c;
      if (c === quote && raw[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "#" && (i === 0 || raw[i - 1] === " " || raw[i - 1] === "\t")) break;
    out += c;
  }
  return out.replace(/\s+$/, "");
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const clean = stripComment(raw);
    if (!clean.trim()) return;
    const indent = clean.length - clean.trimStart().length;
    lines.push({ indent, text: clean.trim(), no: idx + 1 });
  });
  return lines;
}

function unquote(v: string): string {
  if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  }
  return v;
}

export function parseScalar(v: string): any {
  const t = v.trim();
  if (t === "" || t === "~" || t === "null" || t === "Null" || t === "NULL") return null;
  if (t === "true" || t === "True" || t === "TRUE" || t === "yes" || t === "on") return true;
  if (t === "false" || t === "False" || t === "FALSE" || t === "no" || t === "off") return false;
  if ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'"))) return unquote(t);
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  if (/^\[[\s\S]*\]$/.test(t)) return parseInlineList(t);
  if (/^\{[\s\S]*\}$/.test(t)) return parseInlineMap(t);
  return t;
}

function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const c of s) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth--;
    if (c === sep && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function parseInlineList(s: string): any[] {
  const inner = s.trim().slice(1, -1).trim();
  if (!inner) return [];
  return splitTopLevel(inner, ",").map((p) => parseScalar(p));
}

function parseInlineMap(s: string): Record<string, any> {
  const inner = s.trim().slice(1, -1).trim();
  const out: Record<string, any> = {};
  if (!inner) return out;
  for (const pair of splitTopLevel(inner, ",")) {
    const i = findColon(pair);
    if (i < 0) throw new YamlError(`inline map entry needs "key: value": ${pair}`);
    out[unquote(pair.slice(0, i).trim())] = parseScalar(pair.slice(i + 1));
  }
  return out;
}

function findColon(s: string): number {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ":") return i;
  }
  return -1;
}

function parseBlock(lines: Line[], start: number, indent: number): [any, number] {
  if (start >= lines.length) return [null, start];
  const first = lines[start];
  if (first.indent < indent) return [null, start];

  // a block whose first line is an inline collection is just that scalar
  if (first.text.startsWith("{") || first.text.startsWith("[")) {
    return [parseScalar(first.text), start + 1];
  }

  if (first.text.startsWith("- ") || first.text === "-") {
    const list: any[] = [];
    let i = start;
    while (i < lines.length && lines[i].indent === first.indent) {
      const line = lines[i];
      if (!(line.text.startsWith("- ") || line.text === "-")) break;
      const rest = line.text === "-" ? "" : line.text.slice(2).trim();
      if (rest === "") {
        // nested block under a bare "-"
        if (i + 1 < lines.length && lines[i + 1].indent > line.indent) {
          const [val, next] = parseBlock(lines, i + 1, lines[i + 1].indent);
          list.push(val);
          i = next;
          continue;
        }
        list.push(null);
        i++;
        continue;
      }
      const ci = findColon(rest);
      if (ci > 0 && !rest.startsWith('"') && !rest.startsWith("'")) {
        // "- key: value" — a single-line map item
        const item: Record<string, any> = {};
        item[unquote(rest.slice(0, ci).trim())] = parseScalar(rest.slice(ci + 1));
        list.push(item);
        i++;
        continue;
      }
      list.push(parseScalar(rest));
      i++;
    }
    return [list, i];
  }

  const map: Record<string, any> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError(`line ${line.no}: unexpected indent "${line.text}"`);
    const ci = findColon(line.text);
    if (ci < 0) throw new YamlError(`line ${line.no}: expected "key: value", got "${line.text}"`);
    const key = unquote(line.text.slice(0, ci).trim());
    const rest = line.text.slice(ci + 1).trim();
    if (rest === "") {
      if (i + 1 < lines.length && lines[i + 1].indent > line.indent) {
        const [val, next] = parseBlock(lines, i + 1, lines[i + 1].indent);
        map[key] = val;
        i = next;
      } else {
        map[key] = null;
        i++;
      }
    } else {
      map[key] = parseScalar(rest);
      i++;
    }
  }
  return [map, i];
}

export function parseYaml(text: string): any {
  const lines = splitLines(text);
  if (lines.length === 0) return {};
  const [doc, next] = parseBlock(lines, 0, lines[0].indent);
  if (next < lines.length) {
    throw new YamlError(`line ${lines[next].no}: inconsistent indentation near "${lines[next].text}"`);
  }
  return doc;
}

/** Parse a `---\nfrontmatter\n---` block. Returns meta and the remaining body. */
export function splitFrontmatter(text: string): { meta: Record<string, any>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  let meta: Record<string, any> = {};
  try {
    meta = parseYaml(m[1]) ?? {};
  } catch (e) {
    throw new YamlError(`invalid frontmatter: ${(e as Error).message}`);
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) meta = {};
  return { meta, body: text.slice(m[0].length) };
}
