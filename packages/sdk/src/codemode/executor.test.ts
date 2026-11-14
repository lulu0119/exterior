import { describe, expect, it, vi } from "vitest";

import { executeJavaScript } from "./executor.js";

describe("executeJavaScript", () => {
  it("uses synchronous handles and asynchronous host calls inside an isolated guest", async () => {
    const read = vi.fn(async (input: { id: bigint; optional?: string }) => input.id + 1n);
    const bindings = {
      api: {
        resolve: () => ({ read }),
      },
    };
    const outcome = await executeJavaScript({
      bindings,
      deferredBindings: ["api"],
      syncBindings: [bindings.api.resolve],
      code: `(async () => {
        const handle = api.resolve();
        text(await handle.read({ id: 9007199254740993n }));
        return [typeof fetch, typeof process, typeof require, typeof window];
      })()`,
    });
    expect(read).toHaveBeenCalledExactlyOnceWith({ id: 9007199254740993n });
    expect(outcome).toEqual({
      status: "ok",
      content: [
        { type: "text", text: '"9007199254740994"' },
        { type: "text", text: '["undefined","undefined","undefined","undefined"]' },
      ],
      store: {},
    });
  });

  it("retains partial output and rolls back the store when code fails", async () => {
    const store = { saved: { text: "old" } };
    const failed = await executeJavaScript({
      code: '(async () => { load("saved").text = "changed"; store("saved", "new"); text("partial"); throw new Error("expected"); })()',
      store,
    });
    expect(failed).toEqual({
      status: "error",
      message: "expected",
      content: [{ type: "text", text: "partial" }],
      store,
    });
    expect(store.saved.text).toBe("old");
    const success = await executeJavaScript({ code: 'store("saved", "new")', store });
    expect(success.store).toEqual({ saved: "new" });
    expect(store.saved.text).toBe("old");
  });

  it("cancels a waiting call and suppresses late image output", async () => {
    const controller = new AbortController();
    let resolveImage!: (image: { data: string; mimeType: string }) => void;
    let imageRequested!: () => void;
    const requested = new Promise<void>(resolve => { imageRequested = resolve; });
    const output = vi.fn();
    const store = { existing: true };
    const execution = executeJavaScript({
      code: '(async () => { text("before"); store("existing", false); await image("capture"); })()',
      image: () => {
        imageRequested();
        return new Promise(resolve => { resolveImage = resolve; });
      },
      signal: controller.signal,
      store,
      onOutput: output,
    });
    await requested;
    controller.abort();
    expect(await execution).toEqual({
      status: "stopped",
      reason: "canceled",
      content: [{ type: "text", text: "before" }],
      store,
    });
    resolveImage({ data: "YWJj", mimeType: "image/png" });
    await Promise.resolve();
    expect(output).toHaveBeenCalledExactlyOnceWith({ type: "text", text: "before" });
  });

  it("checks cancellation before dispatching a deferred effect", async () => {
    const controller = new AbortController();
    const effect = vi.fn();
    const outcome = await executeJavaScript({
      code: '(() => { effect(); text("stop"); })()',
      bindings: { effect },
      deferredBindings: ["effect"],
      signal: controller.signal,
      onOutput: () => controller.abort(),
    });
    expect(outcome).toMatchObject({ status: "stopped", reason: "canceled" });
    expect(effect).not.toHaveBeenCalled();
  });

  it("rolls back state if the caller cancels while receiving final output", async () => {
    const controller = new AbortController();
    const outcome = await executeJavaScript({
      code: '(() => { store("saved", 1); return "done"; })()',
      signal: controller.signal,
      onOutput: () => controller.abort(),
    });
    expect(outcome).toEqual({
      status: "stopped",
      reason: "canceled",
      content: [{ type: "text", text: "done" }],
      store: {},
    });
  });

  it("enforces the same timeout for guest CPU work and pending promises", async () => {
    await expect(executeJavaScript({ code: "while (true) {}", timeoutMs: 50 })).resolves.toMatchObject({
      status: "stopped",
      reason: "timeout",
    });
    await expect(executeJavaScript({ code: "new Promise(() => {})", timeoutMs: 50 })).resolves.toMatchObject({
      status: "stopped",
      reason: "timeout",
    });
  });

  it("reports a guest-thrown promise as an error and can run again", async () => {
    const outcome = await executeJavaScript({ code: "throw Promise.resolve(42)" });
    expect(outcome).toMatchObject({ status: "error", message: "Code threw an exception." });
    await expect(executeJavaScript({ code: "42" })).resolves.toMatchObject({ status: "ok" });
  });

  it("bounds explicit image output and keeps its bytes outside the guest", async () => {
    const image = vi.fn(async (reference: unknown) => ({
      data: reference === "too-large" ? "x".repeat(512_001) : "YWJj",
      mimeType: "image/png",
    }));
    const outcome = await executeJavaScript({
      code: '(async () => { text(typeof await image("small")); await image("too-large"); })()',
      image,
    });
    expect(outcome).toEqual({
      status: "error",
      message: "Code image output exceeds its limit.",
      content: [{ type: "image", data: "YWJj", mimeType: "image/png" }, { type: "text", text: "undefined" }],
      store: {},
    });
  });

  it("summarizes instrumentation values inside the guest", async () => {
    const report = vi.fn();
    const outcome = await executeJavaScript({
      code: '__report(2, { select() {}, id: 7 })',
      bindings: { __report: report },
      inspect: {
        binding: "__report",
        serialize: '(value) => Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== "function"))',
      },
    });
    expect(outcome.status).toBe("ok");
    expect(report).toHaveBeenCalledExactlyOnceWith(2, { id: 7 });
  });

  it("preserves data property names and rejects functions and accessors", async () => {
    const mirror = vi.fn((value: unknown) => value);
    const code = `(() => {
      const guest = mirror(JSON.parse('{"__proto__":{"safe":true}}'));
      text(Object.hasOwn(guest, "__proto__"));
      return mirror({ get hidden() { return 4; } });
    })()`;
    const outcome = await executeJavaScript({ code, bindings: { mirror } });
    expect(mirror).toHaveBeenCalledExactlyOnceWith(JSON.parse('{"__proto__":{"safe":true}}'));
    expect(outcome).toMatchObject({
      status: "error",
      message: "Accessors cannot cross the sandbox boundary.",
      content: [{ type: "text", text: "true" }],
    });
    await expect(executeJavaScript({ code: "text({ hidden() {} })" })).resolves.toMatchObject({
      status: "error",
      message: expect.stringMatching(/Only data/),
    });
  });

  it("round-trips NULs and unmatched surrogates in keys and strings", async () => {
    const value = { ["before\u0000after"]: "\uD800" };
    const mirror = vi.fn((data: unknown) => data);
    const outcome = await executeJavaScript({
      code: 'mirror({ "before\\u0000after": "\\uD800" })',
      bindings: { mirror },
    });
    expect(mirror).toHaveBeenCalledExactlyOnceWith(value);
    expect(outcome).toEqual({ status: "ok", content: [{ type: "text", text: JSON.stringify(value) }], store: {} });
  });
});
