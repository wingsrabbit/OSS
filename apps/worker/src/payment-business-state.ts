// SPDX-License-Identifier: AGPL-3.0-or-later

type PaymentBusinessState = {
  paymentContext: "order" | "renewal";
  orderStatus: string;
  renewalStatus: string | null;
  serviceStatus: string;
};

export function isPaymentBusinessStatePayable(state: PaymentBusinessState): boolean {
  if (state.paymentContext === "order") return state.orderStatus === "waiting_payment";

  return (
    state.renewalStatus === "invoiced" &&
    (state.serviceStatus === "active" || state.serviceStatus === "suspended")
  );
}
