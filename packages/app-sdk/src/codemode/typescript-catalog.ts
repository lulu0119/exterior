import ts from "typescript";
import type { ApiCatalog, ApiEntry, ApiType } from "./catalog.js";

interface TypeScriptExport {
  source: string;
  symbol: string;
}

/** An exported SDK type or value exposed under a script namespace. */
export interface CatalogNamespace extends TypeScriptExport {
  namespace: string;
  /** Relative paths admitted to the sandbox. Omit to expose the public properties of this symbol. */
  members?: readonly string[];
  /** For namespaces without an explicit member list, descend into these relative paths. */
  expand?: readonly string[];
  /** Project this namespace when an exposed method returns this type or an array of it. */
  returned?: boolean;
  /** Relative paths kept in the help catalog with the reason they are unavailable. */
  unavailable?: Readonly<Record<string, string>>;
}

export interface TypeScriptCatalogOptions {
  namespaces: readonly CatalogNamespace[];
  examples?: Readonly<Record<string, readonly string[]>>;
  extraEntries?: readonly ApiEntry[];
  /** Include types referenced by entries supplied separately from the SDK namespaces. */
  extraTypes?: readonly TypeScriptExport[];
  /** Omit compiler or host fields from rendered type documentation. */
  omitTypeProperties?: readonly string[];
  /** Prefer a name derived from the use site for these SDK utility types. */
  structuralTypeNames?: readonly string[];
  /** Collect transitive dependencies that should invalidate the generated catalog. */
  trackSource?: (fileName: string) => boolean;
  onSource?: (fileName: string) => void;
}

