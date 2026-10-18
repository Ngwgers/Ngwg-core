/**
 * A tiny, dependency-free schema DSL + validator.
 *
 * A schema describes *what* a value must look like; `validateSchema` knows
 * *how* to check it. Every node can override the error message, and messages
 * may be a function of the node's dotted path so that deeply nested failures
 * (e.g. `plugins.foo.option.private`) read naturally.
 */

export type MessageTemplate = string | ((path: string) => string);

export interface CheckContext {
  /** Dotted path of the node being checked ("" for the root). */
  readonly path: string;
  /** Push one error. The template is resolved against the current path. */
  report(message: MessageTemplate): void;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

interface BaseSchema {
  /** Whether a `undefined` value is an error. */
  required?: boolean;
  /** Overrides the default message for "missing", "wrong type" and "bad value". */
  message?: MessageTemplate;
}

export interface StringSchema extends BaseSchema {
  type: "string";
  /** Reject "" and whitespace-only strings. */
  nonEmpty?: boolean;
}

export interface NumberSchema extends BaseSchema {
  type: "number";
}

export interface BooleanSchema extends BaseSchema {
  type: "boolean";
}

export interface ObjectSchema extends BaseSchema {
  type: "object";
  /** Statically known fields; unknown keys are ignored. */
  fields?: Record<string, Schema>;
  /** Extra checks run after the fields have been validated. */
  check?: (value: Record<string, unknown>, ctx: CheckContext) => void;
}

export interface RecordSchema extends BaseSchema {
  type: "record";
  /** One schema for every entry, or a factory keyed by entry name. */
  values: Schema | ((key: string) => Schema);
  check?: (value: Record<string, unknown>, ctx: CheckContext) => void;
}

export interface UnionVariant {
  match: (value: unknown) => boolean;
  schema: Schema;
}

export interface UnionSchema extends BaseSchema {
  type: "union";
  variants: UnionVariant[];
  /** Used when no variant matches. */
  invalid: MessageTemplate;
}

export interface CustomSchema extends BaseSchema {
  type: "custom";
  validate: (value: unknown, ctx: CheckContext) => void;
}

export type Schema =
  | StringSchema
  | NumberSchema
  | BooleanSchema
  | ObjectSchema
  | RecordSchema
  | UnionSchema
  | CustomSchema;

export interface ValidateSchemaOptions {
  /** Path of the value being validated. Defaults to "". */
  path?: string;
}

export function validateSchema(
  schema: Schema,
  value: unknown,
  options: ValidateSchemaOptions = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walk(schema, value, options.path ?? "", issues);
  return issues;
}

/* ------------------------------------------------------------------ */

function walk(
  schema: Schema,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (value === undefined) {
    if (schema.required) {
      pushIssue(issues, path, schema.message ?? `field ${quote(path)} is required`);
    }
    return;
  }

  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") {
        pushIssue(issues, path, schema.message ?? `field ${quote(path)} must be a string`);
        return;
      }
      if (schema.nonEmpty && !value.trim()) {
        pushIssue(issues, path, schema.message ?? `field ${quote(path)} must be a non-empty string`);
      }
      return;
    }

    case "number": {
      if (typeof value !== "number") {
        pushIssue(issues, path, schema.message ?? `field ${quote(path)} must be a number`);
      }
      return;
    }

    case "boolean": {
      if (typeof value !== "boolean") {
        pushIssue(issues, path, schema.message ?? `field ${quote(path)} must be a boolean`);
      }
      return;
    }

    case "object": {
      if (!isPlainObject(value)) {
        pushIssue(issues, path, schema.message ?? `field ${quote(path)} must be a map`);
        return;
      }
      const ctx = makeContext(path, issues);
      for (const [key, child] of Object.entries(schema.fields ?? {})) {
        walk(child, value[key], joinPath(path, key), issues);
      }
      schema.check?.(value, ctx);
      return;
    }

    case "record": {
      if (!isPlainObject(value)) {
        pushIssue(issues, path, schema.message ?? `field ${quote(path)} must be a map`);
        return;
      }
      const ctx = makeContext(path, issues);
      for (const [key, entry] of Object.entries(value)) {
        const child = typeof schema.values === "function" ? schema.values(key) : schema.values;
        walk(child, entry, joinPath(path, key), issues);
      }
      schema.check?.(value, ctx);
      return;
    }

    case "union": {
      // A required union treats `null` as "missing" rather than "wrong shape".
      if (value === null && schema.required) {
        pushIssue(issues, path, schema.message ?? `field ${quote(path)} is required`);
        return;
      }
      for (const variant of schema.variants) {
        if (variant.match(value)) {
          walk(variant.schema, value, path, issues);
          return;
        }
      }
      pushIssue(issues, path, schema.invalid);
      return;
    }

    case "custom": {
      schema.validate(value, makeContext(path, issues));
      return;
    }
  }
}

function pushIssue(issues: ValidationIssue[], path: string, template: MessageTemplate): void {
  issues.push({ path, message: resolve(template, path) });
}

function resolve(template: MessageTemplate, path: string): string {
  return typeof template === "string" ? template : template(path);
}

function makeContext(path: string, issues: ValidationIssue[]): CheckContext {
  return {
    path,
    report(template) {
      pushIssue(issues, path, template);
    },
  };
}

function joinPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function quote(path: string): string {
  return `"${path}"`;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
