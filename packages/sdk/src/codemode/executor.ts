import variant from "@jitl/quickjs-singlefile-browser-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSWASMModule } from "quickjs-emscripten-core";

import { codeExecutionLimits } from "./limits.js";

type CodeImage = { data: string; mimeType: string };

export type CodeOutputItem = { type: "text"; text: string } | ({ type: "image" } & CodeImage);

export type CodeExecutionResult = {
  content: CodeOutputItem[];
  /** Commit this state after a successful call. */
  store: Record<string, unknown>;
} & (
  | { status: "ok" }
  | { status: "error"; message: string }
  | { status: "stopped"; reason: "canceled" | "timeout" }
);

export interface CodeExecutionOptions {
  /** Compiled JavaScript that evaluates to a value or a promise. */
  code: string;
  /** Trusted host code evaluated before the guest script. */
  prelude?: string;
  /** Host values and functions intentionally made visible to the guest. */
  bindings?: Record<string, unknown>;
  /** Defer calls under these binding roots and check cancellation before invoking them. */
  deferredBindings?: readonly string[];
  /** Preserve synchronous behavior for these functions under deferred binding roots. */
  syncBindings?: readonly ((...args: never[]) => unknown)[];
  /** Trusted guest-side serializer for values observed by an instrumentation binding. */
  inspect?: { binding: string; serialize: string };
  store?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Resolve an application-owned image reference into bounded output. Pixels stay in the host. */
  image?: (reference: unknown, options?: unknown) => Promise<CodeImage>;
  onOutput?: (item: CodeOutputItem) => void;
}

let quickJS: Promise<QuickJSWASMModule> | undefined;

const maxOutputItems = 100;
const maxValueDepth = 20;
const maxValueEntries = 10_000;
const maxValueCharacters = 1_000_000;
const reservedBindings = new Set(["store", "load", "text", "show", "console", "image"]);
const stringWithSpecialCodeUnits = /[\0\uD800-\uDFFF]/u;

