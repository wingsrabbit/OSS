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
  "ACCOUNT_RESTRICTED",
  "EMAIL_VERIFICATION_REQUIRED",
]);
const IDENTITY_INVALIDATION_CODES = new Set([
  "ACCOUNT_RESTRICTED",
  "EMAIL_VERIFICATION_REQUIRED",
]);
const SESSION_CHANNEL_NAME = "opensales-session-epoch-v1";
const SESSION_LOCK_NAME = "opensales-auth-transition-v1";
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
type ParsedResponseContext =
  | Readonly<{
      kind: "valid";
      clientAccountId: string | null;
      version: string;
    }>
  | Readonly<{ kind: "missing" | "invalid" }>;
type ResponseContextRequirement = "none" | "session" | "account";
type ErrorBody = Readonly<{ error?: string; code?: string }>;

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

function responseContext(response: Response): ParsedResponseContext {
  const version = response.headers.get(ACCOUNT_CONTEXT_VERSION_HEADER);
  const clientAccountId = response.headers.get(CLIENT_ACCOUNT_CONTEXT_HEADER);
  if (version === null && clientAccountId === null) return { kind: "missing" };
  if (
    !isDecimalVersion(version) ||
    (clientAccountId !== null && !CANONICAL_UUID.test(clientAccountId))
  ) return { kind: "invalid" };
  return {
    kind: "valid",
    clientAccountId,
    version,
  };
}

function captureResponseContext(
  incoming: Extract<ParsedResponseContext, { kind: "valid" }>,
  force = false,
): boolean {
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
    clientAccountId: incoming.clientAccountId,
    version: incoming.version,
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

function invalidateSessionContextAcrossTabs(error: ApiError, clear = true): void {
  if (clear) clearAccountContext();
  sessionEpoch += 1;
  publishContextInvalidation(error);
  // `replace` is sufficient here: there is no lock holder for peers to wait
  // for, but every other workspace must drop its old identity/account facts.
  broadcastSessionPhase(newTransitionId(), "replace");
}

function broadcastIntentionalContextReplacement(): void {
  // The initiating workspace refreshes through its Account Context switch
  // callback. Peers still need the same fail-closed invalidation immediately.
  sessionEpoch += 1;
  broadcastSessionPhase(newTransitionId(), "replace");
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

function settlePendingTransitionsAfterLockBarrier(): void {
  // Acquiring either Web Lock proves that every earlier exclusive holder has
  // ended (including a tab that crashed before it could broadcast `end`).
  if (pendingSessionTransitions.size === 0) return;
  pendingSessionTransitions.clear();
  const waiters = transitionWaiters;
  transitionWaiters = [];
  for (const resolve of waiters) resolve();
}

async function waitForSessionTransitionsWithoutWebLocks(): Promise<void> {
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

function isPublicApiPath(pathname: string): boolean {
  return (
    pathname === "/api/v1/catalog" ||
    pathname.startsWith("/api/v1/legal/") ||
    pathname === "/api/v1/auth/register" ||
    pathname === "/api/v1/auth/invitation-registrations" ||
    pathname === "/api/v1/auth/verify-email"
  );
}

function isAccountScopedPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/v1/account/") ||
    pathname.startsWith("/api/v1/customer/") ||
    pathname.startsWith("/api/v1/billing/") ||
    pathname === "/api/v1/orders" ||
    pathname.startsWith("/api/v1/orders/") ||
    pathname.startsWith("/api/v1/invoices/") ||
    pathname.startsWith("/api/v1/services/") ||
    pathname === "/api/v1/tickets" ||
    pathname.startsWith("/api/v1/tickets/")
  );
}

function loginEstablished(response: Response, errorBody: ErrorBody): boolean {
  return response.ok ||
    (response.status === 409 && errorBody.code === "ACCOUNT_CONTEXT_REQUIRED");
}

function responseMeansSessionAbsent(response: Response, errorBody: ErrorBody): boolean {
  return response.status === 401 &&
    (errorBody.error === "Authentication required" ||
      errorBody.error === "Session is invalid or expired");
}

function responseContextRequirement(
  pathname: string,
  response: Response,
  errorBody: ErrorBody,
  transition: AuthTransition | null,
): ResponseContextRequirement {
  if (isPublicApiPath(pathname)) return "none";
  if (transition === "login") return loginEstablished(response, errorBody) ? "session" : "none";
  if (transition === "logout" && response.ok) return "none";
  // An unauthenticated response has no session row from which a version could
  // be derived. It is itself authoritative only for session absence.
  if (responseMeansSessionAbsent(response, errorBody)) return "none";
  if (response.ok && isAccountScopedPath(pathname)) return "account";
  return pathname.startsWith("/api/v1/") ? "session" : "none";
}

function reauthenticationMeansSessionExpired(path: string, status: number, message?: string): boolean {
  const pathname = new URL(path, window.location.origin).pathname;
  return (
    pathname === "/api/v1/auth/reauth" &&
    status === 401 &&
    (message === "Session is invalid or expired" || message === "Authentication required")
  );
}

function mutationHeaders(
  path: string,
  init: RequestInit | undefined,
  context: AccountContextSnapshot,
): Headers {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  const method = (init?.method ?? "GET").toUpperCase();
  const pathname = new URL(path, window.location.origin).pathname;
  if (
    pathname.startsWith("/api/v1/") &&
    !isPublicApiPath(pathname) &&
    pathname !== "/api/v1/auth/login" &&
    pathname !== "/api/v1/auth/logout" &&
    method !== "GET" &&
    method !== "HEAD" &&
    context.version !== null &&
    !headers.has(ACCOUNT_CONTEXT_VERSION_HEADER)
  ) {
    headers.set(ACCOUNT_CONTEXT_VERSION_HEADER, context.version);
  }
  return headers;
}

function isSafeRead(init?: RequestInit): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  return method === "GET" || method === "HEAD";
}

