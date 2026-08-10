// SPDX-License-Identifier: AGPL-3.0-or-later

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ObsoleteSessionResponseError extends Error {
  constructor() {
    super("Obsolete session response discarded");
    this.name = "ObsoleteSessionResponseError";
  }
}

const ACCOUNT_CONTEXT_VERSION_HEADER = "X-OSS-Account-Context-Version";
const CLIENT_ACCOUNT_CONTEXT_HEADER = "X-OSS-Client-Account-Id";
const CONTEXT_INVALIDATION_CODES = new Set([
  "ACCOUNT_CONTEXT_STALE",
  "ACCOUNT_CONTEXT_REQUIRED",
  "ACCOUNT_CONTEXT_INVALID",
]);
const SESSION_CHANNEL_NAME = "opensales-session-epoch-v1";
const SESSION_LOCK_NAME = "opensales-auth-transition-v1";

export type AccountContextSnapshot = Readonly<{
  clientAccountId: string | null;
  version: string | null;
  generation: number;
}>;

type ContextInvalidationListener = (error: ApiError) => void;
type AuthTransition = "login" | "logout";
type SessionBroadcast = Readonly<{
  type: "session-transition";
  transitionId: string;
  phase: "begin" | "replace" | "end";
}>;

let accountContext: AccountContextSnapshot = {
  clientAccountId: null,
  version: null,
  generation: 0,
};
let sessionEpoch = 0;
let authTransition: AuthTransition | null = null;
let authRequestReserved = false;
let sessionResetStarted = false;
const pendingSessionTransitions = new Set<string>();
let transitionWaiters: Array<() => void> = [];
const contextInvalidationListeners = new Set<ContextInvalidationListener>();
const sessionChannel = typeof BroadcastChannel === "function"
  ? new BroadcastChannel(SESSION_CHANNEL_NAME)
  : null;

function isDecimalVersion(value: string | null): value is string {
  return value !== null && /^(0|[1-9]\d*)$/.test(value);
}

function compareVersions(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function responseContext(response: Response): Pick<AccountContextSnapshot, "clientAccountId" | "version"> | null {
  const version = response.headers.get(ACCOUNT_CONTEXT_VERSION_HEADER);
  if (!isDecimalVersion(version)) return null;
  return {
    clientAccountId: response.headers.get(CLIENT_ACCOUNT_CONTEXT_HEADER),
    version,
  };
}

function captureResponseContext(response: Response, force = false): boolean {
  const incoming = responseContext(response);
  if (!incoming || incoming.version === null) return true;
  if (
    !force &&
    accountContext.version !== null &&
    (compareVersions(incoming.version, accountContext.version) < 0 ||
      (incoming.version === accountContext.version &&
        incoming.clientAccountId !== accountContext.clientAccountId))
  ) {
    return false;
  }
  if (
    accountContext.version === incoming.version &&
    accountContext.clientAccountId === incoming.clientAccountId
  ) return true;
  accountContext = {
    ...incoming,
    generation: accountContext.generation + 1,
  };
  return true;
}

export function getAccountContextSnapshot(): AccountContextSnapshot {
  return accountContext;
}

export function clearAccountContext(): void {
  accountContext = {
    clientAccountId: null,
    version: null,
    generation: accountContext.generation + 1,
  };
}

export function subscribeAccountContextInvalidation(
  listener: ContextInvalidationListener,
): () => void {
  contextInvalidationListeners.add(listener);
  return () => contextInvalidationListeners.delete(listener);
}

function publishContextInvalidation(error: ApiError): void {
  for (const listener of contextInvalidationListeners) listener(error);
}

function newTransitionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function broadcastSessionPhase(transitionId: string, phase: SessionBroadcast["phase"]): void {
  sessionChannel?.postMessage({ type: "session-transition", transitionId, phase } satisfies SessionBroadcast);
}

function beginSessionEpochTransition(transitionId: string): void {
  pendingSessionTransitions.add(transitionId);
  sessionEpoch += 1;
  broadcastSessionPhase(transitionId, "begin");
}

function replaceSessionContext(transitionId: string, broadcast = true): void {
  sessionEpoch += 1;
  clearAccountContext();
  if (broadcast) broadcastSessionPhase(transitionId, "replace");
}

function endSessionEpochTransition(transitionId: string, broadcast = true): void {
  pendingSessionTransitions.delete(transitionId);
  if (broadcast) broadcastSessionPhase(transitionId, "end");
  if (pendingSessionTransitions.size === 0) {
    const waiters = transitionWaiters;
    transitionWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

async function waitForSessionTransitions(): Promise<void> {
  if (navigator.locks) {
    // The shared lock is the crash-safe source of truth. If another tab closes
    // after broadcasting begin, the browser releases its exclusive lock even
    // though no BroadcastChannel end message can be sent.
    await navigator.locks.request(SESSION_LOCK_NAME, { mode: "shared" }, () => undefined);
    if (pendingSessionTransitions.size > 0) {
      pendingSessionTransitions.clear();
      const waiters = transitionWaiters;
      transitionWaiters = [];
      for (const resolve of waiters) resolve();
    }
    return;
  }
  if (pendingSessionTransitions.size === 0) return;
  let timeoutId: number | undefined;
  await Promise.race([
    new Promise<void>((resolve) => transitionWaiters.push(resolve)),
    new Promise<void>((resolve) => {
      timeoutId = window.setTimeout(resolve, 30_000);
    }),
  ]);
  if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  if (pendingSessionTransitions.size > 0) {
    pendingSessionTransitions.clear();
    const waiters = transitionWaiters;
    transitionWaiters = [];
    for (const resolve of waiters) resolve();
    sessionEpoch += 1;
    clearAccountContext();
    publishContextInvalidation(
      new ApiError("The browser session transition could not be confirmed", 409, "SESSION_CHANGED"),
    );
  }
}

sessionChannel?.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data as Partial<SessionBroadcast> | null;
  if (
    message?.type !== "session-transition" ||
    typeof message.transitionId !== "string" ||
    (message.phase !== "begin" && message.phase !== "replace" && message.phase !== "end")
  ) return;
  if (message.phase === "begin") {
    pendingSessionTransitions.add(message.transitionId);
    sessionEpoch += 1;
    return;
  }
  if (message.phase === "replace") {
    sessionEpoch += 1;
    clearAccountContext();
    publishContextInvalidation(
      new ApiError("The browser session changed in another tab", 409, "SESSION_CHANGED"),
    );
    return;
  }
  endSessionEpochTransition(message.transitionId, false);
});

export function hardResetSession(): void {
  if (sessionResetStarted) return;
  sessionResetStarted = true;
  const transitionId = newTransitionId();
  beginSessionEpochTransition(transitionId);
  replaceSessionContext(transitionId);
  endSessionEpochTransition(transitionId);
  window.location.replace("/");
}

function isProtectedApiPath(path: string): boolean {
  const pathname = new URL(path, window.location.origin).pathname;
  return (
    pathname.startsWith("/api/v1/") &&
    !pathname.startsWith("/api/v1/auth/") &&
    pathname !== "/api/v1/catalog" &&
    !pathname.startsWith("/api/v1/legal/")
  );
}

function reauthenticationMeansSessionExpired(path: string, status: number, message?: string): boolean {
  const pathname = new URL(path, window.location.origin).pathname;
  return (
    pathname === "/api/v1/auth/reauth" &&
    status === 401 &&
    (message === "Session is invalid or expired" || message === "Authentication required")
  );
}

function mutationHeaders(path: string, init?: RequestInit): Headers {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  const method = (init?.method ?? "GET").toUpperCase();
  const pathname = new URL(path, window.location.origin).pathname;
  if (
    pathname.startsWith("/api/v1/") &&
    method !== "GET" &&
    method !== "HEAD" &&
    accountContext.version !== null &&
    !headers.has(ACCOUNT_CONTEXT_VERSION_HEADER)
  ) {
    headers.set(ACCOUNT_CONTEXT_VERSION_HEADER, accountContext.version);
  }
  return headers;
}

function isSafeRead(init?: RequestInit): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  return method === "GET" || method === "HEAD";
}

