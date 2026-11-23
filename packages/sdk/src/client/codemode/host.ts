import type { CodemodeTool } from "@earendil-works/pi-codemode/portable";
import { RpcSession, type RpcTarget } from "capnweb";
import capnwebSource from "./host-prelude.generated.js";

export type CodeModeHost = (signal: AbortSignal) => RpcTarget;

const sendName = "__exteriorRpcSend";
const receiveName = "__exteriorRpcReceive";

export const hostPrelude = `const host = (() => {
${capnwebSource}
return new capnweb.RpcSession({ send: ${sendName}, receive: ${receiveName} }).getRemoteMain();
})();`;

function createMailbox() {
  let controller!: ReadableStreamDefaultController<string>;
  const reader = new ReadableStream<string>({
    start(stream) { controller = stream; },
  }).getReader();

  return {
    send(message: string) { controller.enqueue(message); },
    async receive() {
      const entry = await reader.read();
      if (entry.done) throw new Error("Code Mode host session closed.");
      return entry.value;
    },
    fail(reason: unknown) { controller.error(reason); },
  };
}

export function createHostSession(createHost: CodeModeHost, runSignal: AbortSignal) {
  const lifetime = new AbortController();
  const localMain = createHost(AbortSignal.any([runSignal, lifetime.signal]));
  const fromSandbox = createMailbox();
  const toSandbox = createMailbox();
  const remoteMain = new RpcSession({
    receive: fromSandbox.receive,
    send: toSandbox.send,
    abort(reason: unknown) {
      runSignal.removeEventListener("abort", close);
      fromSandbox.fail(reason);
      toSandbox.fail(reason);
      lifetime.abort(reason);
    },
  }, localMain).getRemoteMain();

  function close() {
    remoteMain[Symbol.dispose]();
  }

  if (runSignal.aborted) close();
  else runSignal.addEventListener("abort", close, { once: true });

  const globals: CodemodeTool[] = [
    {
      name: sendName,
      execute(message) {
        if (typeof message !== "string") throw new TypeError("Expected a Code Mode RPC message.");
        fromSandbox.send(message);
      },
    },
    { name: receiveName, execute: toSandbox.receive },
  ];

  return { globals, close };
}
