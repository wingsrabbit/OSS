// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRef, useState } from "react";
import { api } from "./api.js";

export type ManualReceiptOutflowReport = {
  outflowReportId: string;
  outflowId: string | null;
  amountMinor: string;
  currency: "USD";
  destination: "original_source";
  destinationReference: string;
  observedOutcome: "confirmed" | "unknown";
  status: "confirmed" | "unknown" | "confirmed_outflow" | "no_outflow";
  occurredAt: string | null;
  actorId: string;
  reason: string;
  createdAt: string;
  reconciliation: {
    reconciliationId: string;
    outcome: "confirm_outflow" | "confirm_no_outflow";
    occurredAt: string | null;
    actorId: string;
    reason: string;
    createdAt: string;
  } | null;
};

export type ManualReceiptOriginalSourceOutflow = {
  sourceContext: "unclaimed_funds";
  sourceAmountMinor: string;
  confirmedOutflowMinor: string;
  availableMinor: string;
  capacityFrozen: boolean;
  reports: ManualReceiptOutflowReport[];
};

type Outcome = {
  status: "confirmed" | "unknown" | "confirmed_outflow" | "no_outflow";
  replayed: boolean;
};

type Props = {
  clientAccountId: string;
  receipt: {
    manualReceiptId: string;
    fundReceiptId: string;
    reference: string;
    currency: "USD";
    reversal: unknown | null;
    originalSourceOutflow: ManualReceiptOriginalSourceOutflow;
  };
  password: string;
  disabled?: boolean;
  onPasswordConsumed: () => void;
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
};

type ReportDraft = {
  amountMinor: string;
  destinationReference: string;
  observedOutcome: "confirmed" | "unknown";
  occurredAt: string;
  reason: string;
};

type ReconciliationDraft = {
  reportId: string;
  outcome: "confirm_outflow" | "confirm_no_outflow";
  occurredAt: string;
  reason: string;
};

function newIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("Secure random UUID generation is unavailable");
  }
  return globalThis.crypto.randomUUID();
}

function localNow(): string {
  const instant = new Date();
  return new Date(instant.getTime() - instant.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 23);
}

function usd(minor: string): string {
  const value = BigInt(minor);
  const dollars = value / 100n;
  const cents = (value % 100n).toString().padStart(2, "0");
  return `$${dollars.toLocaleString("en-US")}.${cents}`;
}

function statusLabel(status: ManualReceiptOutflowReport["status"]): string {
  return {
    confirmed: "confirmed outflow",
    unknown: "unknown — reconciliation required",
    confirmed_outflow: "reconciled: outflow confirmed",
    no_outflow: "reconciled: no outflow",
  }[status];
}

