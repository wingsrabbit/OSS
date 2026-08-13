// SPDX-License-Identifier: Apache-2.0

export const PROVIDER_TRANSPORT_VERSION = "v1" as const;
export const PROVIDER_CONTRACT_VERSION = "v1alpha1" as const;

export const providerCapabilities = [
  "payment",
  "provisioning",
  "mail",
  "verification",
  "tax",
  "anti_abuse_challenge",
] as const;

export type ProviderTransportVersion = typeof PROVIDER_TRANSPORT_VERSION;
export type ProviderContractVersion = typeof PROVIDER_CONTRACT_VERSION;
export type ProviderCapability = (typeof providerCapabilities)[number];
export type ProviderOperationStatus = "pending" | "succeeded" | "failed" | "unknown";

export const capabilityOperations = {
  payment: ["payment.authorize", "payment.capture", "payment.refund", "payment.reconcile"],
  provisioning: [
    "resource.create",
    "resource.start",
    "resource.stop",
    "resource.reboot",
    "resource.change_password",
    "resource.change_plan",
    "resource.terminate",
    "resource.reconcile",
  ],
  mail: ["mail.send", "mail.reconcile"],
  verification: ["verification.evaluate", "verification.reconcile"],
  tax: ["tax.quote", "tax.reconcile"],
  anti_abuse_challenge: ["challenge.evaluate", "challenge.reconcile"],
} as const satisfies Record<ProviderCapability, readonly string[]>;

export type PaymentAction = (typeof capabilityOperations.payment)[number];
export type ProvisioningAction = (typeof capabilityOperations.provisioning)[number];
export type MailAction = (typeof capabilityOperations.mail)[number];
export type VerificationAction = (typeof capabilityOperations.verification)[number];
export type TaxAction = (typeof capabilityOperations.tax)[number];
export type AntiAbuseChallengeAction =
  (typeof capabilityOperations.anti_abuse_challenge)[number];

export interface ProviderOperationBase {
  transportVersion: ProviderTransportVersion;
  contractVersion: ProviderContractVersion;
  operationId: string;
  requestedAt: string;
  intentRef: string;
}

export interface PaymentInput {
  amountMinor: string;
  currency: string;
  customerRef?: string;
  externalPaymentRef?: string;
}

export interface ProvisioningInput {
  serviceRef: string;
  planRef: string;
  externalResourceRef?: string;
  configuration?: Record<string, string | number | boolean>;
}

export interface MailInput {
  recipient: string;
  templateRef: string;
  locale: "en" | "zh-CN";
  subject: string;
  textBody: string;
}

export interface VerificationInput {
  subjectRef: string;
  purpose: "account_eligibility" | "manual_review";
  checks: Array<"email_ownership" | "identity" | "business">;
}

export interface TaxLineInput {
  lineRef: string;
  amountMinor: string;
  taxCode: string;
}

export interface TaxInput {
  currency: string;
  jurisdictionCountry: string;
  jurisdictionRegion?: string;
  lines: TaxLineInput[];
}

export interface AntiAbuseChallengeInput {
  subjectRef: string;
  actionRef: string;
  signals: Record<string, string | number | boolean>;
}

export interface PaymentOperationRequest extends ProviderOperationBase {
  capability: "payment";
  action: PaymentAction;
  input: PaymentInput;
}

export interface ProvisioningOperationRequest extends ProviderOperationBase {
  capability: "provisioning";
  action: ProvisioningAction;
  input: ProvisioningInput;
}

export interface MailOperationRequest extends ProviderOperationBase {
  capability: "mail";
  action: MailAction;
  input: MailInput;
}

export interface VerificationOperationRequest extends ProviderOperationBase {
  capability: "verification";
  action: VerificationAction;
  input: VerificationInput;
}

export interface TaxOperationRequest extends ProviderOperationBase {
  capability: "tax";
  action: TaxAction;
  input: TaxInput;
}

export interface AntiAbuseChallengeOperationRequest extends ProviderOperationBase {
  capability: "anti_abuse_challenge";
  action: AntiAbuseChallengeAction;
  input: AntiAbuseChallengeInput;
}

