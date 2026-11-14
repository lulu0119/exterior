import tsBlankSpace from "ts-blank-space";
import ts from "typescript";

/** Compiles a REPL cell with top-level await, return, and persistent declarations. */
export function compileTypeScript(source: string): { code: string; prelude: string } {
  const code = tsBlankSpace(source, () => {
    throw new SyntaxError("Only erasable TypeScript syntax is supported in Code Mode.");
  });
  const file = ts.createSourceFile("cell.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = new Set<string>();
  const functions: string[] = [];
  const statements: string[] = [];
  let offset = 0;

  for (const statement of file.statements) {
    statements.push(code.slice(offset, statement.getStart(file)));
    offset = statement.end;
    if (ts.isVariableStatement(statement)) {
      for (const { name, initializer } of statement.declarationList.declarations) {
        collectNames(name, names);
        statements.push(`void (${name.getText(file)} = ${initializer?.getText(file) ?? "undefined"});`);
      }
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
      statements.push(`${statement.name.text} = ${statement.getText(file)};`);
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      names.add(name);
      functions.push(`globalThis[${JSON.stringify(name)}] = ${name};`);
      statements.push(statement.getText(file));
    } else if (ts.isExpressionStatement(statement) && statement === file.statements.at(-1)) {
      statements.push(`return (${statement.expression.getText(file)});`);
    } else {
      statements.push(statement.getText(file));
    }
  }
  statements.push(code.slice(offset));
  return {
    code: `(async () => {\n${functions.join("\n")}\n${statements.join("\n")}\n})()`,
    prelude: names.size ? `var ${[...names].join(", ")};` : "",
  };
}

function collectNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectNames(element.name, names);
  }
}
