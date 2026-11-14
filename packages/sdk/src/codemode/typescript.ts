import tsBlankSpace from "ts-blank-space";

/** Compiles a script body with top-level await and return into an async expression for the executor. */
export function compileTypeScript(source: string): string {
  const code = tsBlankSpace(source, () => {
    throw new SyntaxError("Only erasable TypeScript syntax is supported in Code Mode.");
  });
  return `(async () => {\n${code}\n})()`;
}
