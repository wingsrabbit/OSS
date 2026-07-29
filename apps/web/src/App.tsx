// SPDX-License-Identifier: AGPL-3.0-or-later

import { LAB_BANNER } from "@opensales/core";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Locale = "en" | "zh-CN";
type Me = {
  id: string;
  email: string;
  locale: Locale;
  clientAccountId: string;
  membershipRole: string;
  verification: { email: "pending" | "passed" };
  eligible: boolean;
  staff: { roles: string[]; permissions: unknown } | null;
};
type Price = {
  id: string;
  currency: string;
  billingCycle: string;
  oneTimeMinor: string;
  setupMinor: string;
  recurringMinor: string;
};
type Product = {
  id: string;
  groupId: string;
  groupName: string;
  name: string;
  description: string;
  fulfillmentMode: "automatic" | "review" | "manual" | "quote";
  optionSchema: Array<Record<string, unknown>>;
  prices: Price[];
  purchasable: boolean;
};
type Legal = {
  documents: Record<"terms" | "aup" | "privacy", { version: string; title: string; body: string }>;
};
type OrderDetail = {
  order: { id: string; status: string; price: { productName: string } };
  invoice: {
    id: string;
    currency: string;
    totalMinor: string;
    allocatedMinor: string;
    dueMinor: string;
    status: string;
  };
  payment: { status: string | null };
  provisioning: { status: string | null };
  service: {
    id: string;
    status: string;
    activatedAt: string | null;
    termStart: string | null;
    termEnd: string | null;
  };
};
type LabMessage = {
  id: string;
  subject: string;
  body: string;
  status: string;
  deliveredAt: string;
};
type ManualItem = {
  serviceId: string;
  orderId: string;
  productName: string;
  billingCycle: string;
  clientAccountName: string;
  paidMinor: string;
  totalMinor: string;
  submittedAt: string;
};

const words = {
  en: {
    catalog: "Product catalog",
    account: "Customer account",
    register: "Register",
    login: "Sign in",
    verify: "Verify email",
    buy: "Configure & order",
    pay: "Start mock payment",
    pending: "Verification is required before ordering or paying.",
    ready: "Email verified — account is eligible to purchase.",
  },
  "zh-CN": {
    catalog: "产品目录",
    account: "客户账号",
    register: "注册",
    login: "登录",
    verify: "验证邮箱",
    buy: "配置并下单",
    pay: "发起 Mock 付款",
    pending: "完成邮箱验证后才能下单或付款。",
    ready: "邮箱已验证，可以购买。",
  },
} as const;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
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
    throw new Error(errorBody.error ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function usd(minor: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(minor) / 100);
}

