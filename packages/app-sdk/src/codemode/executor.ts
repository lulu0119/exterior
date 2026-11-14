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

export interface ReplOptions {
  /** Host values and functions that survive for the lifetime of the REPL. */
  bindings?: Record<string, unknown>;
  /** Defer calls under these binding roots and recheck their cell before dispatch. */
  deferredBindings?: readonly string[];
  /** Preserve synchronous behavior for these functions under deferred binding roots. */
  syncBindings?: readonly ((...args: never[]) => unknown)[];
  /** Trusted guest serializer for values sent to an instrumentation binding. */
  inspect?: { binding: string; serialize: string };
}

export interface ReplCellOptions {
  /** Compiled JavaScript that evaluates to a value or a promise. */
  code: string;
  /** Trusted host code evaluated before the guest script. */
  prelude?: string;
  store?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Resolve an application-owned image reference into bounded output. */
  image?: (reference: unknown, options?: unknown) => Promise<CodeImage>;
  onOutput?: (item: CodeOutputItem) => void;
}

export interface CodeExecutionOptions extends ReplOptions, ReplCellOptions {}

export interface Repl {
  /** Runs one cell. A second cell receives a busy error while this one runs. */
  execute(options: ReplCellOptions): Promise<CodeExecutionResult>;
  /** Cancels the active cell, if any, and clears the guest heap. */
  reset(): void;
  /** Cancels the active cell and permanently closes the REPL. */
  close(): void;
}

interface Cell {
  options: ReplCellOptions;
  content: CodeOutputItem[];
  store: Record<string, unknown>;
  deadline: number;
  pending: Set<QuickJSDeferredPromise>;
  acceptsCalls: boolean;
  textCharacters: number;
  imageCharacters: number;
  imageCount: number;
  stopped?: "canceled" | "timeout";
  complete?: () => void;
  reject?: (error: unknown) => void;
}

let quickJS: Promise<QuickJSWASMModule> | undefined;

const maxOutputItems = 100;
const maxValueDepth = 20;
const maxValueEntries = 10_000;
const maxValueCharacters = 1_000_000;
const reservedBindings = new Set(["store", "load", "text", "show", "console", "image"]);
const stringWithSpecialCodeUnits = /[\0\uD800-\uDFFF]/u;

/** Runs a script in a new REPL and discards the guest heap afterward. */
export async function executeJavaScript(options: CodeExecutionOptions): Promise<CodeExecutionResult> {
  const repl = createRepl(options);
  try {
    return await repl.execute(options);
  } finally {
    repl.close();
  }
}

/**
 * Owns one QuickJS heap. Ordinary script errors keep changes to guest bindings.
 * Cancellation and timeouts discard the heap. The JSON store commits only on success.
 */
export function createRepl(options: ReplOptions = {}): Repl {
  let context: ReturnType<typeof createContext> | undefined;
  let active: Cell | undefined;
  let closed = false;

  function stop(cell: Cell, reason: "canceled" | "timeout"): void {
    if (!cell.stopped) cell.stopped = reason;
    cell.acceptsCalls = false;
    cell.reject?.(new Error("Code execution interrupted"));
  }

  function reset(): void {
    if (active) {
      stop(active, "canceled");
    } else {
      dispose();
    }
  }

  function dispose(): void {
    const liveContext = context;
    context = undefined;
    liveContext?.dispose();
  }

  return {
    async execute(cellOptions) {
      const { signal, timeoutMs = codeExecutionLimits.defaultTimeoutMs } = cellOptions;
      const initialStore = cellOptions.store ?? {};
      const content: CodeOutputItem[] = [];
      const error = (message: string): CodeExecutionResult => ({ status: "error", message, content, store: initialStore });
      if (closed) return error("Code REPL is closed.");
      if (active) return error("Another code cell is running.");
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > codeExecutionLimits.maxTimeoutMs) {
        return error(`timeoutMs must be an integer from 1 to ${codeExecutionLimits.maxTimeoutMs}.`);
      }
      if (signal?.aborted) return { status: "stopped", reason: "canceled", content, store: initialStore };

      const cell: Cell = {
        options: cellOptions,
        content,
        store: initialStore,
        deadline: Date.now() + timeoutMs,
        pending: new Set(),
        acceptsCalls: true,
        textCharacters: 0,
        imageCharacters: 0,
        imageCount: 0,
      };
      active = cell;
      const abort = () => stop(cell, "canceled");
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => stop(cell, "timeout"), timeoutMs);
      try {
        cell.store = structuredClone(initialStore);
        context ??= await openContext(options, cell, () => active);
        assertRunning(cell);
        await context.execute(cell);
        assertRunning(cell);
        return { status: "ok", content, store: cell.store };
      } catch (cause) {
        const reason = stopReason(cell);
        cell.stopped = reason;
        return reason ? { status: "stopped", reason, content, store: initialStore } : error(messageOf(cause));
      } finally {
        cell.acceptsCalls = false;
        cell.reject = undefined;
        cell.complete = undefined;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        for (const promise of cell.pending) promise.dispose();
        cell.pending.clear();
        const discard = cell.stopped || closed;
        active = undefined;
        if (discard) dispose();
      }
    },
    reset,
    close() {
      closed = true;
      reset();
    },
  };
}

