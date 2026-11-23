import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { expect, it, vi } from "vitest";
import { createCodeModeSandbox, RpcTarget, type RpcStub } from "./index.js";

it("exchanges bytes and callbacks through an open host stream", async () => {
  type Decide = (value: Uint8Array) => Promise<boolean>;
  const disposeScan = vi.fn();

  class Scan extends RpcTarget {
    #decide: RpcStub<Decide>;

    constructor(decide: RpcStub<Decide>) {
      super();
      this.#decide = decide.dup();
    }

    async send(bytes: Uint8Array) {
      if (!(bytes instanceof Uint8Array)) throw new Error("Expected bytes.");
      for (const value of bytes) {
        if (await this.#decide(Uint8Array.of(value))) return Uint8Array.of(value, bytes.length);
      }
    }

    [Symbol.dispose]() {
      this.#decide[Symbol.dispose]();
      disposeScan();
    }
  }

  class Reports extends RpcTarget {
    openScan(decide: RpcStub<Decide>) { return new Scan(decide); }
    count() { return 3; }
  }

  const sandbox = createCodeModeSandbox({
    createSandbox: (options) => new CodemodeSandbox(options),
    host: () => new Reports(),
  });
  const result = await sandbox.execute(`
    const updates = [];
    const scan = await host.openScan(value => {
      if (!(value instanceof Uint8Array)) throw new Error("Expected bytes.");
      updates.push(value[0]);
      return value[0] >= 7;
    });
    const [match, count] = await Promise.all([scan.send(Uint8Array.of(2, 7, 9)), host.count()]);
    return { bytes: Array.from(match), binary: match instanceof Uint8Array, count, updates };
  `);
  expect(result).toMatchObject({ ok: true, value: { bytes: [7, 3], binary: true, count: 3, updates: [2, 7] } });
  expect(disposeScan).toHaveBeenCalledOnce();
});

it.each(["aborted", "timeout"] as const)("stops pending host work on %s", async (kind) => {
  const controller = new AbortController();
  const started = vi.fn();
  const stopped = vi.fn();
  const sandbox = createCodeModeSandbox({
    createSandbox: (options) => new CodemodeSandbox(options),
    host(signal) {
      class Reports extends RpcTarget {
        wait() {
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              stopped();
              reject(signal.reason);
            }, { once: true });
            started();
          });
        }
      }
      return new Reports();
    },
  });
  const pending = sandbox.execute("await host.wait();", {
    signal: controller.signal,
    timeoutMs: kind === "timeout" ? 1_000 : 5_000,
  });
  if (kind === "aborted") {
    await expect.poll(() => started.mock.calls.length).toBe(1);
    controller.abort();
  }

  expect(await pending).toMatchObject({ ok: false, error: { kind } });
  expect(stopped).toHaveBeenCalledOnce();
});
