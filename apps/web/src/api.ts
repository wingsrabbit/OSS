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

let sessionResetStarted = false;

export function hardResetSession(): void {
  if (sessionResetStarted) return;
  sessionResetStarted = true;
  window.location.replace("/");
}

function isProtectedApiPath(path: string): boolean {
  return (
    path.startsWith("/api/v1/") &&
    !path.startsWith("/api/v1/auth/") &&
    path !== "/api/v1/catalog" &&
    !path.startsWith("/api/v1/legal/")
  );
}

function reauthenticationMeansSessionExpired(path: string, status: number, message?: string): boolean {
  return (
    path === "/api/v1/auth/reauth" &&
    status === 401 &&
    (message === "Session is invalid or expired" || message === "Authentication required")
  );
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
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
    throw new ApiError(
      errorBody.error ?? `Request failed (${response.status})`,
      response.status,
      errorBody.code,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