function stopReason(cell: Cell): Cell["stopped"] {
  if (cell.stopped) return cell.stopped;
  if (cell.options.signal?.aborted) return "canceled";
  return Date.now() >= cell.deadline ? "timeout" : undefined;
}

function assertRunning(cell: Cell): void {
  const reason = stopReason(cell);
  if (reason) {
    cell.stopped = reason;
    throw new Error("Code execution interrupted");
  }
}

type Context = ReturnType<QuickJSWASMModule["newContext"]>;

async function openContext(options: ReplOptions, cell: Cell, current: () => Cell | undefined): Promise<ReturnType<typeof createContext>> {
  // The single-file browser variant embeds WASM, so bundled workers need no
  // package-relative asset or host filesystem access.
  const loading = quickJS ??= newQuickJSWASMModuleFromVariant(variant);
  const module = await loading.catch(error => {
    if (quickJS === loading) quickJS = undefined;
    throw error;
  });
  assertRunning(cell);
  const vm = module.newContext();
  try {
    return createContext(vm, options, current);
  } catch (error) {
    vm.dispose();
    throw error;
  }
}

function createContext(vm: Context, options: ReplOptions, current: () => Cell | undefined) {
  const { bindings = {}, deferredBindings = [], syncBindings = [], inspect } = options;
  const synchronous = new Set<unknown>(syncBindings);
  const guestFunctions: QuickJSHandle[] = [];

  function releaseGuestFunctions(): void {
    for (const handle of guestFunctions) handle.dispose();
  }

  vm.runtime.setMemoryLimit(codeExecutionLimits.memoryMiB * 1024 * 1024);
  vm.runtime.setMaxStackSize(512 * 1024);
  vm.runtime.setInterruptHandler(() => {
    const cell = current();
    return cell === undefined || stopReason(cell) !== undefined;
  });

  function useCell(): Cell {
    const cell = current();
    if (!cell?.acceptsCalls) throw new Error("The code cell has ended.");
    assertRunning(cell);
    return cell;
  }

  function canRespond(cell: Cell): boolean {
    return current() === cell && cell.acceptsCalls && !stopReason(cell);
  }

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

  function retain(code: string): QuickJSHandle {
    try {
      const handle = evaluate(code);
      guestFunctions.push(handle);
      return handle;
    } catch (error) {
      releaseGuestFunctions();
      throw error;
    }
  }

  // Capture intrinsics before running the script. Copy own data properties
  // without invoking accessors or toJSON.
  const descriptors = retain(`(() => {
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
  const isArray = retain("Array.isArray");
  const defineProperty = retain(`((define) => (object, key, value) =>
    define(object, key, { __proto__: null, value, writable: true, enumerable: true, configurable: true })
  )(Object.defineProperty)`);
  const stringify = retain("JSON.stringify");

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

  function readData(cell: Cell, values: readonly QuickJSHandle[]): unknown[] {
    let remaining = maxValueEntries;
    let characters = 0;
    function string(read: string): string {
      characters += read.length;
      if (characters > maxValueCharacters) throw new Error("Sandbox value contains too much text.");
      return read;
    }
    function read(handle: QuickJSHandle, depth: number): unknown {
      assertRunning(cell);
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

  function pump(cell: Cell): void {
    try {
      // Check for completion between guest jobs so detached jobs cannot send
      // host requests after the cell's returned promise settles.
      cell.complete?.();
      while (cell.acceptsCalls && vm.runtime.hasPendingJob()) {
        assertRunning(cell);
        const jobs = vm.runtime.executePendingJobs(1);
        if (jobs.error) throwGuestError(jobs.error);
        cell.complete?.();
      }
    } catch (error) {
      cell.reject?.(error);
    }
  }

  function defer(cell: Cell, result: PromiseLike<unknown>, deferred: boolean): QuickJSHandle {
    const promise = vm.newPromise();
    cell.pending.add(promise);
    const reject = (error: unknown) => {
      if (!canRespond(cell)) return;
      const guestError = error instanceof Error ? vm.newError(error) : vm.newError(String(error));
      useHandle(guestError, handle => {
        if (error instanceof Error && "rpcCode" in error && typeof error.rpcCode === "number") {
          vm.newNumber(error.rpcCode).consume(code => vm.setProp(handle, "rpcCode", code));
        }
        promise.reject(handle);
      });
    };
    void Promise.resolve(result).then(value => {
      if (!canRespond(cell)) return;
      try {
        useHandle(toVM(value, deferred), handle => { promise.resolve(handle); });
      } catch (error) {
        reject(error);
      }
    }, reject).finally(() => {
      if (!cell.pending.delete(promise)) return;
      promise.dispose();
      if (canRespond(cell)) pump(cell);
    }).catch(error => cell.reject?.(error));
    return promise.handle;
  }

  function toVM(value: unknown, deferred: boolean, depth = 0, receiver?: object): QuickJSHandle {
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
          const cell = useCell();
          const args = readData(cell, argumentsInGuest);
          if (deferred && !synchronous.has(value)) {
            const effect = Promise.resolve().then(() => {
              if (!canRespond(cell)) throw new Error("The code cell has ended.");
              return Reflect.apply(value, receiver, args);
            });
            return defer(cell, effect, deferred);
          }
          assertRunning(cell);
          const result: unknown = Reflect.apply(value, receiver, args);
          return isPromise(result) ? defer(cell, result, deferred) : toVM(result, deferred);
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

  function install(name: string, value: unknown, deferred = false, configurable = false): void {
    useHandle(toVM(value, deferred), handle => vm.defineProp(vm.global, name, { value: handle, configurable, enumerable: true }));
  }

  function text(cell: Cell, value: unknown): void {
    const output = typeof value === "string" ? value : JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item) ?? "undefined";
    if (cell.content.length >= maxOutputItems || cell.textCharacters + output.length > codeExecutionLimits.maxTextCharacters) {
      throw new Error(`Code output exceeds ${codeExecutionLimits.maxTextCharacters} characters or ${maxOutputItems} items.`);
    }
    cell.textCharacters += output.length;
    emit(cell, { type: "text", text: output });
  }

  function emit(cell: Cell, item: CodeOutputItem): void {
    assertRunning(cell);
    cell.content.push(item);
    cell.options.onOutput?.(item);
  }

  function dispose(): void {
    releaseGuestFunctions();
    try {
      vm.dispose();
    } catch (error) {
      // A failed WASM disposal invalidates this module instance.
      quickJS = undefined;
      throw error;
    }
  }

  try {
    for (const [name, binding] of Object.entries(bindings)) {
      if (reservedBindings.has(name)) throw new Error(`Sandbox binding "${name}" is reserved.`);
      // The serializer replaces the raw instrumentation callback below.
      install(name, binding, deferredBindings.includes(name), name === inspect?.binding);
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
          value: (id, value, ...context) => report(id, inspect(value), ...context),
          configurable: false,
        });
      }`).dispose();
    }

    const print = (value: unknown) => text(useCell(), value);
    install("text", print);
    install("show", print);
    install("console", { error: print, info: print, log: print, warn: print });
    install("store", (key: unknown, value: unknown) => {
      if (typeof key !== "string") throw new TypeError("store key must be a string");
      const cell = useCell();
      const next = { ...cell.store, [key]: value };
      if (value === undefined) delete next[key];
      if (JSON.stringify(next).length > codeExecutionLimits.maxStoreCharacters) {
        throw new RangeError(`Code store exceeds ${codeExecutionLimits.maxStoreCharacters} characters.`);
      }
      cell.store = next;
    });
    install("load", (key: unknown) => {
      if (typeof key !== "string") throw new TypeError("load key must be a string");
      const { store } = useCell();
      return Object.hasOwn(store, key) ? structuredClone(store[key]) : undefined;
    });
    const image = toVM(async (reference: unknown, imageOptions: unknown) => {
      const cell = useCell();
      if (!cell.options.image) throw new Error("This code cell cannot produce images.");
      const result = await cell.options.image(reference, imageOptions);
      if (!canRespond(cell)) return;
      // Keep image data and protocol framing below the ACP message budget.
      if (cell.content.length >= maxOutputItems || result.data.length > 512_000 || cell.imageCharacters + result.data.length > 750_000 || cell.imageCount >= 4) {
        throw new RangeError("Code image output exceeds its limit.");
      }
      cell.imageCharacters += result.data.length;
      cell.imageCount++;
      emit(cell, { ...result, type: "image" });
    }, true);
    guestFunctions.push(image);
    vm.defineProp(vm.global, "image", {
      get: () => current()?.options.image ? image.dup() : vm.undefined,
    });
  } catch (error) {
    releaseGuestFunctions();
    throw error;
  }

  return {
    async execute(cell: Cell): Promise<void> {
      try {
        if (cell.options.prelude) evaluate(cell.options.prelude).dispose();
        const evaluated = evaluate(cell.options.code);
        try {
          const result = await new Promise<QuickJSHandle>((resolve, reject) => {
            cell.reject = reject;
            assertRunning(cell);
            cell.complete = () => {
              assertRunning(cell);
              const state = vm.getPromiseState(evaluated);
              if (state.type === "pending") return;
              cell.complete = undefined;
              cell.acceptsCalls = false;
              if (state.type === "rejected") throwGuestError(state.error);
              resolve(state.notAPromise ? state.value.dup() : state.value);
            };
            pump(cell);
          });
          useHandle(result, value => {
            const [returned] = readData(cell, [value]);
            if (returned !== undefined) text(cell, returned);
          });
        } finally {
          evaluated.dispose();
        }
      } finally {
        cell.acceptsCalls = false;
        cell.complete = undefined;
        cell.reject = undefined;
        // Drain jobs queued by this cell with host calls revoked. Pending guest
        // promises explicitly resolved in a later cell run under that cell.
        while (!stopReason(cell) && vm.runtime.hasPendingJob()) {
          vm.runtime.executePendingJobs(1).error?.dispose();
        }
      }
    },
    dispose,
  };
}

function isPromise(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null && "then" in value && typeof value.then === "function";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
