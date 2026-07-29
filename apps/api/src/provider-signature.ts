// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

export function canonicalProviderJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Provider payload contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalProviderJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalProviderJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Provider payload contains an unsupported value");
}

export function providerSignature(secret: string, timestamp: string, body: unknown): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${canonicalProviderJson(body)}`, "utf8")
    .digest("hex");
}

export function assertProviderSignature(
  request: FastifyRequest,
  secret: string,
  body: unknown,
): void {
  const timestamp = request.headers["x-oss-timestamp"];
  const signature = request.headers["x-oss-signature"];
  if (typeof timestamp !== "string" || typeof signature !== "string") {
    throw Object.assign(new Error("Missing provider signature"), { statusCode: 401 });
  }
  const timestampMs = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60_000) {
    throw Object.assign(new Error("Provider signature timestamp is outside the accepted window"), {
      statusCode: 401,
    });
  }
  const expected = Buffer.from(providerSignature(secret, timestamp, body), "utf8");
  const received = Buffer.from(signature, "utf8");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw Object.assign(new Error("Invalid provider signature"), { statusCode: 401 });
  }
}
