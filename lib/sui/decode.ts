/**
 * Turning Sui object payloads into domain values.
 *
 * Two things make this less trivial than it looks, and both have already cost
 * real debugging time on this project:
 *
 *  1. Struct fields arrive in two shapes. The RPC/SDK wraps them in `fields`;
 *     the CLI puts them directly under `content`. Reading only one shape
 *     silently yields empty objects rather than an error, which looks exactly
 *     like a broken deployment.
 *
 *  2. Move `u64` values arrive as decimal STRINGS, never numbers — they can
 *     exceed Number.MAX_SAFE_INTEGER, so the JSON encoder refuses to emit them
 *     as numbers. Anything that does `Number(field)` without thinking is a
 *     rounding bug waiting for a large treasury.
 */

import type { Cents } from "../types";
import { unitsToCents } from "./units";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Struct fields from a fetched object, accepting both wire shapes. */
export function extractFields(object: unknown): Record<string, unknown> {
  if (!isRecord(object)) return {};
  const container = isRecord(object.data) ? object.data : object;
  const content = isRecord(container.content) ? container.content : container;
  if (isRecord(content.fields)) return content.fields;
  return isRecord(content) ? content : {};
}

/** A struct held by value inside another — `Treasury.policy`, for instance. */
export function nestedFields(
  fields: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = fields[key];
  if (!isRecord(value)) return {};
  return isRecord(value.fields) ? value.fields : value;
}

/** A Move u64 as a bigint. Null when the field is absent or not numeric. */
export function readU64(fields: Record<string, unknown>, key: string): bigint | null {
  const value = fields[key];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

/** A u64 holding coin base units, converted to the cents the app speaks. */
export function readCents(fields: Record<string, unknown>, key: string): Cents | null {
  const units = readU64(fields, key);
  return units === null ? null : unitsToCents(units);
}

export function readBool(fields: Record<string, unknown>, key: string): boolean | null {
  const value = fields[key];
  return typeof value === "boolean" ? value : null;
}

export function readString(fields: Record<string, unknown>, key: string): string | null {
  const value = fields[key];
  return typeof value === "string" ? value : null;
}

export function readStringArray(fields: Record<string, unknown>, key: string): string[] {
  const value = fields[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * A `Balance<T>` field. The RPC renders it either as a bare numeric string or
 * as a struct with a `value`, depending on the object and the version.
 */
export function readBalance(fields: Record<string, unknown>, key: string): bigint | null {
  const direct = readU64(fields, key);
  if (direct !== null) return direct;
  const nested = nestedFields(fields, key);
  return readU64(nested, "value");
}

/**
 * A `Table` field, which carries its own object id — the parent to ask for
 * dynamic fields.
 */
export function readTableId(fields: Record<string, unknown>, key: string): string | null {
  const value = fields[key];
  if (typeof value === "string") return value;
  const table = nestedFields(fields, key);
  const id = table.id;
  if (typeof id === "string") return id;
  if (isRecord(id) && typeof id.id === "string") return id.id;
  return null;
}

/** An `id: UID` field, which the RPC renders as `{ id: "0x…" }`. */
export function readObjectId(fields: Record<string, unknown>, key = "id"): string | null {
  const value = fields[key];
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.id === "string") return value.id;
  return null;
}
