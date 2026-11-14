export interface ApiCatalog {
  entries: readonly ApiEntry[];
  types: Readonly<Record<string, ApiType>>;
}

/** A documented script member and, when declared, the capability it returns. */
export interface ApiEntry {
  description: string;
  examples: readonly string[];
  path: string;
  relatedTypes: readonly string[];
  signature: string;
  unavailable?: string;
  returns?: { namespace: string; collection?: true };
}

export interface ApiType {
  definition: string;
  description: string;
  relatedTypes: readonly string[];
}

export interface ApiHelpOptions {
  discovery?: readonly string[];
  examples?: readonly string[];
  limits?: Readonly<Record<string, number>>;
  /** Character budget for expanding related definitions. The primary entry is always included. */
  maxDescribeCharacters?: number;
  rules?: readonly string[];
  starter?: readonly string[];
}

export interface ApiSearchOptions {
  limit?: number;
  namespace?: string;
  offset?: number;
  query?: string;
}

export type ApiHelp = ReturnType<typeof createApiHelp>;

function summarize(entry: ApiEntry) {
  return { description: entry.description, path: entry.path, signature: entry.signature };
}

function indexEntries(catalog: ApiCatalog): Map<string, ApiEntry> {
  const entries = new Map<string, ApiEntry>();
  for (const entry of catalog.entries) {
    if (entry.path.split(".").some((part) => !part || part === "constructor" || part === "__proto__")) {
      throw new TypeError(`Invalid script binding path: ${entry.path}.`);
    }
    if (entries.has(entry.path)) throw new TypeError(`Duplicate script binding path: ${entry.path}.`);
    entries.set(entry.path, entry);
  }
  return entries;
}

/** Read-only discovery over the same catalog used to expose script bindings. */
export function createApiHelp(catalog: ApiCatalog, options: ApiHelpOptions = {}) {
  const byPath = indexEntries(catalog);
  const available = [...byPath.values()].filter((entry) => entry.unavailable === undefined)
    .sort((a, b) => a.path.localeCompare(b.path));
  const namespaces = [...new Set(available.map((entry) => entry.path.split(".")[0]))];
  const starter = (options.starter ?? []).flatMap((path) => {
    const entry = byPath.get(path);
    return entry && entry.unavailable === undefined ? [summarize(entry)] : [];
  });
  const maxDescribeCharacters = options.maxDescribeCharacters ?? 12_000;

  function search({ limit = 5, namespace, offset = 0, query = "" }: ApiSearchOptions = {}) {
    if (typeof query !== "string" || (namespace !== undefined && typeof namespace !== "string")) {
      throw new TypeError("api.search expects query and namespace strings.");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 10 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError("api.search requires limit from 1 to 10 and a nonnegative offset.");
    }
    const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const matches = available.filter((entry) => !namespace || entry.path === namespace || entry.path.startsWith(`${namespace}.`))
      .map((entry) => {
        const path = entry.path.toLowerCase();
        const description = entry.description.toLowerCase();
        const score = terms.reduce((total, term) => total + (path.includes(term) ? 4 : 0) + (description.includes(term) ? 1 : 0), 0);
        return { entry, score };
      })
      .filter(({ score }) => terms.length === 0 || score > 0)
      .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));
    const next = offset + limit;
    return {
      items: matches.slice(offset, next).map(({ entry }) => summarize(entry)),
      next: next < matches.length ? { offset: next } : null,
      remaining: Math.max(0, matches.length - next),
      total: matches.length,
    };
  }

  function describe({ path }: { path: string }) {
    if (typeof path !== "string" || !path) {
      throw new TypeError("api.describe requires a nonempty path from api.search or a related type name.");
    }
    const match = byPath.get(path) ?? (Object.hasOwn(catalog.types, path) ? catalog.types[path] : undefined);
    if (!match) {
      return { found: false as const, message: `Unknown API or type: ${path}. Use api.search({ query: ... }) for exact paths.`, path };
    }
    const relatedTypes = [...new Set(match.relatedTypes)].filter((name) => Object.hasOwn(catalog.types, name));
    const omittedTypes = [...relatedTypes];
    const types: Record<string, ApiType> = Object.create(null);
    const result = { ...match, found: true as const, path, omittedTypes, types };
    for (const name of relatedTypes) {
      const position = omittedTypes.indexOf(name);
      omittedTypes.splice(position, 1);
      types[name] = catalog.types[name];
      if (JSON.stringify(result).length > maxDescribeCharacters) {
        delete types[name];
        omittedTypes.splice(position, 0, name);
      }
    }
    return result;
  }

  function help() {
    return {
      discovery: [
        "api.search({ query?, namespace?, limit?, offset? }) returns script paths, signatures, and pagination.",
        "api.describe({ path }) returns full help and related types. Pass a related type name to inspect it.",
        ...(options.discovery ?? []),
      ],
      examples: options.examples ?? [],
      limits: options.limits ?? {},
      namespaces,
      rules: options.rules ?? [],
      starter,
    };
  }

  return { describe, help, search };
}

type Binding = { entry?: ApiEntry; children: Map<string, Binding> };

function hasMember(value: object, name: string): boolean {
  for (let owner: object | null = value; owner && owner !== Object.prototype; owner = Object.getPrototypeOf(owner)) {
    if (Object.hasOwn(owner, name)) return true;
  }
  return false;
}

/**
 * Exposes declared members from an app's trusted binding object. A declared
 * data leaf exposes the entire cloned value. Keep credentials outside those
 * values and use getters without side effects for exposed properties.
 * Callable return values require a declared namespace of their own.
 * The returned object has only the members present and enabled in the catalog.
 */
export function catalogBindings<T extends object>(catalog: ApiCatalog, namespace: string, value: T): T {
  const root: Binding = { children: new Map() };
  for (const entry of indexEntries(catalog).values()) {
    if (entry.unavailable !== undefined) continue;
    let node = root;
    for (const part of entry.path.split(".")) {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.entry = entry;
  }

  function projectNamespace(path: string, source: unknown): Record<string, unknown> {
    let node: Binding | undefined = root;
    for (const part of path.split(".")) node = node?.children.get(part);
    return node ? project(node, source) : {};
  }

  function project(node: Binding, source: unknown): Record<string, unknown> {
    if (!source || typeof source !== "object") return {};
    const object = source as Record<string, unknown>;
    const exposed: Array<[string, unknown]> = [];
    for (const [name, binding] of node.children) {
      if (!hasMember(object, name)) continue;
      const member = object[name];
      const entry = binding.entry;
      if (entry && typeof member === "function") {
        const { path, returns } = entry;
        function resultOf(result: unknown): unknown {
          if (!returns || result == null) return structuredClone(result);
          if (!returns.collection) return projectNamespace(returns.namespace, result);
          if (!Array.isArray(result)) throw new TypeError(`${path} must return a collection.`);
          return result.map((item) => projectNamespace(returns.namespace, item));
        }
        exposed.push([name, (...args: unknown[]) => {
          const result: unknown = Reflect.apply(member, object, args);
          return result && typeof (result as PromiseLike<unknown>).then === "function"
            ? Promise.resolve(result).then(resultOf)
            : resultOf(result);
        }]);
      } else if (binding.children.size > 0) {
        exposed.push([name, project(binding, member)]);
      } else if (entry) {
        exposed.push([name, structuredClone(member)]);
      }
    }
    return Object.fromEntries(exposed);
  }

  return projectNamespace(namespace, value) as T;
}
