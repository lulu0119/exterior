import { randomBytes, randomUUID } from "node:crypto";
import { readRequestBody } from "@modelcontextprotocol/server";
import { mcpFrameBytes, parseJson, parseMcpFrame, type McpFrame, type McpSocketCloseReason } from "../index.js";

const ticketTtlMs = 60_000;

/** The page's socket for one endpoint. */
export type McpSocket = { send(frame: string): void; close(reason: McpSocketCloseReason | "invalid_message"): void };
/** What the socket's handler tells the endpoints. */
export type McpSocketLink = { frame(frame: string): void; closed(): void };

type Exchange = { reply(frame: McpFrame): void; fail(): void };

type Endpoint = {
  userId: string;
  clientId: string;
  ticket: string;
  token: string;
  socket?: McpSocket;
  exchanges: Map<string, Exchange>;
  timer: ReturnType<typeof setTimeout>;
};

export type McpEndpoints = {
  /** A client opened an endpoint. The page dials `ticket` to serve it; an agent sends `token` as its bearer token. */
  open(input: { userId: string; clientId: string }): { ticket: string; token: string };
  /** A page dialed a ticket. Dialing consumes it; undefined when it is used, expired or unknown. */
  acceptSocket(ticket: string, socket: McpSocket): McpSocketLink | undefined;
  /** An agent's MCP request. Answered 404 unless `token` names an endpoint whose page is connected. */
  handle(token: string, request: Request): Promise<Response>;
  /** The account revoked the client: its endpoints close with `revoked`. */
  revokeClient(input: { userId: string; clientId: string }): void;
};

export function createMcpEndpoints(): McpEndpoints {
  const byTicket = new Map<string, Endpoint>();
  const byToken = new Map<string, Endpoint>();

  function drop(endpoint: Endpoint): void {
    clearTimeout(endpoint.timer);
    byTicket.delete(endpoint.ticket);
    byToken.delete(endpoint.token);
    endpoint.socket = undefined;
    for (const exchange of endpoint.exchanges.values()) exchange.fail();
  }

  return {
    open({ userId, clientId }) {
      const endpoint: Endpoint = {
        userId,
        clientId,
        ticket: randomBytes(32).toString("base64url"),
        token: randomBytes(32).toString("base64url"),
        exchanges: new Map(),
        timer: setTimeout(() => drop(endpoint), ticketTtlMs),
      };
      byTicket.set(endpoint.ticket, endpoint);
      return { ticket: endpoint.ticket, token: endpoint.token };
    },

    acceptSocket(ticket, socket) {
      const endpoint = byTicket.get(ticket);
      if (!endpoint) return undefined;
      byTicket.delete(ticket);
      clearTimeout(endpoint.timer);
      endpoint.socket = socket;
      byToken.set(endpoint.token, endpoint);
      return {
        frame(text) {
          const frame = parseMcpFrame(parseJson(text));
          if (!frame || frame.type === "request" || frame.type === "cancel" || frame.type === "pull") {
            socket.close("invalid_message");
            return;
          }
          endpoint.exchanges.get(frame.exchange)?.reply(frame);
        },
        closed() {
          drop(endpoint);
        },
      };
    },

    async handle(token, request) {
      const endpoint = byToken.get(token);
      if (!endpoint?.socket) return notFound();
      return forwardRequest(endpoint, request);
    },

    revokeClient({ userId, clientId }) {
      for (const endpoint of new Set([...byTicket.values(), ...byToken.values()])) {
        if (endpoint.userId !== userId || endpoint.clientId !== clientId) continue;
        endpoint.socket?.close("revoked");
        drop(endpoint);
      }
    },
  };
}

async function forwardRequest(endpoint: Endpoint, request: Request): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const body = await readRequestBody(request);
  if (body.tooLarge) return new Response(null, { status: 413 });
  const socket = endpoint.socket;
  if (!socket) return notFound();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (key === "accept" || key === "content-type" || key.startsWith("mcp-")) headers[key] = value;
  });
  const exchange = randomUUID();
  const frame: McpFrame = { type: "request", exchange, headers, body: body.text };
  const text = JSON.stringify(frame);
  if (Buffer.byteLength(text) > mcpFrameBytes) return new Response(null, { status: 413 });
  return new Promise<Response>((resolve) => {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    let pulled: (() => void) | undefined;
    const send = (type: "pull" | "cancel") => endpoint.socket?.send(JSON.stringify({ exchange, type }));
    const finish = () => {
      endpoint.exchanges.delete(exchange);
      request.signal.removeEventListener("abort", cancel);
      pulled?.();
    };
    const fail = () => {
      finish();
      stream?.error(new Error("The page serving this MCP request closed."));
      resolve(new Response(null, { status: 502 }));
    };
    const cancel = () => {
      send("cancel");
      finish();
      stream?.close();
      resolve(new Response(null, { status: 502 }));
    };
    endpoint.exchanges.set(exchange, {
      fail,
      reply(frame) {
        if (frame.type === "response") {
          if (stream) return fail();
          const headers = { "content-type": frame.contentType, "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
          if (!frame.hasBody || [204, 205, 304].includes(frame.status)) {
            finish();
            resolve(new Response(null, { status: frame.status, headers }));
            return;
          }
          const body = new ReadableStream<Uint8Array>({
            start(controller) { stream = controller; },
            pull() {
              return new Promise<void>((resolve) => {
                pulled = resolve;
                send("pull");
              });
            },
            cancel() { stream = undefined; cancel(); },
          });
          resolve(new Response(body, { status: frame.status, headers }));
        } else if (frame.type === "data" && stream && pulled) {
          stream.enqueue(encoder.encode(frame.text));
          pulled();
          pulled = undefined;
        } else if (frame.type === "end" && stream) {
          stream.close();
          finish();
        } else {
          fail();
        }
      },
    });
    if (request.signal.aborted) return cancel();
    request.signal.addEventListener("abort", cancel, { once: true });
    socket.send(text);
  });
}

function notFound(): Response {
  return Response.json({ code: "target_not_found", message: "No MCP endpoint is served here. The page that served it may have closed." }, { status: 404 });
}