export function App() {
  const [locale, setLocale] = useState<Locale>("en");
  const [products, setProducts] = useState<Product[]>([]);
  const [legal, setLegal] = useState<Legal | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [selected, setSelected] = useState<{ product: Product; price: Price } | null>(null);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [notice, setNotice] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [paymentScenario, setPaymentScenario] = useState("success");
  const [quantity, setQuantity] = useState(1);
  const [mail, setMail] = useState<LabMessage[]>([]);
  const [manualItems, setManualItems] = useState<ManualItem[]>([]);
  const [adminPassword, setAdminPassword] = useState("");
  const [manualReason, setManualReason] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const text = words[locale];

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api<Me>("/api/v1/auth/me"));
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    void Promise.all([
      api<{ products: Product[] }>(`/api/v1/catalog?locale=${locale}`).then((data) =>
        setProducts(data.products),
      ),
      api<Legal>(`/api/v1/legal/current?locale=${locale}`).then(setLegal),
      refreshMe(),
    ]).catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : "Unable to load the laboratory"),
    );
  }, [locale, refreshMe]);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) return;
    void api<{ status: string }>("/api/v1/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token }),
    })
      .then(async (result) => {
        setNotice(`Email verification: ${result.status}`);
        window.history.replaceState({}, "", window.location.pathname);
        await refreshMe();
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : "Verification failed"),
      );
  }, [refreshMe]);

  useEffect(() => {
    if (!order || ["active", "provisioned_hold"].includes(order.service.status)) return;
    const timer = window.setInterval(() => {
      void api<OrderDetail>(`/api/v1/orders/${order.order.id}`)
        .then(setOrder)
        .catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [order]);

  const refreshManualItems = useCallback(async () => {
    if (!me?.staff) {
      setManualItems([]);
      return;
    }
    const result = await api<{ items: ManualItem[] }>("/api/v1/admin/manual-fulfillment");
    setManualItems(result.items);
  }, [me?.staff]);

  useEffect(() => {
    void refreshManualItems().catch(() => undefined);
  }, [refreshManualItems]);

  const groups = useMemo(() => {
    const result = new Map<string, Product[]>();
    for (const product of products) {
      const current = result.get(product.groupName) ?? [];
      current.push(product);
      result.set(product.groupName, current);
    }
    return result;
  }, [products]);

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      await api("/api/v1/auth/register", {
        method: "POST",
        body: JSON.stringify({
          email: data.get("email"),
          password: data.get("password"),
          clientName: data.get("clientName"),
          locale,
        }),
      });
      setNotice("Account created. The verification message is being delivered to Provider Lab.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Registration failed");
    }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      await api("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: data.get("email"), password: data.get("password") }),
      });
      await refreshMe();
      setNotice("Signed in.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign in failed");
    }
  }

  async function createOrder() {
    if (!selected || !legal) return;
    setError("");
    try {
      const configuration =
        selected.product.id === "gsl-inbound" ? { bandwidth_units: quantity } : {};
      const created = await api<{ orderId: string }>("/api/v1/orders", {
        method: "POST",
        body: JSON.stringify({
          priceId: selected.price.id,
          configuration,
          termsVersion: legal.documents.terms.version,
          aupVersion: legal.documents.aup.version,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      setOrder(await api<OrderDetail>(`/api/v1/orders/${created.orderId}`));
      setSelected(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Checkout failed");
    }
  }

  async function startPayment() {
    if (!order) return;
    setError("");
    try {
      await api(`/api/v1/invoices/${order.invoice.id}/payments`, {
        method: "POST",
        body: JSON.stringify({
          scenario: paymentScenario,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      setOrder(await api<OrderDetail>(`/api/v1/orders/${order.order.id}`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Payment could not start");
    }
  }

  async function openLabMailbox() {
    setError("");
    try {
      const result = await api<{ messages: LabMessage[] }>("/api/v1/lab/mailbox");
      setMail(result.messages);
      if (result.messages.length === 0) {
        setNotice("The Mock Mail Provider has not delivered a message yet. Try again shortly.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Mock mailbox is unavailable");
    }
  }

  async function bootstrapAdministrator() {
    setError("");
    try {
      await api("/api/v1/admin/bootstrap", {
        method: "POST",
        body: JSON.stringify({ bootstrapToken }),
      });
      setBootstrapToken("");
      await refreshMe();
      setNotice("Administrator role created. The bootstrap token is now unusable.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Administrator bootstrap failed");
    }
  }

  async function completeManual(serviceId: string) {
    setError("");
    try {
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: adminPassword }),
      });
      await api(`/api/v1/admin/services/${serviceId}/complete-manual`, {
        method: "POST",
        body: JSON.stringify({ reason: manualReason }),
      });
      setAdminPassword("");
      setManualReason("");
      await refreshManualItems();
      setNotice("Manual service marked Ready for Service with an audited activation time.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Manual fulfillment failed");
    }
  }

  return (
    <>
      <div className="lab-banner">{LAB_BANNER}</div>
      <header>
        <a className="brand" href="/">
          <span>OSS</span>
          OpenSales System
        </a>
        <div className="header-actions">
          <button onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")}>
            {locale === "en" ? "简体中文" : "English"}
          </button>
          <span className={me?.eligible ? "pill good" : "pill"}>
            {me ? me.email : "Guest"}
          </span>
        </div>
      </header>
      <main>
        <section className="hero">
          <p className="eyebrow">Mock-only laboratory release</p>
          <h1>Customer, billing and service operations — without vendor lock-in.</h1>
          <p>
            This synthetic environment separates orders, money, provider operations and services so
            that failures remain visible and recoverable.
          </p>
        </section>

        {(notice || error) && (
          <div className={error ? "notice error" : "notice"}>
            {error || notice}
            <button onClick={() => (error ? setError("") : setNotice(""))}>×</button>
          </div>
        )}

        <section className="account-grid">
          <div className="panel">
            <p className="eyebrow">{text.account}</p>
            {me ? (
              <>
                <h2>{me.email}</h2>
                <p>{me.eligible ? text.ready : text.pending}</p>
                <div className="status-row">
                  <span>Email verification</span>
                  <strong>{me.verification.email}</strong>
                </div>
                {!me.eligible && (
                  <>
                    <button className="primary" onClick={openLabMailbox}>
                      Open my Mock Provider mailbox
                    </button>
                    {mail.map((message) => {
                      const verificationUrl = message.body.match(/https?:\/\/\S+/)?.[0];
                      return (
                        <div className="mock-message" key={message.id}>
                          <strong>{message.subject}</strong>
                          <span>
                            {message.status} · {new Date(message.deliveredAt).toLocaleString()}
                          </span>
                          {verificationUrl && <a href={verificationUrl}>Use one-time verification link</a>}
                        </div>
                      );
                    })}
                  </>
                )}
              </>
            ) : (
              <div className="form-columns">
                <form onSubmit={register}>
                  <h3>{text.register}</h3>
                  <input name="clientName" placeholder="Client account name" required />
                  <input name="email" type="email" placeholder="Email" required />
                  <input
                    name="password"
                    type="password"
                    minLength={12}
                    placeholder="Password (12+ characters)"
                    required
                  />
                  <button className="primary" type="submit">
                    {text.register}
                  </button>
                </form>
                <form onSubmit={login}>
                  <h3>{text.login}</h3>
                  <input name="email" type="email" placeholder="Email" required />
                  <input name="password" type="password" placeholder="Password" required />
                  <button className="primary" type="submit">
                    {text.login}
                  </button>
                </form>
              </div>
            )}
          </div>
        </section>

        {me?.eligible && !me.staff && (
          <section className="bootstrap-panel">
            <div>
              <p className="eyebrow">One-time laboratory setup</p>
              <h2>Establish the first administrator</h2>
              <p>
                Generate a 15-minute, single-use token with the server-side CLI. There is no fixed
                default administrator password.
              </p>
            </div>
            <div className="inline-form">
              <input
                type="password"
                value={bootstrapToken}
                onChange={(event) => setBootstrapToken(event.target.value)}
                placeholder="Single-use bootstrap token"
              />
              <button
                className="primary"
                disabled={bootstrapToken.length < 32}
                onClick={bootstrapAdministrator}
              >
                Create administrator
              </button>
            </div>
          </section>
        )}

        {me?.staff && (
          <section className="admin-panel">
            <div>
              <p className="eyebrow">Administrator · manual fulfillment</p>
              <h2>Paid services waiting for a human Ready decision</h2>
            </div>
            {manualItems.length === 0 ? (
              <p className="muted">No paid manual services are waiting.</p>
            ) : (
              <>
                <div className="inline-form admin-confirm">
                  <input
                    type="password"
                    value={adminPassword}
                    onChange={(event) => setAdminPassword(event.target.value)}
                    placeholder="Re-enter password (15-minute fixed window)"
                  />
                  <input
                    value={manualReason}
                    onChange={(event) => setManualReason(event.target.value)}
                    placeholder="Reason and delivery evidence (10+ characters)"
                  />
                </div>
                {manualItems.map((item) => (
                  <article className="manual-item" key={item.serviceId}>
                    <div>
                      <strong>{item.productName}</strong>
                      <span>
                        {item.clientAccountName} · {item.billingCycle} ·{" "}
                        {usd(item.paidMinor)} paid
                      </span>
                    </div>
                    <button
                      className="primary"
                      disabled={adminPassword.length === 0 || manualReason.trim().length < 10}
                      onClick={() => completeManual(item.serviceId)}
                    >
                      Confirm Ready for Service
                    </button>
                  </article>
                ))}
              </>
            )}
          </section>
        )}

        {order && (
          <section className="order-panel">
            <div>
              <p className="eyebrow">Live customer journey</p>
              <h2>{order.order.price.productName}</h2>
              <p className="mono">{order.order.id}</p>
            </div>
            <div className="journey">
              <Status label="Order" value={order.order.status} />
              <Status label="Invoice" value={order.invoice.status} />
              <Status label="Payment" value={order.payment.status ?? "not_started"} />
              <Status label="Provisioning" value={order.provisioning.status ?? "not_started"} />
              <Status label="Service" value={order.service.status} />
            </div>
            <div className="invoice-summary">
              <span>Total {usd(order.invoice.totalMinor)}</span>
              <span>Allocated {usd(order.invoice.allocatedMinor)}</span>
              <strong>Due {usd(order.invoice.dueMinor)}</strong>
            </div>
            {order.invoice.status !== "paid" && (
              <div className="payment-controls">
                <select
                  value={paymentScenario}
                  onChange={(event) => setPaymentScenario(event.target.value)}
                >
                  <option value="success">Success</option>
                  <option value="failed">Failure</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="timeout_success">Timeout but actually settled</option>
                  <option value="duplicate_out_of_order">Duplicate + out of order</option>
                </select>
                <button className="primary" disabled={!me?.eligible} onClick={startPayment}>
                  {text.pay}
                </button>
              </div>
            )}
            {order.service.activatedAt && (
              <p>
                Ready for service: <strong>{new Date(order.service.activatedAt).toLocaleString()}</strong>
                <br />
                Service term: {new Date(order.service.termStart!).toLocaleString()} →{" "}
                {order.service.termEnd
                  ? new Date(order.service.termEnd).toLocaleString()
                  : "one-time"}
              </p>
            )}
          </section>
        )}

        <section className="catalog">
          <p className="eyebrow">{text.catalog}</p>
          <h2>TermRat synthetic acceptance configuration</h2>
          {[...groups.entries()].map(([group, groupProducts]) => (
            <div className="product-group" key={group}>
              <h3>{group}</h3>
              <div className="product-grid">
                {groupProducts.map((product) => (
                  <article className="product-card" key={product.id}>
                    <div>
                      <span className={`mode mode-${product.fulfillmentMode}`}>
                        {product.fulfillmentMode}
                      </span>
                      <h4>{product.name}</h4>
                      <p>{product.description}</p>
                    </div>
                    <div className="prices">
                      {product.prices.map((price) => (
                        <button
                          key={price.id}
                          disabled={!product.purchasable}
                          onClick={() => setSelected({ product, price })}
                        >
                          <span>{price.billingCycle.replace("_", " ")}</span>
                          <strong>
                            {usd(
                              (
                                BigInt(price.oneTimeMinor) +
                                BigInt(price.setupMinor) +
                                BigInt(price.recurringMinor)
                              ).toString(),
                            )}
                          </strong>
                        </button>
                      ))}
                      {!product.purchasable && <p>Price confirmation required before payment.</p>}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ))}
        </section>
      </main>

      {selected && (
        <div className="modal-backdrop" role="presentation" onClick={() => setSelected(null)}>
          <section className="modal" role="dialog" onClick={(event) => event.stopPropagation()}>
            <button className="close" onClick={() => setSelected(null)}>
              ×
            </button>
            <p className="eyebrow">Checkout configuration</p>
            <h2>{selected.product.name}</h2>
            <p>
              {selected.price.billingCycle} ·{" "}
              {usd(
                (
                  BigInt(selected.price.oneTimeMinor) +
                  BigInt(selected.price.setupMinor) +
                  BigInt(selected.price.recurringMinor)
                ).toString(),
              )}
            </p>
            {selected.product.id === "gsl-inbound" && (
              <label>
                100 Mbps units
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={quantity}
                  onChange={(event) => setQuantity(Number(event.target.value))}
                />
              </label>
            )}
            <div className="legal-box">
              <strong>{legal?.documents.terms.title}</strong>
              <p>{legal?.documents.terms.body}</p>
              <strong>{legal?.documents.aup.title}</strong>
              <p>{legal?.documents.aup.body}</p>
            </div>
            <button className="primary wide" disabled={!me?.eligible} onClick={createOrder}>
              {me?.eligible ? text.buy : text.pending}
            </button>
          </section>
        </div>
      )}
    </>
  );
}

function Status({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value.replaceAll("_", " ")}</strong>
    </div>
  );
}
