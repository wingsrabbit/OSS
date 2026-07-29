// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHmac, timingSafeEqual } from "node:crypto";

export function providerOperationCapability(
  secret: string,
  providerInstallationId: string,
  operationId: string,
): string {
  return createHmac("sha256", secret)
    .update("opensales-provider-operation-capability:v1\0", "utf8")
    .update(providerInstallationId, "utf8")
    .update("\0", "utf8")
    .update(operationId, "utf8")
    .digest("base64url");
}

export function providerOperationCapabilityMatches(
  received: string,
  secret: string,
  providerInstallationId: string,
  operationId: string,
): boolean {
  const expected = Buffer.from(
    providerOperationCapability(secret, providerInstallationId, operationId),
    "utf8",
  );
  const candidate = Buffer.from(received, "utf8");
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}