function isIntentionalAccountContextTransition(pathname: string, init?: RequestInit): boolean {
  return pathname === "/api/v1/auth/account-context" &&
    (init?.method ?? "GET").toUpperCase() === "PUT";
}

function contextProtocolError(message: string): ApiError {
  return new ApiError(message, 502, "SESSION_CONTEXT_INVALID");
}

async function errorBody(response: Response): Promise<ErrorBody> {
  if (response.ok || response.status === 204) return {};
  return (await response.clone().json().catch(() => ({}))) as ErrorBody;
}

async function authoritativeSessionRebootstrap(): Promise<void> {
  clearAccountContext();
  const response = await fetch("/api/v1/auth/me", {
    credentials: "include",
    headers: new Headers({ "Content-Type": "application/json" }),
  });
  const body = await errorBody(response);
  if (response.status === 401) {
    throw new ApiError(
      body.error ?? "Authentication required",
      response.status,
      body.code,
    );
  }
  if (!response.ok) {
    throw contextProtocolError("The authoritative session context could not be loaded");
  }
  const incoming = responseContext(response);
  if (incoming.kind !== "valid" || !captureResponseContext(incoming)) {
    throw contextProtocolError("The authoritative session response had invalid context headers");
  }
}

function publishProtocolFailure(message: string, clear = true): ApiError {
  if (clear) clearAccountContext();
  const error = contextProtocolError(message);
  publishContextInvalidation(error);
  return error;
}

