import type { LayerProperty } from "../api/types";

export type OperatorId = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like";

export interface OperatorDef {
  id: OperatorId;
  symbol: string;
  label: string;
}

const EQ: OperatorDef = { id: "eq", symbol: "=", label: "equals" };
const NEQ: OperatorDef = { id: "neq", symbol: "≠", label: "not equal" };
const GT: OperatorDef = { id: "gt", symbol: ">", label: "greater than" };
const GTE: OperatorDef = { id: "gte", symbol: "≥", label: "greater or equal" };
const LT: OperatorDef = { id: "lt", symbol: "<", label: "less than" };
const LTE: OperatorDef = { id: "lte", symbol: "≤", label: "less or equal" };
const LIKE: OperatorDef = { id: "like", symbol: "~", label: "contains" };

export function isNumericType(type: string): boolean {
  return /xsd:(long|int|integer|short|byte|double|float|decimal)/.test(type);
}

export function isDateType(type: string): boolean {
  return /xsd:(dateTime|date|time)/.test(type);
}

export function operatorsFor(p: LayerProperty): OperatorDef[] {
  if (p.possibleValues && p.possibleValues.length > 0) return [EQ, NEQ];
  if (isNumericType(p.type) || isDateType(p.type)) return [EQ, NEQ, GT, GTE, LT, LTE];
  return [EQ, NEQ, LIKE];
}

/** The OGC spatial predicates OpenLayers can encode. */
export type SpatialOperatorId =
  | "bbox"
  | "intersects"
  | "within"
  | "contains"
  | "disjoint"
  | "dwithin";

export interface SpatialOperatorDef {
  id: SpatialOperatorId;
  label: string;
  /** Reads as: the feature <hint> the shape. */
  hint: string;
}

export const SPATIAL_OPERATORS: SpatialOperatorDef[] = [
  { id: "bbox", label: "BBOX", hint: "overlaps the box — the cheapest test" },
  { id: "intersects", label: "Intersects", hint: "touches or overlaps the shape anywhere" },
  { id: "within", label: "Within", hint: "lies entirely inside the shape" },
  { id: "contains", label: "Contains", hint: "encloses the shape entirely" },
  { id: "disjoint", label: "Disjoint", hint: "does not touch the shape at all" },
  { id: "dwithin", label: "DWithin", hint: "lies within a distance of the shape" }
];

/** BBOX takes an envelope, so it is only offered for a bounding box. */
export function spatialOperatorsFor(kind: "bbox" | "geometry"): SpatialOperatorDef[] {
  return kind === "bbox" ? SPATIAL_OPERATORS : SPATIAL_OPERATORS.filter((o) => o.id !== "bbox");
}

export const DISTANCE_UNITS = ["m", "km", "mi", "ft"];
