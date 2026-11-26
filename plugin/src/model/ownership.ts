/*
 * Who owns a field of a Kubernetes object, from metadata.managedFields
 * (k4all spec §4, rule R9). The same file is in Hangar and Cairn.
 *
 * The API server records, for every writer (field manager), the fields it
 * set, as a FieldsV1 tree: "f:spec" → "f:mgr" → "f:count" → {}. A field
 * that the k4all operator applies comes back to k4all's value at its next
 * apply, so a console shows it read-only and says where to change it
 * instead of letting an edit be silently reverted.
 *
 * - k4all runs the cluster when discovery serves its API group
 *   (k4all.magesgate.com). Without it, everything is the console's, whatever
 *   managedFields say (k4allOwns).
 * - A field is k4all's when an entry of the manager "k4all-operator" covers
 *   it. "k4all-operator-seed" (objects k4all creates once and then leaves to
 *   the consoles) does not count, nor does any other manager.
 * - Covering: the walk reaches the field, or stops on an empty set ({})
 *   above it while the live value there is a list or a scalar, which is
 *   then owned as one value. An empty set over a live struct or map (an
 *   applied `workloadUpdateStrategy: {}`) owns none of its children.
 * - Entries of a shared list (KubeVirt's featureGates) cannot be told apart
 *   in managedFields (an atomic list has one manager): k4all lists the ones
 *   it added in an annotation of the object (k4allAnnotationList).
 * - Give these functions the object as a GET returns it: Headlamp's list
 *   queries delete metadata.managedFields from every listed object, so a
 *   listed copy has no owner (src/api/managedFields.ts reads the GET).
 */

import { ManagedFieldsEntry, Obj } from './types';

/** The API group discovery serves when k4all runs the cluster. */
export const K4ALL_GROUP = 'k4all.magesgate.com';
/** The field manager of everything the k4all operator owns. */
export const K4ALL_MANAGER = 'k4all-operator';
/** The field manager of objects k4all creates once and leaves to the consoles: not an owner. */
export const K4ALL_SEED_MANAGER = 'k4all-operator-seed';
/** The words on a control whose field k4all owns. */
export const K4ALL_MANAGED = 'Managed by k4all — change it in the k4all addon';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A field path as FieldsV1 keys. "spec.mgr.count" or ['spec', 'mgr',
 * 'count']; a segment that is already a FieldsV1 key (k:{"name":"rook"},
 * v:"x", i:0) is kept as it is.
 */
function keysOf(path: string | string[]): string[] {
  const parts = Array.isArray(path) ? path : path.split('.');
  return parts.filter(Boolean).map(p => (/^[fkvi]:/.test(p) ? p : `f:${p}`));
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The live value at FieldsV1 keys (f: field, k: list entry by key, v: set value, i: index); undefined when absent. */
function valueAt(o: unknown, keys: string[]): unknown {
  let v: unknown = o;
  for (const k of keys) {
    const rest = k.slice(2);
    if (k.startsWith('f:')) {
      v = isObj(v) ? v[rest] : undefined;
    } else if (!Array.isArray(v)) {
      return undefined;
    } else if (k.startsWith('i:')) {
      v = v[Number(rest)];
    } else {
      let want: unknown;
      try {
        want = JSON.parse(rest);
      } catch {
        return undefined;
      }
      v = k.startsWith('k:')
        ? v.find(e => isObj(e) && isObj(want) && Object.entries(want).every(([n, x]) => sameJson(e[n], x)))
        : v.find(e => sameJson(e, want));
    }
    if (v === undefined) return undefined;
  }
  return v;
}

/**
 * True when a FieldsV1 tree covers the field of `live` (the object the
 * tree belongs to): the walk reaches the field, or stops on an empty set
 * ({}) above it while the live value there is a list or a scalar (owned as
 * one value). An empty set over a struct or map, or over nothing, owns no
 * children; so does a parent owned only for its existence (".": {}).
 */
export function fieldsCover(fields: unknown, path: string | string[], live?: unknown): boolean {
  const keys = keysOf(path);
  if (!keys.length || !isObj(fields)) return false;
  let node: unknown = fields;
  for (let i = 0; i < keys.length; i++) {
    if (!isObj(node)) return false;
    if (i > 0 && Object.keys(node).length === 0) {
      const v = valueAt(live, keys.slice(0, i));
      return v !== undefined && !isObj(v);
    }
    node = node[keys[i]];
    if (node === undefined) return false;
  }
  return isObj(node);
}

/** The managers that own a field of the object (several when they share it). */
export function fieldManagers(o: Obj | null | undefined, path: string | string[]): string[] {
  const mf = o?.metadata?.managedFields;
  const entries: ManagedFieldsEntry[] = Array.isArray(mf) ? mf : [];
  const out: string[] = [];
  for (const e of entries) {
    if (!e || (e.fieldsType && e.fieldsType !== 'FieldsV1')) continue;
    if (fieldsCover(e.fieldsV1, path, o) && e.manager && !out.includes(e.manager)) out.push(e.manager);
  }
  return out;
}

export function ownedBy(o: Obj | null | undefined, path: string | string[], manager: string): boolean {
  return fieldManagers(o, path).includes(manager);
}

/** True when the k4all operator's entry covers the field (managedFields only: see k4allOwns). */
export function ownedByK4all(o: Obj | null | undefined, path: string | string[]): boolean {
  return ownedBy(o, path, K4ALL_MANAGER);
}

/** True when the field is k4all's: k4all runs the cluster and its operator owns the field. */
export function k4allOwns(o: Obj | null | undefined, path: string | string[], k4all: boolean): boolean {
  return k4all && ownedByK4all(o, path);
}

/** Of these fields, the ones the k4all operator owns, as given. */
export function k4allOwnedFields(o: Obj | null | undefined, paths: string[]): string[] {
  return paths.filter(p => ownedByK4all(o, p));
}

/** The entries of a comma-separated annotation (what k4all added to a shared list, R6). */
export function k4allAnnotationList(o: Obj | null | undefined, annotation: string): string[] {
  const raw = o?.metadata?.annotations?.[annotation];
  return typeof raw === 'string' ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
}