export type ProviderOperationRequest =
  | PaymentOperationRequest
  | ProvisioningOperationRequest
  | MailOperationRequest
  | VerificationOperationRequest
  | TaxOperationRequest
  | AntiAbuseChallengeOperationRequest;

export interface PaymentOutput {
  externalPaymentRef: string;
  paymentState: "authorized" | "captured" | "refunded" | "declined";
  amountMinor: string;
  currency: string;
}

export interface ProvisioningOutput {
  externalResourceRef: string;
  resourceState: "pending" | "ready" | "stopped" | "terminated";
  readyAt?: string;
}

export interface MailOutput {
  externalDeliveryRef: string;
  deliveryState: "delivered" | "bounced" | "failed";
}

export interface VerificationOutput {
  externalEvidenceRef: string;
  verdict: "verified" | "rejected" | "manual_review";
  assurance: "low" | "medium" | "high";
  checked: Array<"email_ownership" | "identity" | "business">;
}

export interface TaxLineOutput {
  lineRef: string;
  taxMinor: string;
  rateBasisPoints: number;
}

export interface TaxOutput {
  externalQuoteRef: string;
  currency: string;
  totalTaxMinor: string;
  lines: TaxLineOutput[];
}

export interface AntiAbuseChallengeOutput {
  externalDecisionRef: string;
  decision: "allow" | "challenge" | "deny";
  challengeRef?: string;
  challengeState?: "pending" | "satisfied" | "failed";
}

export type ProviderOperationOutput =
  | PaymentOutput
  | ProvisioningOutput
  | MailOutput
  | VerificationOutput
  | TaxOutput
  | AntiAbuseChallengeOutput;

export interface ProviderOperationError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ProviderOperationResult {
  transportVersion: ProviderTransportVersion;
  contractVersion: ProviderContractVersion;
  capability: ProviderCapability;
  operationId: string;
  status: ProviderOperationStatus;
  revision: number;
  observedAt: string;
  output?: ProviderOperationOutput;
  error?: ProviderOperationError;
}

export interface ProviderEvent {
  transportVersion: ProviderTransportVersion;
  contractVersion: ProviderContractVersion;
  eventId: string;
  providerId: string;
  capability: ProviderCapability;
  operationId: string;
  sequence: number;
  eventType: "operation.pending" | "operation.succeeded" | "operation.failed" | "operation.unknown";
  observedAt: string;
  result: ProviderOperationResult;
}

export interface ProviderEventPage {
  events: ProviderEvent[];
  nextCursor: string | null;
}

export interface ProviderCapabilityDeclaration {
  capability: ProviderCapability;
  contractVersion: ProviderContractVersion;
  operations: string[];
  eventSubscriptions: string[];
}

export interface ProviderManifest {
  manifestVersion: "v1";
  providerId: string;
  displayName: string;
  description: string;
  endpointBaseUrl: string;
  publisher: {
    name: string;
    website: string;
    supportUrl: string;
  };
  license: {
    identifier: string;
    url: string;
  };
  capabilities: ProviderCapabilityDeclaration[];
  permissions: {
    scopes: string[];
    dataFields: string[];
    secrets: Array<{
      name: string;
      purpose: string;
      required: boolean;
      rotation: "supported" | "required";
    }>;
  };
  limits: {
    maxConcurrentOperations: number;
    maxAmountMinor: string | null;
    maxOwnedResources: number | null;
  };
  retention: {
    operationDays: number;
    eventDays: number;
    piiDays: number;
  };
  lifecycle: {
    supportsPause: boolean;
    supportsCredentialRotation: boolean;
    supportsManualTakeover: boolean;
    uninstallRequiresNoUnknownOperations: boolean;
    uninstallRequiresNoOwnedResources: boolean;
    uninstallRequiresNoPendingFunds: boolean;
  };
}

export type ProviderDocumentKind =
  | "manifest"
  | "operation-request"
  | "operation-result"
  | "event"
  | "event-page";
