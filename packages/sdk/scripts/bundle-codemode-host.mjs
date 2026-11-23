import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const license = await readFile(new URL("../LICENSE.txt", import.meta.resolve("capnweb")), "utf8");
const { outputFiles: [bundle] } = await build({
  stdin: {
    contents: 'export { RpcSession } from "capnweb";',
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
  },
  bundle: true,
  format: "iife",
  globalName: "capnweb",
  minify: true,
  platform: "neutral",
  target: "es2022",
  write: false,
});

const source = `/*\n${license.trim()}\n*/\n${bundle.text}`;
await writeFile(
  new URL("../src/client/codemode/host-prelude.generated.ts", import.meta.url),
  `const capnwebSource: string = ${JSON.stringify(source)};\nexport default capnwebSource;\n`,
);
