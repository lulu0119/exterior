import { clientScope, connectionsPath, devicesPath, errorCodes, isDevice, parseJson, type Device, type ErrorCode } from "../index.js";
import * as oauth from "oauth4webapi";
import { discover, isRecord, oauthMessage, originOf, publicClient, refreshAccessToken, RefreshTokenRejectedError, requestOptions, toTokens, type Tokens } from "../oauth.js";

const refreshWindowMs = 60_000;
const signInScope = `${clientScope} offline_access`;

export type BrowserClientConfig = {
  relayUrl: string;
  clientId: string;
  redirectUri: string;
};

async function createAuthorizationRequest(input: BrowserClientConfig): Promise<{ url: string; codeVerifier: string; state: string }> {
  const server = await discover(input.relayUrl);
  if (!server.authorization_endpoint) throw new Error("The relay did not publish a sign-in address.");
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const url = new URL(server.authorization_endpoint);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", signInScope);
  url.searchParams.set("code_challenge", await oauth.calculatePKCECodeChallenge(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("resource", originOf(input.relayUrl));
  return { url: url.href, codeVerifier, state };
}

async function exchangeAuthorizationCode(input: BrowserClientConfig & {
  callback: URL;
  codeVerifier: string;
  state: string;
}): Promise<Tokens> {
  const server = await discover(input.relayUrl);
  const client = publicClient(input.clientId);
  let params: URLSearchParams;
  try {
    params = oauth.validateAuthResponse(server, client, input.callback, input.state);
  } catch (error) {
    throw new Error(oauthMessage(error, "Sign in again."));
  }
  const response = await oauth.authorizationCodeGrantRequest(
    server,
    client,
    oauth.None(),
    params,
    input.redirectUri,
    input.codeVerifier,
    requestOptions(input.relayUrl, originOf(input.relayUrl)),
  );
  const tokens = await oauth.processAuthorizationCodeResponse(server, client, response).catch((error: unknown) => {
    throw new Error(oauthMessage(error, "Sign in again."));
  });
  return toTokens(tokens);
}

/** An error response from the relay. Decide by `code`; `message` is for people. */
export class RelayError extends Error {
  constructor(readonly code: ErrorCode, readonly status: number, message: string) {
    super(message);
    this.name = "RelayError";
  }
}

/** A connection the device started: dial `url` once, right away, as the agent's ACP address. */
export type OpenedAgent = { url: string };

export async function listDevices(relayUrl: string, accessToken: string, signal?: AbortSignal): Promise<Device[]> {
  const response = await fetch(new URL(devicesPath, originOf(relayUrl)), {
    headers: { authorization: `Bearer ${accessToken}` },
    credentials: "omit",
    signal,
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw relayError(response.status, body, "The relay did not list devices.");
  if (!isRecord(body) || !Array.isArray(body.devices)) throw new RelayError("server_error", response.status, "The relay did not list devices.");
  return body.devices.filter(isDevice);
}

export async function openConnection(
  relayUrl: string,
  accessToken: string,
  input: { deviceId: string; agentName: string },
  signal?: AbortSignal,
): Promise<OpenedAgent> {
  const response = await fetch(new URL(connectionsPath, originOf(relayUrl)), {
    method: "POST",
    credentials: "omit",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw relayError(response.status, body, "The relay did not open the agent.");
  if (!isRecord(body) || typeof body.url !== "string") throw new RelayError("server_error", response.status, "The relay did not open the agent.");
  return { url: body.url };
}

export function relayError(status: number, body: unknown, fallback: string): RelayError {
  const named = isRecord(body) && typeof body.code === "string" ? errorCodes.find((code) => code === body.code) : undefined;
  const message = isRecord(body) && typeof body.message === "string" ? body.message : fallback;
  return new RelayError(named ?? (status === 401 ? "unauthorized" : "server_error"), status, message);
}

export type BrowserStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const signInKey = "exterior.signIn";
const accessKey = "exterior.accessToken";
const refreshKey = "exterior.refreshToken";
const expiresKey = "exterior.expiresAt";

export function isBrowserSignInResponse(url: URL, store: BrowserStore): boolean {
  const params = url.searchParams;
  const hasResult = params.has("code") || params.has("error");
  const hasState = params.has("state");
  return params.has("iss")
    ? hasResult || hasState
    : hasResult && hasState && store.getItem(signInKey) !== null;
}

/**
 * Starts a sign-in and returns the relay address to send the person to. `clientId` is the https address of the
 * app's Client ID Metadata Document, or a client an account registered on the relay.
 */
export async function beginBrowserSignIn(input: BrowserClientConfig & { store: BrowserStore; returnTo?: string }): Promise<string> {
  const returnTo = sameOriginReturnAddress(input.returnTo, new URL(input.redirectUri).origin);
  const { url, codeVerifier, state } = await createAuthorizationRequest(input);
  input.store.setItem(signInKey, JSON.stringify({ codeVerifier, state, returnTo }));
  return url;
}

export async function finishBrowserSignIn({ callbackUrl, store, ...config }: BrowserClientConfig & {
  callbackUrl: string;
  store: BrowserStore;
}): Promise<BrowserSignInResult> {
  const redirect = new URL(config.redirectUri);
  const callback = new URL(callbackUrl);
  validateCallbackAddress(callback, redirect);
  const stored = store.getItem(signInKey);
  const attempt = parseJson(stored ?? "");
  if (!isRecord(attempt) || typeof attempt.codeVerifier !== "string" || typeof attempt.state !== "string") {
    throw new Error("Sign-in was started in another tab or its session ended. Start sign-in again in this tab.");
  }
  if (!callback.searchParams.has("state")) throw new Error("The sign-in response is missing its state. Start sign-in again.");
  if (!callback.searchParams.has("code") && !callback.searchParams.has("error")) {
    throw new Error("The sign-in response has no authorization code or error. Start sign-in again.");
  }
  const returnTo = sameOriginReturnAddress(typeof attempt.returnTo === "string" ? attempt.returnTo : undefined, redirect.origin);
  const { codeVerifier, state } = attempt;
  // A code redeems once, but a framework may mount the callback twice:
  // racing callers for the same code share one redemption.
  const key = `${config.relayUrl}\n${config.clientId}\n${config.redirectUri}\n${state}\n${callback.search}`;
  const racing = pendingCallbackExchanges.get(key);
  if (racing) return racing;
  const run = exchangeAuthorizationCode({ ...config, callback, codeVerifier, state })
    .then((tokens) => {
      writeBrowserTokens(store, tokens);
      return { ...tokens, returnTo };
    })
    .finally(() => {
      pendingCallbackExchanges.delete(key);
      if (callback.searchParams.get("state") === state && store.getItem(signInKey) === stored) {
        store.removeItem(signInKey);
      }
    });
  pendingCallbackExchanges.set(key, run);
  return run;
}

type BrowserSignInResult = Tokens & { returnTo?: string };

const pendingCallbackExchanges = new Map<string, Promise<BrowserSignInResult>>();

function sameOriginReturnAddress(value: string | undefined, origin: string): string | undefined {
  if (value === undefined) return undefined;
  const destination = new URL(value, origin);
  if (destination.origin !== origin || (destination.protocol !== "https:" && destination.protocol !== "http:")) {
    throw new Error("The page to open after sign-in must be on the same site as the callback.");
  }
  return destination.href;
}

function validateCallbackAddress(callback: URL, redirect: URL): void {
  if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname) {
    throw new Error(`Sign-in returned to ${callback.origin}${callback.pathname}. Expected ${redirect.origin}${redirect.pathname}.`);
  }
  for (const key of new Set(redirect.searchParams.keys())) {
    const expected = redirect.searchParams.getAll(key);
    const received = callback.searchParams.getAll(key);
    if (expected.length !== received.length || expected.some((value, index) => value !== received[index])) {
      throw new Error("The sign-in response does not match the configured callback query.");
    }
  }
}

/**
 * A live access token, refreshed within the last minute of its life, or undefined once the sign-in is gone. A relay
 * that does not answer the refresh rejects, and the sign-in is kept.
 */
export async function storedAccessToken(input: { relayUrl: string; store: BrowserStore; clientId: string }): Promise<string | undefined> {
  const accessToken = input.store.getItem(accessKey);
  const expiresAt = Number(input.store.getItem(expiresKey));
  if (accessToken && Number.isFinite(expiresAt) && expiresAt - Date.now() > refreshWindowMs) return accessToken;
  const refreshToken = input.store.getItem(refreshKey);
  if (!refreshToken) return undefined;
  // A relay may rotate the refresh token on each use, so callers racing to refresh share one.
  let refreshing = pendingRefreshes.get(refreshToken);
  if (!refreshing) {
    refreshing = refreshAccessToken({ relayUrl: input.relayUrl, clientId: input.clientId, refreshToken })
      .then((tokens) => {
        writeBrowserTokens(input.store, tokens);
        return tokens;
      })
      .finally(() => pendingRefreshes.delete(refreshToken));
    pendingRefreshes.set(refreshToken, refreshing);
  }
  try {
    return (await refreshing).accessToken;
  } catch (error) {
    if (!(error instanceof RefreshTokenRejectedError)) throw error;
    clearBrowserSignIn(input.store);
    return undefined;
  }
}

const pendingRefreshes = new Map<string, Promise<Tokens>>();

function writeBrowserTokens(store: BrowserStore, tokens: Tokens): void {
  store.setItem(accessKey, tokens.accessToken);
  store.setItem(expiresKey, String(tokens.expiresAt));
  if (tokens.refreshToken) store.setItem(refreshKey, tokens.refreshToken);
}

export function clearBrowserSignIn(store: BrowserStore): void {
  store.removeItem(signInKey);
  store.removeItem(accessKey);
  store.removeItem(refreshKey);
  store.removeItem(expiresKey);
}
