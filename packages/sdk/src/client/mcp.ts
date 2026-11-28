import type { McpRequestContext, McpServer, McpServerFactory, ServerNotifier } from "@modelcontextprotocol/server";
import { closeReason, mcpEndpointsPath, mcpProtocolVersion, mcpSocketCloseCodes, parseJson, parseMcpFrame, type McpFrame, type McpSocketCloseReason } from "../index.js";
import { isRecord, originOf } from "../oauth.js";
import { relayError, RelayError } from "./oauth.js";

export async function createMcpApp({ name, version, skills, configure }: {
  name: string;
  version: string;
  skills?: Record<string, string | Uint8Array>;
  configure?: (server: McpServer, context: McpRequestContext) => void | Promise<void>;
}): Promise<McpServerFactory> {
  const { McpServer } = await import("@modelcontextprotocol/server");
  const catalog = skills && await import("@modelcontextprotocol/server/ext/skills").then(({ SkillsExtension, memorySkillFiles }) =>
    SkillsExtension.load(memorySkillFiles(skills), { strict: true }));
  return async (context) => {
    const server = new McpServer({ name, version });
    catalog?.attach(server);
    await configure?.(server, context);
    return server;
  };
}

/**
 * An MCP endpoint the page serves. Give an agent `url` and `headers` as an HTTP MCP server, such as an ACP
 * `mcpServers` entry of type `http`. It lives until `close` or until the socket closes; `closed` names the
 * relay's reason, or undefined for any other close.
 */
export type ServedMcp = {
  url: string;
  notify: ServerNotifier;
  headers: { name: string; value: string }[];
  closed: Promise<McpSocketCloseReason | undefined>;
  close(): void;
};

export async function serveMcp(
  relayUrl: string,
  accessToken: string,
  createServer: McpServerFactory,
  signal?: AbortSignal,
): Promise<ServedMcp> {
  const { createMcpHandler } = await import("@modelcontextprotocol/server");
  const response = await fetch(new URL(mcpEndpointsPath, originOf(relayUrl)), {
    method: "POST",
    credentials: "omit",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ protocolVersion: mcpProtocolVersion }),
    signal,
  });
  const body = parseJson(await response.text());
  if (!response.ok) throw relayError(response.status, body, "The relay did not open the MCP endpoint.");
  if (!isRecord(body) || typeof body.url !== "string" || typeof body.mcpUrl !== "string" || typeof body.token !== "string") {
    throw new RelayError("server_error", response.status, "The relay did not open the MCP endpoint.");
  }

  if (body.protocolVersion !== mcpProtocolVersion) throw new RelayError("server_error", response.status, `The relay must support MCP ${mcpProtocolVersion}.`);

  const handler = createMcpHandler(createServer, { legacy: "reject" });
  const mcpUrl = body.mcpUrl;
  const socket = new WebSocket(body.url);
  type Exchange = { controller: AbortController; reader?: ReadableStreamDefaultReader<string> };
  const exchanges = new Map<string, Exchange>();
  function send(frame: McpFrame) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }
  const closed = new Promise<McpSocketCloseReason | undefined>((resolve) => {
    socket.addEventListener("close", (event) => {
      for (const { controller } of exchanges.values()) controller.abort();
      exchanges.clear();
      void handler.close();
      resolve(closeReason(mcpSocketCloseCodes, event.code));
    });
  });
  async function receive(frame: McpFrame) {
    const { exchange } = frame;
    if (frame.type === "request") {
      const controller = new AbortController();
      const state: Exchange = { controller };
      exchanges.set(exchange, state);
      const response = await handler.fetch(new Request(mcpUrl, {
        method: "POST", headers: frame.headers, body: frame.body, signal: controller.signal,
      }));
      if (controller.signal.aborted) {
        await response.body?.cancel();
        return;
      }
      const type = response.headers.get("content-type")?.split(";")[0];
      if (response.body) {
        state.reader = responseChunks(response.body, controller.signal);
      }
      send({ type: "response", exchange, status: response.status, contentType: type === "text/event-stream" || type === "application/json" ? type : "text/plain", hasBody: !!state.reader });
      if (!state.reader) exchanges.delete(exchange);
    } else if (frame.type === "cancel") {
      exchanges.get(exchange)?.controller.abort();
      exchanges.delete(exchange);
    } else if (frame.type === "pull") {
      const reader = exchanges.get(exchange)?.reader;
      if (!reader) return;
      const chunk = await reader.read();
      if (chunk.done) {
        exchanges.delete(exchange);
        send({ type: "end", exchange });
      } else {
        send({ type: "data", exchange, text: chunk.value });
      }
    }
  }
  socket.addEventListener("message", (event) => {
    const frame = typeof event.data === "string" ? parseMcpFrame(parseJson(event.data)) : undefined;
    if (!frame || (frame.type !== "request" && frame.type !== "cancel" && frame.type !== "pull")) {
      socket.close(1008, "invalid_message");
      return;
    }
    if (frame.type === "request" && exchanges.has(frame.exchange)) return socket.close(1008, "invalid_message");
    void receive(frame).catch(() => {
      const state = exchanges.get(frame.exchange);
      if (!state) return;
      exchanges.delete(frame.exchange);
      state.controller.abort();
      send({ type: "error", exchange: frame.exchange });
    });
  });
  await new Promise<void>((resolve, reject) => {
    const abort = () => { socket.close(); reject(signal?.reason); };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    socket.addEventListener("open", () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, { once: true });
    void closed.then(() => {
      signal?.removeEventListener("abort", abort);
      reject(new Error("The relay closed the MCP socket."));
    });
  });
  return {
    url: body.mcpUrl,
    notify: handler.notify,
    headers: [{ name: "Authorization", value: `Bearer ${body.token}` }],
    closed,
    close: () => socket.close(1000),
  };
}

function responseChunks(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const decoder = new TextDecoder();
  const chunkBytes = 64 * 1024;
  return body.pipeThrough(new TransformStream<Uint8Array, string>({
    transform(bytes, output) {
      for (let start = 0; start < bytes.length; start += chunkBytes) {
        output.enqueue(decoder.decode(bytes.subarray(start, start + chunkBytes), { stream: true }));
      }
    },
    flush(output) {
      const tail = decoder.decode();
      if (tail) output.enqueue(tail);
    },
  }), { signal }).getReader();
}