/** Derive help and runtime binding paths from the same exposed SDK surface. */
export function buildTypeScriptCatalog(options: TypeScriptCatalogOptions): ApiCatalog {
  const extraTypes = options.extraTypes ?? [];
  const rootFiles = [...new Set([...options.namespaces, ...extraTypes].map(({ source }) => source))];
  if (!rootFiles.length) return { entries: [...(options.extraEntries ?? [])], types: {} };
  const program = ts.createProgram(rootFiles, {
    customConditions: ["browser"],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
  });
  const checker = program.getTypeChecker();
  const diagnostics = program.getSemanticDiagnostics().filter(({ category, file }) =>
    category === ts.DiagnosticCategory.Error && file !== undefined
    && (rootFiles.includes(file.fileName) || options.trackSource?.(file.fileName)));
  if (diagnostics.length) {
    throw new Error(`Cannot generate SDK help: ${diagnostics.slice(0, 5)
      .map(({ messageText }) => ts.flattenDiagnosticMessageText(messageText, "\n")).join("\n")}`);
  }
  for (const { fileName } of program.getSourceFiles()) {
    if (rootFiles.includes(fileName) || options.trackSource?.(fileName)) options.onSource?.(fileName);
  }

  function exportedType(entry: TypeScriptExport) {
    const source = program.getSourceFile(entry.source);
    const module = source && checker.getSymbolAtLocation(source);
    const exported = module && checker.getExportsOfModule(module).find((symbol) => symbol.name === entry.symbol);
    if (!source || !exported) throw new Error(`No export "${entry.symbol}" in ${entry.source}`);
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const describesValue = !(symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias))
      && (symbol.flags & ts.SymbolFlags.Value);
    const type = describesValue
      ? checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration ?? source)
      : checker.getDeclaredTypeOfSymbol(symbol);
    return { source, type };
  }
  const roots = options.namespaces.map((namespace) => ({ namespace, ...exportedType(namespace) }));
  const returned = new Map(roots.filter(({ namespace }) => namespace.returned)
    .map(({ type, namespace }) => [type, namespace]));
  const structuralTypeNames = new Set(options.structuralTypeNames);
  const omitTypeProperties = new Set(options.omitTypeProperties);
  const types: Record<string, ApiType> = Object.create(null);
  const names = new Map<ts.Type, string>();
  const pending: Array<{ name: string, type: ts.Type }> = [];
  const refs = new Set<string>();
  const context = program.getSourceFile(rootFiles[0])!;
  const description = (symbol: ts.Symbol | undefined) =>
    symbol ? ts.displayPartsToString(symbol.getDocumentationComment(checker)) : "";
  const safeName = (hint: string) => hint.split(/[^a-z0-9]+/i).filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1)).join("");
  const isPublic = (symbol: ts.Symbol) => !symbol.declarations?.some((declaration) =>
    (ts.getCombinedModifierFlags(declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0
    || ("name" in declaration && declaration.name !== undefined && ts.isPrivateIdentifier(declaration.name as ts.Node)));

  function render(type: ts.Type, hint: string): string {
    if (["ArrayBuffer", "ArrayBufferLike", "Uint8Array"].includes(type.getSymbol()?.name ?? ""))
      return checker.typeToString(type, context);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike))
      return checker.typeToString(type, context, ts.TypeFormatFlags.NoTruncation);
    const awaited = checker.getAwaitedType(type);
    if (awaited && awaited !== type)
      return `Promise<${render(awaited, `${hint}Result`)}>`;
    if (checker.isArrayType(type)) {
      const [element] = checker.getTypeArguments(type as ts.TypeReference);
      return `Array<${render(element, `${hint}Item`)}>`;
    }
    if (type.isUnion() && !type.aliasSymbol)
      return [...new Set(type.types.map(part => render(part, hint)))].join(" | ");
    const existing = names.get(type);
    if (existing) {
      refs.add(existing);
      return existing;
    }
    const symbol = type.aliasSymbol ?? type.getSymbol();
    const candidate = symbol?.name;
    let name = candidate && !candidate.startsWith("__") && !structuralTypeNames.has(candidate) ? candidate : safeName(hint);
    const base = name;
    let suffix = 2;
    while (types[name]) name = `${base}${suffix++}`;
    names.set(type, name);
    refs.add(name);
    types[name] = { definition: "", description: description(symbol), relatedTypes: [] };
    pending.push({ name, type });
    return name;
  }

  function signature(signature: ts.Signature, path: string): string {
    const params = signature.getParameters().map((param) => {
      const declaration = param.valueDeclaration ?? signature.declaration ?? context;
      const optional = (param.flags & ts.SymbolFlags.Optional) !== 0
        || (ts.isParameter(declaration) && (declaration.questionToken !== undefined || declaration.initializer !== undefined));
      return `${param.name}${optional ? "?" : ""}: ${render(checker.getTypeOfSymbolAtLocation(param, declaration), `${path} ${param.name}`)}`;
    });
    return `(${params.join(", ")}): ${render(checker.getReturnTypeOfSignature(signature), `${path} result`)}`;
  }

  for (const entry of extraTypes) render(exportedType(entry).type, entry.symbol);
  const entries: ApiEntry[] = [];
  for (const { namespace, source, type } of roots) {
    const selected = namespace.members === undefined ? undefined : new Set(namespace.members);
    const unavailable = namespace.unavailable ?? {};
    const paths = [...(namespace.members ?? []), ...Object.keys(unavailable)];
    const found = new Set<string>();
    function walk(value: ts.Type, parent: string): void {
      for (const prop of checker.getPropertiesOfType(value)) {
        const relative = parent ? `${parent}.${prop.name}` : prop.name;
        const restriction = Object.hasOwn(unavailable, relative) ? unavailable[relative] : undefined;
        const nested = !restriction && (namespace.expand?.includes(relative)
          || paths.some((path) => path.startsWith(`${relative}.`)));
        if (!isPublic(prop) || (selected && !selected.has(relative) && !restriction && !nested)) continue;
        const path = `${namespace.namespace}.${relative}`;
        const declaration = prop.valueDeclaration ?? source;
        const member = checker.getTypeOfSymbolAtLocation(prop, declaration);
        if (nested) {
          walk(member, relative);
          continue;
        }
        refs.clear();
        const call = member.getCallSignatures()[0];
        let returns: ApiEntry["returns"];
        if (call && !restriction) {
          const result = checker.getAwaitedType(checker.getReturnTypeOfSignature(call))!;
          const collection = checker.isArrayType(result);
          const element = collection ? checker.getTypeArguments(result as ts.TypeReference)[0] : result;
          const projected = returned.get(element);
          if (projected) returns = { namespace: projected.namespace, ...(collection ? { collection: true } : {}) };
        }
        const detail = call
          ? restriction ? checker.signatureToString(call, source) : signature(call, path)
          : `: ${render(member, prop.name)}`;
        entries.push({
          description: description(prop),
          examples: [...(options.examples?.[path] ?? [])],
          path,
          relatedTypes: [...refs],
          ...(returns ? { returns } : {}),
          signature: `${path}${detail}`,
          ...(restriction ? { unavailable: restriction } : {}),
        });
        found.add(relative);
      }
    }
    walk(type, "");
    const missing = paths.filter((path) => !found.has(path));
    if (missing.length) throw new Error(`Unknown paths in ${namespace.namespace}: ${missing.join(", ")}`);
  }

  for (let index = 0; index < pending.length; index++) {
    const { name, type } = pending[index];
    refs.clear();
    // Enum unions otherwise print member imports without their wire values.
    const enumDeclaration = type.getSymbol()?.declarations?.find(ts.isEnumDeclaration);
    if (enumDeclaration) {
      const members = enumDeclaration.members.map((member) => {
        const value = checker.getConstantValue(member);
        const initializer = value === undefined ? member.initializer?.getText() : JSON.stringify(value);
        return `  ${member.name.getText()}${initializer === undefined ? "" : ` = ${initializer}`},`;
      });
      types[name].definition = `enum ${name} {\n${members.join("\n")}\n}`;
      continue;
    }
    let definition: string;
    if (type.isUnion()) {
      definition = type.types.map(part => render(part, `${name}Value`)).join(" | ");
    }
    else {
      const projection = returned.get(type);
      const fields = checker.getPropertiesOfType(type).filter((prop) =>
        isPublic(prop) && !omitTypeProperties.has(prop.name)
        && (projection?.members?.some((path) => path === prop.name || path.startsWith(`${prop.name}.`)) ?? true)
        && !Object.hasOwn(projection?.unavailable ?? {}, prop.name));
      const members = fields.map((prop) => {
        const declaration = prop.valueDeclaration ?? context;
        const value = checker.getTypeOfSymbolAtLocation(prop, declaration);
        const call = value.getCallSignatures()[0];
        const doc = description(prop).split(/\r?\n/)[0].slice(0, 200);
        const constant = ts.isEnumMember(declaration) ? checker.getConstantValue(declaration) : undefined;
        const valueText = constant !== undefined ? `: ${JSON.stringify(constant)}` : call ? signature(call, `${name} ${prop.name}`) : `: ${render(value, `${name} ${prop.name}`)}`;
        return `${doc ? `  /** ${doc} */\n` : ""}  ${prop.name}${prop.flags & ts.SymbolFlags.Optional ? "?" : ""}${valueText};`;
      });
      definition = `{\n${members.join("\n")}\n}`;
    }
    types[name].definition = `type ${name} = ${definition}`;
    types[name].relatedTypes = [...refs].filter(ref => ref !== name);
    if (pending.length > 1500)
      throw new Error(`SDK help reached too many related types at ${name}: ${pending.slice(-10).map(item => item.name).join(", ")}`);
  }

  return { entries: [...entries, ...(options.extraEntries ?? [])], types };
}