export function ManualReceiptOutflowPanel({
  clientAccountId,
  receipt,
  password,
  disabled = false,
  onPasswordConsumed,
  onRefresh,
  onNotice,
  onError,
}: Props) {
  const [reportDraft, setReportDraft] = useState<ReportDraft | null>(null);
  const [reconciliationDraft, setReconciliationDraft] =
    useState<ReconciliationDraft | null>(null);
  const [pending, setPending] = useState(false);
  const intentKeys = useRef(new Map<string, string>());
  const source = receipt.originalSourceOutflow;
  const reportReady =
    reportDraft !== null &&
    /^[1-9]\d*$/.test(reportDraft.amountMinor) &&
    BigInt(reportDraft.amountMinor) <= BigInt(source.availableMinor) &&
    reportDraft.destinationReference.trim().length > 0 &&
    reportDraft.destinationReference.trim().length <= 200 &&
    reportDraft.reason.trim().length >= 10 &&
    reportDraft.reason.trim().length <= 1_000 &&
    (reportDraft.observedOutcome === "unknown" || reportDraft.occurredAt.length > 0) &&
    password.length > 0;
  const reconciliationReady =
    reconciliationDraft !== null &&
    reconciliationDraft.reason.trim().length >= 10 &&
    reconciliationDraft.reason.trim().length <= 1_000 &&
    (reconciliationDraft.outcome === "confirm_no_outflow" ||
      reconciliationDraft.occurredAt.length > 0) &&
    password.length > 0;

  async function submitReport(): Promise<void> {
    if (!reportDraft || !reportReady || pending || disabled) return;
    const payload = {
      expectedAvailableMinor: source.availableMinor,
      amountMinor: reportDraft.amountMinor,
      currency: receipt.currency,
      destination: "original_source" as const,
      destinationReference: reportDraft.destinationReference.trim(),
      observedOutcome: reportDraft.observedOutcome,
      occurredAt:
        reportDraft.observedOutcome === "confirmed"
          ? new Date(reportDraft.occurredAt).toISOString()
          : null,
      reason: reportDraft.reason.trim(),
    };
    const identity = JSON.stringify({ clientAccountId, receipt: receipt.manualReceiptId, ...payload });
    const idempotencyKey = intentKeys.current.get(identity) ?? newIdempotencyKey();
    intentKeys.current.set(identity, idempotencyKey);
    setPending(true);
    onError("");
    try {
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      onPasswordConsumed();
      const outcome = await api<Outcome>(
        `/api/v1/admin/client-accounts/${clientAccountId}/manual-receipts/${receipt.manualReceiptId}/outflow-reports`,
        {
          method: "POST",
          body: JSON.stringify({ ...payload, idempotencyKey }),
        },
      );
      intentKeys.current.delete(identity);
      setReportDraft(null);
      await onRefresh();
      onNotice(
        outcome.status === "unknown"
          ? `${outcome.replayed ? "Replayed" : "Recorded"} unknown original-source outflow. Capacity is frozen until staff reconciles it; no outflow ledger was posted.`
          : `${outcome.replayed ? "Replayed" : "Recorded"} confirmed original-source outflow with one immutable balanced journal. No Provider was called.`,
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : "Outflow report could not be recorded");
    } finally {
      setPending(false);
    }
  }

  async function submitReconciliation(): Promise<void> {
    if (!reconciliationDraft || !reconciliationReady || pending || disabled) return;
    const payload = {
      outcome: reconciliationDraft.outcome,
      occurredAt:
        reconciliationDraft.outcome === "confirm_outflow"
          ? new Date(reconciliationDraft.occurredAt).toISOString()
          : null,
      reason: reconciliationDraft.reason.trim(),
    };
    const identity = JSON.stringify({
      clientAccountId,
      receipt: receipt.manualReceiptId,
      report: reconciliationDraft.reportId,
      ...payload,
    });
    const idempotencyKey = intentKeys.current.get(identity) ?? newIdempotencyKey();
    intentKeys.current.set(identity, idempotencyKey);
    setPending(true);
    onError("");
    try {
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      onPasswordConsumed();
      const outcome = await api<Outcome>(
        `/api/v1/admin/client-accounts/${clientAccountId}/manual-receipts/${receipt.manualReceiptId}/outflow-reports/${reconciliationDraft.reportId}/reconciliation`,
        {
          method: "POST",
          body: JSON.stringify({ ...payload, idempotencyKey }),
        },
      );
      intentKeys.current.delete(identity);
      setReconciliationDraft(null);
      await onRefresh();
      onNotice(
        outcome.status === "no_outflow"
          ? `${outcome.replayed ? "Replayed" : "Recorded"} no-outflow reconciliation. The frozen original-source capacity is available again.`
          : `${outcome.replayed ? "Replayed" : "Recorded"} confirmed outflow reconciliation with one immutable balanced journal. No Provider was called.`,
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : "Outflow reconciliation could not be recorded");
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="manual-receipt-reversal-review"
      data-testid="manual-receipt-original-source-outflow"
    >
      <p className="notice">
        Original-source return: {usd(source.availableMinor)} available · {" "}
        {usd(source.confirmedOutflowMinor)} confirmed outflow
        {source.capacityFrozen ? " · frozen for reconciliation" : ""}. Mock-only; no
        Payment Provider is used.
      </p>
      {!receipt.reversal && !source.capacityFrozen && BigInt(source.availableMinor) > 0n &&
        !reportDraft && (
          <button
            disabled={disabled || pending}
            onClick={() =>
              setReportDraft({
                amountMinor: source.availableMinor,
                destinationReference: "",
                observedOutcome: "confirmed",
                occurredAt: localNow(),
                reason: "",
              })
            }
          >
            Report original-source outflow
          </button>
        )}
      {reportDraft && (
        <div className="manual-receipt-reversal-review" aria-label="Original-source outflow report">
          <p className="notice">
            Destination is fixed to <strong>original source</strong>. Choose confirmed only when
            independent evidence proves money left; choose unknown to freeze capacity without
            posting an outflow.
          </p>
          <label>
            <span>Amount (USD cents)</span>
            <input
              aria-label="Original-source outflow amount in cents"
              disabled={disabled || pending}
              inputMode="numeric"
              value={reportDraft.amountMinor}
              onChange={(event) =>
                setReportDraft({ ...reportDraft, amountMinor: event.target.value })
              }
            />
          </label>
          <label>
            <span>Original-source destination reference</span>
            <input
              aria-label="Original-source destination reference"
              disabled={disabled || pending}
              maxLength={200}
              value={reportDraft.destinationReference}
              onChange={(event) =>
                setReportDraft({ ...reportDraft, destinationReference: event.target.value })
              }
              placeholder="Synthetic bank return reference"
            />
          </label>
          <label>
            <span>Observed result</span>
            <select
              aria-label="Original-source outflow observed result"
              disabled={disabled || pending}
              value={reportDraft.observedOutcome}
              onChange={(event) =>
                setReportDraft({
                  ...reportDraft,
                  observedOutcome: event.target.value as "confirmed" | "unknown",
                })
              }
            >
              <option value="confirmed">Confirmed outflow</option>
              <option value="unknown">Result unknown</option>
            </select>
          </label>
          {reportDraft.observedOutcome === "confirmed" && (
            <label>
              <span>Outflow occurred at</span>
              <input
                aria-label="Original-source outflow occurred at"
                type="datetime-local"
                step="0.001"
                disabled={disabled || pending}
                value={reportDraft.occurredAt}
                onChange={(event) =>
                  setReportDraft({ ...reportDraft, occurredAt: event.target.value })
                }
              />
            </label>
          )}
          <label>
            <span>Reason and independent evidence</span>
            <textarea
              aria-label="Original-source outflow reason"
              disabled={disabled || pending}
              maxLength={1_000}
              value={reportDraft.reason}
              onChange={(event) => setReportDraft({ ...reportDraft, reason: event.target.value })}
              placeholder="Evidence checked and why this is the exact original-source return (10+ characters)"
            />
          </label>
          <div className="fund-actions">
            <button
              className="primary"
              disabled={disabled || pending || !reportReady}
              onClick={() => void submitReport()}
            >
              {pending ? "Recording…" : "Record outflow report"}
            </button>
            <button disabled={disabled || pending} onClick={() => setReportDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {source.reports.map((report) => {
        const reconciling = reconciliationDraft?.reportId === report.outflowReportId;
        return (
          <article
            className="manual-item"
            data-testid="manual-receipt-outflow-report"
            data-report-status={report.status}
            key={report.outflowReportId}
          >
            <div>
              <strong>
                {usd(report.amountMinor)} · {statusLabel(report.status)}
              </strong>
              <span>
                Original source · {report.destinationReference} · reported {" "}
                {new Date(report.createdAt).toLocaleString()}
              </span>
              <span>{report.reason}</span>
              <span className="mono">report {report.outflowReportId}</span>
            </div>
            {report.status === "unknown" && !reconciling && (
              <button
                disabled={disabled || pending}
                onClick={() =>
                  setReconciliationDraft({
                    reportId: report.outflowReportId,
                    outcome: "confirm_outflow",
                    occurredAt: localNow(),
                    reason: "",
                  })
                }
              >
                Reconcile unknown result
              </button>
            )}
            {report.status === "unknown" && reconciling && reconciliationDraft && (
              <div className="manual-receipt-reversal-review" aria-label="Unknown outflow reconciliation">
                <label>
                  <span>Final result</span>
                  <select
                    aria-label="Unknown outflow final result"
                    disabled={disabled || pending}
                    value={reconciliationDraft.outcome}
                    onChange={(event) =>
                      setReconciliationDraft({
                        ...reconciliationDraft,
                        outcome: event.target.value as
                          | "confirm_outflow"
                          | "confirm_no_outflow",
                      })
                    }
                  >
                    <option value="confirm_outflow">Confirm money left</option>
                    <option value="confirm_no_outflow">Confirm no money left</option>
                  </select>
                </label>
                {reconciliationDraft.outcome === "confirm_outflow" && (
                  <label>
                    <span>Outflow occurred at</span>
                    <input
                      aria-label="Reconciled outflow occurred at"
                      type="datetime-local"
                      step="0.001"
                      disabled={disabled || pending}
                      value={reconciliationDraft.occurredAt}
                      onChange={(event) =>
                        setReconciliationDraft({
                          ...reconciliationDraft,
                          occurredAt: event.target.value,
                        })
                      }
                    />
                  </label>
                )}
                <label>
                  <span>Reconciliation evidence and reason</span>
                  <textarea
                    aria-label="Unknown outflow reconciliation reason"
                    disabled={disabled || pending}
                    maxLength={1_000}
                    value={reconciliationDraft.reason}
                    onChange={(event) =>
                      setReconciliationDraft({
                        ...reconciliationDraft,
                        reason: event.target.value,
                      })
                    }
                    placeholder="Independent evidence supporting the final result (10+ characters)"
                  />
                </label>
                <div className="fund-actions">
                  <button
                    className="primary"
                    disabled={disabled || pending || !reconciliationReady}
                    onClick={() => void submitReconciliation()}
                  >
                    {pending ? "Reconciling…" : "Record final result"}
                  </button>
                  <button
                    disabled={disabled || pending}
                    onClick={() => setReconciliationDraft(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}