/** Runs code in a fresh QuickJS context with no filesystem, network, or module loader. */
export async function executeJavaScript(options: CodeExecutionOptions): Promise<CodeExecutionResult> {
  const { signal, image, onOutput, prelude, inspect, bindings = {}, deferredBindings = [], syncBindings = [] } = options;
  const initialStore = options.store ?? {};
  const content: CodeOutputItem[] = [];
  const timeoutMs = options.timeoutMs ?? codeExecutionLimits.defaultTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > codeExecutionLimits.maxTimeoutMs) {
    return { status: "error", message: `timeoutMs must be an integer from 1 to ${codeExecutionLimits.maxTimeoutMs}.`, content, store: initialStore };
  }
  if (signal?.aborted) return { status: "stopped", reason: "canceled", content, store: initialStore };
  const deadline = Date.now() + timeoutMs;
  const interrupted = () => signal?.aborted === true || Date.now() >= deadline;

  // The single-file browser variant embeds WASM, so bundled workers need no
  // package-relative asset or host filesystem access.
  let vm: ReturnType<QuickJSWASMModule["newContext"]>;
  try {
    const module = await (quickJS ??= newQuickJSWASMModuleFromVariant(variant));
    vm = module.newContext();
  } catch (error) {
    quickJS = undefined;
    return { status: "error", message: messageOf(error), content, store: initialStore };
  }
  const assertRunning = () => {
    if (closed || interrupted()) throw new Error("Code execution interrupted");
  };
  let store = initialStore;
  let textCharacters = 0;
  let imageCharacters = 0;
  let imageCount = 0;
  let closed = false;
  let fail: ((error: unknown) => void) | undefined;
  let checkResult: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<QuickJSDeferredPromise>();
  const handles: QuickJSHandle[] = [];
  const synchronous = new Set<unknown>(syncBindings);
  const abort = () => fail?.(new Error("Code execution interrupted"));

  function useHandle<T>(handle: QuickJSHandle, read: (handle: QuickJSHandle) => T): T {
    try {
      return read(handle);
    } finally {
      handle.dispose();
    }
  }

  function throwGuestError(handle: QuickJSHandle): never {
    // QuickJS dump() consumes promise handles. Avoid it on a thrown promise
    // and read other exceptions without serializing untrusted properties.
    const message = useHandle(handle, error => {
      const type = vm.typeof(error);
      if (type === "string" || type === "bigint" || type === "number" || type === "boolean" || type === "undefined") {
        return vm.getString(error);
      }
      if (type === "object" && !vm.eq(error, vm.null)) {
        return useHandle(vm.getProp(error, "message"), detail => vm.typeof(detail) === "string" ? vm.getString(detail) : undefined);
      }
      return undefined;
    });
    throw new Error(message ?? "Code threw an exception.");
  }

  function evaluate(code: string): QuickJSHandle {
    const result = vm.evalCode(code);
    if (result.error) throwGuestError(result.error);
    return result.value;
  }

  try {
    assertRunning();
    vm.runtime.setMemoryLimit(codeExecutionLimits.memoryMiB * 1024 * 1024);
    vm.runtime.setMaxStackSize(512 * 1024);
    vm.runtime.setInterruptHandler(interrupted);
    store = structuredClone(initialStore);

    // Capture intrinsics before running the script. Copy own data properties
    // without invoking accessors or toJSON.
    const descriptors = evaluate(`(() => {
      const { entries, getOwnPropertyDescriptors, getPrototypeOf, hasOwn } = Object;
      const objectPrototype = Object.prototype;
      const isArray = Array.isArray;
      return value => {
        const array = isArray(value);
        const prototype = getPrototypeOf(value);
        if (!array && prototype !== objectPrototype && prototype !== null)
          throw new TypeError("Only plain data can cross the sandbox boundary.");
        const own = getOwnPropertyDescriptors(value);
        if (array && own.length.value > ${maxValueEntries})
          throw new RangeError("Array is too large to pass to the host.");
        const properties = entries(own);
        for (let i = 0; i < properties.length; i++) {
          const descriptor = properties[i][1];
          if (descriptor.enumerable && !hasOwn(descriptor, "value"))
            throw new TypeError("Accessors cannot cross the sandbox boundary.");
        }
        return properties;
      };
    })()`);
    handles.push(descriptors);
    const isArray = evaluate("Array.isArray");
    handles.push(isArray);
    const defineProperty = evaluate(`((define) => (object, key, value) =>
      define(object, key, { __proto__: null, value, writable: true, enumerable: true, configurable: true })
    )(Object.defineProperty)`);
    handles.push(defineProperty);
    const stringify = evaluate("JSON.stringify");
    handles.push(stringify);

    function readString(handle: QuickJSHandle): string {
      // QuickJS's direct string bridge uses a NUL-terminated UTF-8 buffer.
      // A JSON string preserves NULs and unmatched UTF-16 surrogates.
      return useHandle(vm.unwrapResult(vm.callFunction(stringify, vm.undefined, handle)), value => JSON.parse(vm.getString(value)) as string);
    }

    function writeString(value: string): QuickJSHandle {
      if (!stringWithSpecialCodeUnits.test(value)) return vm.newString(value);
      const literal = JSON.stringify(value).replace(/[\uD800-\uDFFF]/g, character => `\\u${character.charCodeAt(0).toString(16)}`);
      return evaluate(literal);
    }

    function readData(values: readonly QuickJSHandle[]): unknown[] {
      let remaining = maxValueEntries;
      let characters = 0;
      function string(read: string): string {
        characters += read.length;
        if (characters > maxValueCharacters) throw new Error("Sandbox value contains too much text.");
        return read;
      }
      function read(handle: QuickJSHandle, depth: number): unknown {
        assertRunning();
        if (--remaining < 0 || depth > maxValueDepth) throw new Error("Sandbox value is too large or deeply nested.");
        switch (vm.typeof(handle)) {
          case "undefined": return undefined;
          case "boolean": return vm.eq(handle, vm.true);
          case "number": return vm.getNumber(handle);
          case "string": return string(readString(handle));
          case "bigint": return BigInt(string(vm.getString(handle)));
          case "function":
          case "symbol":
            throw new TypeError("Only data can cross the sandbox boundary. Select fields instead of returning functions or handles.");
          default:
            if (vm.eq(handle, vm.null)) return null;
        }
        const array = vm.unwrapResult(vm.callFunction(isArray, vm.undefined, handle)).consume(value => vm.eq(value, vm.true));
        const result: Record<string, unknown> | unknown[] = array ? [] : {};
        const properties = vm.unwrapResult(vm.callFunction(descriptors, vm.undefined, handle));
        try {
          const length = vm.getLength(properties) ?? 0;
          if (length > remaining) throw new Error("Sandbox value has too many properties.");
          for (let index = 0; index < length; index++) {
            useHandle(vm.getProp(properties, index), pair => {
              const key = string(useHandle(vm.getProp(pair, 0), readString));
              useHandle(vm.getProp(pair, 1), descriptor => {
                const enumerable = vm.getProp(descriptor, "enumerable").consume(value => vm.eq(value, vm.true));
                if (array && key === "length") {
                  (result as unknown[]).length = vm.getProp(descriptor, "value").consume(vm.getNumber);
                } else if (enumerable) {
                  const value = useHandle(vm.getProp(descriptor, "value"), child => read(child, depth + 1));
                  Object.defineProperty(result, key, { configurable: true, enumerable: true, value, writable: true });
                }
              });
            });
          }
          return result;
        } finally {
          properties.dispose();
        }
      }
      return values.map(handle => read(handle, 0));
    }

    function pump(): void {
      try {
        const jobs = vm.runtime.executePendingJobs();
        if (jobs.error) throwGuestError(jobs.error);
        checkResult?.();
      } catch (error) {
        fail?.(error);
      }
    }

    function defer(result: PromiseLike<unknown>, deferred: boolean): QuickJSHandle {
      const promise = vm.newPromise();
      pending.add(promise);
      const reject = (error: unknown) => {
        if (closed || interrupted()) return;
        const guestError = error instanceof Error ? vm.newError(error) : vm.newError(String(error));
        useHandle(guestError, handle => {
          if (error instanceof Error && "rpcCode" in error && typeof error.rpcCode === "number") {
            vm.newNumber(error.rpcCode).consume(code => vm.setProp(handle, "rpcCode", code));
          }
          promise.reject(handle);
        });
      };
      void Promise.resolve(result).then(value => {
        if (closed || interrupted()) return;
        try {
          useHandle(toVM(value, deferred), handle => { promise.resolve(handle); });
        } catch (error) {
          reject(error);
        }
      }, reject).finally(() => {
        if (closed) return;
        promise.dispose();
        pending.delete(promise);
        pump();
      }).catch(error => fail?.(error));
      return promise.handle;
    }

    function toVM(value: unknown, deferred: boolean, depth = 0, receiver?: object): QuickJSHandle {
      assertRunning();
      if (depth > maxValueDepth) throw new Error("Host value is too deeply nested.");
      if (value === null) return vm.null;
      switch (typeof value) {
        case "undefined": return vm.undefined;
        case "boolean": return value ? vm.true : vm.false;
        case "number": return vm.newNumber(value);
        case "string": return writeString(value);
        case "bigint": return vm.newBigInt(value);
        case "function":
          return vm.newFunction(value.name, (...argumentsInGuest) => {
            const args = readData(argumentsInGuest);
            if (deferred && !synchronous.has(value)) {
              const effect = Promise.resolve().then(() => {
                assertRunning();
                return Reflect.apply(value, receiver, args);
              });
              return defer(effect, deferred);
            }
            assertRunning();
            const result: unknown = Reflect.apply(value, receiver, args);
            return isPromise(result) ? defer(result, deferred) : toVM(result, deferred);
          });
        case "object":
          break;
        default:
          throw new TypeError("Unsupported host value.");
      }

      // TODO(codemode-streams): stream adapters need explicit cancellation and
      // backpressure semantics before iterators can enter a guest.
      if (Symbol.asyncIterator in value) throw new TypeError("Async iterators cannot cross the sandbox boundary.");
      if (ArrayBuffer.isView(value) && value.byteLength > 4096) throw new RangeError("Host byte array is too large for the sandbox. Use an application-owned resource reference.");

      const array = Array.isArray(value) || ArrayBuffer.isView(value);
      const handle = array ? vm.newArray() : vm.newObject();
      try {
        for (const [key, item] of Object.entries(value)) {
          useHandle(writeString(key), name => {
            useHandle(toVM(item, deferred, depth + 1, value), child => {
              vm.unwrapResult(vm.callFunction(defineProperty, vm.undefined, handle, name, child)).dispose();
            });
          });
        }
        if (Array.isArray(value)) {
          vm.newNumber(value.length).consume(length => vm.setProp(handle, "length", length));
        }
        return handle;
      } catch (error) {
        handle.dispose();
        throw error;
      }
    }

    function install(name: string, value: unknown, deferred = false): void {
      useHandle(toVM(value, deferred), handle => vm.defineProp(vm.global, name, { value: handle, configurable: true, enumerable: true }));
    }

    function text(value: unknown): void {
      const output = typeof value === "string" ? value : JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item) ?? "undefined";
      if (content.length >= maxOutputItems || textCharacters + output.length > codeExecutionLimits.maxTextCharacters) {
        throw new Error(`Code output exceeds ${codeExecutionLimits.maxTextCharacters} characters or ${maxOutputItems} items.`);
      }
      textCharacters += output.length;
      emit({ type: "text", text: output });
    }

    function emit(item: CodeOutputItem): void {
      assertRunning();
      content.push(item);
      onOutput?.(item);
    }

    for (const [name, binding] of Object.entries(bindings)) {
      if (reservedBindings.has(name)) throw new Error(`Sandbox binding "${name}" is reserved.`);
      install(name, binding, deferredBindings.includes(name));
    }
    if (inspect) {
      if (!Object.hasOwn(bindings, inspect.binding) || typeof bindings[inspect.binding] !== "function") {
        throw new Error("Inspection requires a host function binding.");
      }
      const name = JSON.stringify(inspect.binding);
      evaluate(`{
        const inspect = (${inspect.serialize});
        const report = globalThis[${name}];
        Object.defineProperty(globalThis, ${name}, {
          value: (id, value) => report(id, inspect(value)),
          configurable: false,
        });
      }`).dispose();
    }
    install("store", (key: unknown, value: unknown) => {
      if (typeof key !== "string") throw new TypeError("store key must be a string");
      const next = { ...store, [key]: value };
      if (value === undefined) delete next[key];
      if (JSON.stringify(next).length > codeExecutionLimits.maxStoreCharacters) {
        throw new RangeError(`Code store exceeds ${codeExecutionLimits.maxStoreCharacters} characters.`);
      }
      store = next;
    });
    install("load", (key: unknown) => {
      if (typeof key !== "string") throw new TypeError("load key must be a string");
      return Object.hasOwn(store, key) ? structuredClone(store[key]) : undefined;
    });
    install("text", text);
    install("show", text);
    install("console", { error: text, info: text, log: text, warn: text });
    if (image) {
      install("image", async (reference: unknown, imageOptions: unknown) => {
        const result = await image(reference, imageOptions);
        // Keep image data and protocol framing below the ACP message budget.
        if (content.length >= maxOutputItems || result.data.length > 512_000 || imageCharacters + result.data.length > 750_000 || imageCount >= 4) {
          throw new RangeError("Code image output exceeds its limit.");
        }
        imageCharacters += result.data.length;
        imageCount++;
        emit({ ...result, type: "image" });
      }, true);
    }

    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
    if (prelude) evaluate(prelude).dispose();
    const evaluated = evaluate(options.code);
    try {
      const result = await new Promise<QuickJSHandle>((resolve, reject) => {
        fail = reject;
        assertRunning();
        checkResult = () => {
          assertRunning();
          const state = vm.getPromiseState(evaluated);
          if (state.type === "pending") return;
          checkResult = undefined;
          if (state.type === "rejected") {
            throwGuestError(state.error);
          } else {
            resolve(state.notAPromise ? state.value.dup() : state.value);
          }
        };
        pump();
      });
      useHandle(result, value => {
        const [returned] = readData([value]);
        if (returned !== undefined) text(returned);
      });
      assertRunning();
      return { status: "ok", content, store };
    } finally {
      evaluated.dispose();
    }
  } catch (error) {
    if (interrupted()) {
      return { status: "stopped", reason: signal?.aborted ? "canceled" : "timeout", content, store: initialStore };
    }
    return { status: "error", message: messageOf(error), content, store: initialStore };
  } finally {
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    for (const promise of pending) promise.dispose();
    for (const handle of handles) handle.dispose();
    try {
      vm.dispose();
    } catch (error) {
      // A failed WASM disposal invalidates this module instance. A later run
      // must initialize a fresh instance.
      quickJS = undefined;
      throw error;
    }
  }
}

function isPromise(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null && "then" in value && typeof value.then === "function";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
