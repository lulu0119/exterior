import { beginBrowserSignIn, clearBrowserSignIn, finishBrowserSignIn, isBrowserSignInResponse, listDevices, openConnection, storedAccessToken, type BrowserClientConfig, type OpenedAgent } from "./oauth.js";
import type { Device } from "../index.js";
import { useCallback, useEffect, useRef, useState } from "react";

export type Account = { phase: "checking" } | { phase: "signed-out" } | { phase: "signed-in" };

export type AccountSession = {
  account: Account;
  busy: boolean;
  error: string;
  signIn: () => void;
  signOut: () => void;
  /**
   * A live access token for each request, refreshed when it is about to expire. Once the sign-in is gone it rejects
   * and the account is signed out.
   */
  accessToken: () => Promise<string>;
  listDevices: (signal?: AbortSignal) => Promise<Device[]>;
  openConnection: (input: { deviceId: string; agentName: string }, signal?: AbortSignal) => Promise<OpenedAgent>;
};

export function useAccount({ relayUrl, clientId, redirectUri, returnTo }: BrowserClientConfig & { returnTo?: string }): AccountSession {
  const [account, setAccount] = useState<Account>({ phase: "checking" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const redemption = useRef<Promise<string> | undefined>(undefined);

  useEffect(() => {
    const store = window.sessionStorage;
    const current = new URL(window.location.href);
    if (isBrowserSignInResponse(current, store)) {
      const callbackUrl = current.href;
      for (const parameter of ["code", "state", "iss", "error", "error_description", "error_uri"]) current.searchParams.delete(parameter);
      window.history.replaceState(window.history.state, "", current);
      redemption.current = finishBrowserSignIn({ relayUrl, redirectUri, callbackUrl, store, clientId })
        .then(({ accessToken, returnTo: destination }) => {
          if (destination && destination !== window.location.href) window.location.replace(destination);
          return accessToken;
        })
        .finally(() => { redemption.current = undefined; });
    }
    const token = redemption.current ?? storedAccessToken({ relayUrl, store, clientId });
    let cancelled = false;
    void token
      .then((current) => {
        if (cancelled) return;
        setAccount(current ? { phase: "signed-in" } : { phase: "signed-out" });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setAccount({ phase: "signed-out" });
        setError(error instanceof Error ? error.message : "Sign in again.");
      });
    return () => {
      cancelled = true;
    };
  }, [relayUrl, clientId, redirectUri]);

  const signIn = useCallback(() => {
    setBusy(true);
    setError("");
    void beginBrowserSignIn({ relayUrl, redirectUri, store: window.sessionStorage, clientId, returnTo: returnTo ?? window.location.href })
      .then((url) => {
        window.location.assign(url);
      })
      .catch((error: unknown) => {
        setError(error instanceof Error ? error.message : "The relay did not answer.");
        setBusy(false);
      });
  }, [relayUrl, redirectUri, clientId, returnTo]);

  const signOut = useCallback(() => {
    clearBrowserSignIn(window.sessionStorage);
    setAccount({ phase: "signed-out" });
    setError("");
  }, []);

  const accessToken = useCallback(async () => {
    const current = await storedAccessToken({ relayUrl, store: window.sessionStorage, clientId });
    if (current) return current;
    setAccount({ phase: "signed-out" });
    throw new Error("Sign in again.");
  }, [relayUrl, clientId]);

  const accountDevices = useCallback(async (signal?: AbortSignal) => listDevices(relayUrl, await accessToken(), signal), [relayUrl, accessToken]);
  const accountConnection = useCallback(async (input: { deviceId: string; agentName: string }, signal?: AbortSignal) => openConnection(relayUrl, await accessToken(), input, signal), [relayUrl, accessToken]);

  return { account, busy, error, signIn, signOut, accessToken, listDevices: accountDevices, openConnection: accountConnection };
}

