// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

export function providerSignature(secret: string, timestamp: string, body: unknown): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${JSON.stringify(body)}`, "utf8")
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