async function request<T>(
  path: string,
  init: RequestInit | undefined,
  allowAuthoritativeRecovery: boolean,
  inheritedInvalidation = false,
): Promise<T> {
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
  }
  const transitionId = transition === null ? null : newTransitionId();
  if (transitionId) beginSessionEpochTransition(transitionId);
  const requestEpoch = sessionEpoch;
  const requestContext = accountContext;
  let invalidationPublished = inheritedInvalidation;
  try {
    const response = await fetch(path, {
      ...init,
      credentials: "include",
      headers: mutationHeaders(path, init, requestContext),
    });
    const body = await errorBody(response);
    const identityInvalidated =
      transition === null &&
      !isPublicApiPath(pathname) &&
      response.status === 403 &&
      body.code !== undefined &&
      IDENTITY_INVALIDATION_CODES.has(body.code);
    if (identityInvalidated && !invalidationPublished) {
      invalidateSessionContextAcrossTabs(
        new ApiError(
          body.error ?? "The current identity is no longer eligible for this workspace",
          response.status,
          body.code,
        ),
      );
      invalidationPublished = true;
    }
    const establishingLogin = transition === "login" && loginEstablished(response, body);
    if (establishingLogin) {
      replaceSessionContext(transitionId!);
    }

    const sessionAbsent = transition !== "login" && responseMeansSessionAbsent(response, body);
    if (sessionAbsent) {
      clearAccountContext();
    }

    if (transition === "logout" && response.ok) {
      replaceSessionContext(transitionId!);
    } else {
      const requirement = responseContextRequirement(pathname, response, body, transition);
      const incoming = responseContext(response);
      const intentionalContextTransition =
        response.ok && isIntentionalAccountContextTransition(pathname, init);
      const epochChanged = transition === null && requestEpoch !== sessionEpoch;
      const contextInvalid =
        requirement !== "none" &&
        (incoming.kind !== "valid" ||
          (requirement === "account" && incoming.clientAccountId === null));
      const responseAuthorizationChanged =
        transition === null &&
        !intentionalContextTransition &&
        requirement !== "none" &&
        requestContext.version !== null &&
        incoming.kind === "valid" &&
        (incoming.version !== requestContext.version ||
          incoming.clientAccountId !== requestContext.clientAccountId);
      const obsolete =
        !contextInvalid &&
        !responseAuthorizationChanged &&
        requirement !== "none" &&
        incoming.kind === "valid" &&
        !captureResponseContext(incoming, establishingLogin);

      if (responseAuthorizationChanged && !invalidationPublished) {
        invalidateSessionContextAcrossTabs(
          new ApiError(
            "The response belonged to a different authorization context",
            409,
            "SESSION_CHANGED",
          ),
        );
        invalidationPublished = true;
      }

      if (epochChanged || contextInvalid || responseAuthorizationChanged || obsolete) {
        if (!allowAuthoritativeRecovery) {
          throw publishProtocolFailure(
            contextInvalid
              ? "The response omitted or corrupted its required session context"
              : "The response belonged to an obsolete browser session context",
          );
        }
        const contextBeforeRecovery = accountContext;
        try {
          await authoritativeSessionRebootstrap();
        } catch (caught) {
          if (caught instanceof ApiError && caught.status === 401 && isProtectedApiPath(path)) {
            hardResetSession();
          }
          throw publishProtocolFailure("The browser session context could not be re-established");
        }
        if (transition === null && isSafeRead(init)) {
          if (
            !invalidationPublished &&
            (contextBeforeRecovery.version !== accountContext.version ||
              contextBeforeRecovery.clientAccountId !== accountContext.clientAccountId)
          ) {
            invalidateSessionContextAcrossTabs(
              new ApiError(
                "The browser session context changed during authoritative recovery",
                409,
                "SESSION_CHANGED",
              ),
              false,
            );
            invalidationPublished = true;
          }
          return request<T>(path, init, false, invalidationPublished);
        }
        if (!establishingLogin) {
          throw publishProtocolFailure(
            "The request completed without a trustworthy session context; it was not replayed",
            false,
          );
        }
      }
      if (
        intentionalContextTransition &&
        requestContext.version !== null &&
        incoming.kind === "valid" &&
        incoming.clientAccountId !== requestContext.clientAccountId
      ) {
        broadcastIntentionalContextReplacement();
      }
    }

    if (!response.ok) {
      if (
        (sessionAbsent && isProtectedApiPath(path)) ||
        reauthenticationMeansSessionExpired(path, response.status, body.error)
      ) {
        hardResetSession();
      }
      const error = new ApiError(
        body.error ?? `Request failed (${response.status})`,
        response.status,
        body.code,
      );
      if (
        pathname !== "/api/v1/auth/login" &&
        !invalidationPublished &&
        error.code !== undefined &&
        CONTEXT_INVALIDATION_CODES.has(error.code) &&
        (!IDENTITY_INVALIDATION_CODES.has(error.code) || !isPublicApiPath(pathname))
      ) {
        if (IDENTITY_INVALIDATION_CODES.has(error.code)) {
          invalidateSessionContextAcrossTabs(error);
        } else {
          publishContextInvalidation(error);
        }
      }
      throw error;
    }
    if (transition === "login" && !establishingLogin) {
      throw new ApiError("Sign-in response did not establish a session context", 502, "SESSION_CONTEXT_MISSING");
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } finally {
    if (transitionId) endSessionEpochTransition(transitionId);
    if (transition) authTransition = null;
  }
}

export function api<T>(path: string, init?: RequestInit): Promise<T> {
  const pathname = new URL(path, window.location.origin).pathname;
  const isAuthTransition = pathname === "/api/v1/auth/login" || pathname === "/api/v1/auth/logout";
  const locks = navigator.locks;
  if (!isAuthTransition) {
    const execute = async () => {
      if (locks) settlePendingTransitionsAfterLockBarrier();
      else await waitForSessionTransitionsWithoutWebLocks();
      return request<T>(path, init, true);
    };
    // The lock covers the context snapshot, mutation header, fetch and response
    // capture. Login/logout therefore cannot rotate the cookie mid-request.
    return locks
      ? locks.request(SESSION_LOCK_NAME, { mode: "shared" }, execute)
      : execute();
  }
  if (authRequestReserved) {
    return Promise.reject(
      new ApiError("Another sign-in or sign-out operation is already in progress", 409, "AUTH_TRANSITION_IN_PROGRESS"),
    );
  }
  authRequestReserved = true;
  const execute = () => {
    if (locks) settlePendingTransitionsAfterLockBarrier();
    return request<T>(path, init, true);
  };
  const pending = locks
    ? locks.request(SESSION_LOCK_NAME, { mode: "exclusive" }, execute)
    : execute();
  return pending.finally(() => {
    authRequestReserved = false;
  });
}
