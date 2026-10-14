// BOOK-1S — a strict in-memory evaluator for the Prisma `where` shapes the
// Cookbook and the allergen filter build.
//
// The allergen hard filter lives entirely in a `where`; a stub that ignores the
// `where` (most stubs in this suite do) cannot tell a query that filters from
// one that does not, so a test written against it could never go red. This
// evaluates what it is given and THROWS on any key or operator it does not
// model — a new clause the evaluator cannot read fails the test loudly instead
// of passing as "no constraint".
//
// Modelled: AND / OR / NOT; scalar equality; { equals, in, notIn, not, lt, lte,
// gt, gte, has, hasSome, isEmpty, contains (+ mode: "insensitive") }; and a
// relation `{ some: <where> }` over an array-valued field (the meal → dish →
// ingredient join). Rows are plain objects; a relation is an array of rows.

/* eslint-disable @typescript-eslint/no-explicit-any */

const OPERATORS = new Set([
  "equals",
  "in",
  "notIn",
  "not",
  "lt",
  "lte",
  "gt",
  "gte",
  "has",
  "hasSome",
  "isEmpty",
  "contains",
  "mode",
  "some",
]);

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function scalar(v: unknown): unknown {
  return v instanceof Date ? v.getTime() : v;
}

function matchesField(value: unknown, cond: unknown, path: string): boolean {
  if (!isPlainObject(cond)) return scalar(value) === scalar(cond);
  for (const k of Object.keys(cond)) {
    if (!OPERATORS.has(k)) throw new Error(`mealWhere: unmodelled operator "${k}" at ${path}`);
  }
  if ("some" in cond) {
    if (!Array.isArray(value)) throw new Error(`mealWhere: "some" on a non-array at ${path}`);
    return value.some((row) => matchesWhere(row, cond.some, `${path}.some`));
  }
  const insensitive = cond.mode === "insensitive";
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case "mode":
        break;
      case "equals":
        if (scalar(value) !== scalar(arg)) return false;
        break;
      case "in":
        if (!(arg as unknown[]).includes(value)) return false;
        break;
      case "notIn":
        if ((arg as unknown[]).includes(value)) return false;
        break;
      case "not":
        if (isPlainObject(arg)) {
          if (matchesField(value, arg, `${path}.not`)) return false;
        } else if (arg === null) {
          if (value === null || value === undefined) return false;
        } else if (scalar(value) === scalar(arg)) return false;
        break;
      case "lt":
        if (value === null || value === undefined || !((value as number) < (arg as number))) return false;
        break;
      case "lte":
        if (value === null || value === undefined || !((value as number) <= (arg as number))) return false;
        break;
      case "gt":
        if (value === null || value === undefined || !((value as number) > (arg as number))) return false;
        break;
      case "gte":
        if (value === null || value === undefined || !((value as number) >= (arg as number))) return false;
        break;
      case "has":
        if (!Array.isArray(value) || !value.includes(arg)) return false;
        break;
      case "hasSome":
        if (!Array.isArray(value) || !(arg as unknown[]).some((a) => value.includes(a))) return false;
        break;
      case "isEmpty":
        if (!Array.isArray(value) || (value.length === 0) !== arg) return false;
        break;
      case "contains": {
        if (typeof value !== "string") return false;
        const hay = insensitive ? value.toLowerCase() : value;
        const needle = insensitive ? String(arg).toLowerCase() : String(arg);
        if (!hay.includes(needle)) return false;
        break;
      }
    }
  }
  return true;
}

export function matchesWhere(row: Record<string, any>, where: unknown, path = "where"): boolean {
  if (where === undefined) return true;
  if (!isPlainObject(where)) throw new Error(`mealWhere: non-object where at ${path}`);
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === "AND") {
      const list = Array.isArray(cond) ? cond : [cond];
      if (!list.every((w, i) => matchesWhere(row, w, `${path}.AND[${i}]`))) return false;
    } else if (key === "OR") {
      if (!(cond as unknown[]).some((w, i) => matchesWhere(row, w, `${path}.OR[${i}]`))) return false;
    } else if (key === "NOT") {
      const list = Array.isArray(cond) ? cond : [cond];
      if (list.some((w, i) => matchesWhere(row, w, `${path}.NOT[${i}]`))) return false;
    } else if (isPlainObject(row[key]) && isPlainObject(cond) && !Object.keys(cond).some((k) => OPERATORS.has(k))) {
      // A to-one relation filter: recurse into the related row.
      if (!matchesWhere(row[key], cond, `${path}.${key}`)) return false;
    } else {
      if (!(key in row)) throw new Error(`mealWhere: row has no field "${key}" (at ${path})`);
      if (!matchesField(row[key], cond, `${path}.${key}`)) return false;
    }
  }
  return true;
}