async function request<T>(path: string, init: RequestInit | undefined, retryObsoleteRead: boolean): Promise<T> {
  const pathname = new URL(path, window.location.origin).pathname;
  const transition: AuthTransition | null = pathname === "/api/v1/auth/login"
    ? "login"
    : pathname === "/api/v1/auth/logout"
      ? "logout"
      : null;
  if (transition && authTransition) {
    throw new ApiError("Another sign-in or sign-out operation is already in progress", 409, "AUTH_TRANSITION_IN_PROGRESS");
  }
  if (transition) {
    authTransition = transition;
  } else {
    await waitForSessionTransitions();
  }
  const transitionId = transition === null ? null : newTransitionId();
  if (transitionId) beginSessionEpochTransition(transitionId);
  const requestEpoch = sessionEpoch;
  try {
    const response = await fetch(path, {
      ...init,
      credentials: "include",
      headers: mutationHeaders(path, init),
    });
    const establishingLogin = transition === "login" && responseContext(response) !== null;
    if (establishingLogin) {
      replaceSessionContext(transitionId!);
      if (!captureResponseContext(response, true)) throw new ObsoleteSessionResponseError();
    } else if (transition === null && requestEpoch !== sessionEpoch) {
      throw new ObsoleteSessionResponseError();
    } else if (!captureResponseContext(response)) {
      throw new ObsoleteSessionResponseError();
    }

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };
      if (
        (response.status === 401 && isProtectedApiPath(path)) ||
        reauthenticationMeansSessionExpired(path, response.status, errorBody.error)
      ) {
        hardResetSession();
      }
      const error = new ApiError(
        errorBody.error ?? `Request failed (${response.status})`,
        response.status,
        errorBody.code,
      );
      if (
        pathname !== "/api/v1/auth/login" &&
        error.code !== undefined &&
        CONTEXT_INVALIDATION_CODES.has(error.code)
      ) {
        publishContextInvalidation(error);
      }
      throw error;
    }
    if (transition === "login" && !establishingLogin) {
      throw new ApiError("Sign-in response did not establish a session context", 502, "SESSION_CONTEXT_MISSING");
    }
    if (transition === "logout") replaceSessionContext(transitionId!);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } catch (caught) {
    if (caught instanceof ObsoleteSessionResponseError && retryObsoleteRead && isSafeRead(init)) {
      await waitForSessionTransitions();
      return request<T>(path, init, false);
    }
    throw caught;
  } finally {
    if (transitionId) endSessionEpochTransition(transitionId);
    if (transition) authTransition = null;
  }
}

export function api<T>(path: string, init?: RequestInit): Promise<T> {
  const pathname = new URL(path, window.location.origin).pathname;
  const isAuthTransition = pathname === "/api/v1/auth/login" || pathname === "/api/v1/auth/logout";
  if (!isAuthTransition) return request<T>(path, init, true);
  if (authRequestReserved) {
    return Promise.reject(
      new ApiError("Another sign-in or sign-out operation is already in progress", 409, "AUTH_TRANSITION_IN_PROGRESS"),
    );
  }
  authRequestReserved = true;
  const execute = () => request<T>(path, init, true);
  const locks = navigator.locks;
  const pending = locks
    ? locks.request(SESSION_LOCK_NAME, { mode: "exclusive" }, execute)
    : execute();
  return pending.finally(() => {
    authRequestReserved = false;
  });
}
