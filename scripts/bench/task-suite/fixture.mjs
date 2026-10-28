/**
 * Deterministic task-suite fixture for the MCP task benchmark (development
 * only; never imported by src/). Generates a small "shop" project that mixes a
 * TypeScript HTTP API, a Python data layer with migrations, a refactor target
 * used across modules, one very large legacy file and a set of distractors, and
 * defines the tasks with their ground truth.
 *
 * Ground truth is written by hand from the fixture, not derived from any
 * retriever output:
 *   edit    files a correct change has to modify (must be read)
 *   support contracts / callers / tests a careful change has to look at
 */
import fs from "node:fs";
import path from "node:path";

export const LARGE_FILE_FUNCTIONS = 140;
export const LARGE_FILE_TARGET = "computeQuarterlyTotals";
const REFACTOR_USERS = [
  "src/services/orderService.ts",
  "src/routes/orders.ts",
  "src/reports/orderReport.ts",
  "src/notifications/orderEmail.ts",
  "src/services/paymentService.ts",
  "src/routes/customers.ts",
];

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

export function buildTaskFixture(root) {
  // ---- TypeScript API ---------------------------------------------------
  write(
    root,
    "src/utils/money.ts",
    `export interface Money {
  cents: number;
  currency: string;
}

export function formatMoney(m: Money): string {
  return (m.cents / 100).toFixed(2) + " " + m.currency;
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error("currency mismatch");
  return { cents: a.cents + b.cents, currency: a.currency };
}
`
  );
  write(
    root,
    "src/utils/validation.ts",
    `import type { Order } from "../models/order";

export class ValidationError extends Error {}

export function validateOrderInput(input: Partial<Order>): void {
  if (!input.customerId) throw new ValidationError("customerId required");
  if (!input.items || input.items.length === 0) throw new ValidationError("items required");
  if (input.shippingAddress !== undefined && input.shippingAddress.length > 200) {
    throw new ValidationError("shippingAddress too long");
  }
}
`
  );
  write(
    root,
    "src/middleware/auth.ts",
    `export interface AuthedRequest {
  userId: string;
  roles: string[];
  params: Record<string, string>;
  body: Record<string, unknown>;
}

/** Security check: every order route must run behind this. */
export function requireAuth(req: AuthedRequest): void {
  if (!req.userId) throw new Error("401 unauthenticated");
}

/** Security check: a caller may only touch their own orders unless they are staff. */
export function assertOwner(req: AuthedRequest, ownerId: string): void {
  if (req.userId !== ownerId && !req.roles.includes("staff")) {
    throw new Error("403 forbidden");
  }
}
`
  );
  write(
    root,
    "src/models/order.ts",
    `export type OrderStatus = "pending" | "paid" | "shipped" | "cancelled";

export interface Order {
  id: string;
  customerId: string;
  items: string[];
  totalCents: number;
  status: OrderStatus;
  shippingAddress?: string;
}

const store = new Map<string, Order>();

export function saveOrder(order: Order): Order {
  store.set(order.id, order);
  return order;
}

export function findOrderById(id: string): Order | undefined {
  return store.get(id);
}
`
  );
  write(
    root,
    "src/models/customer.ts",
    `export interface Customer {
  id: string;
  email: string;
}

export function findCustomer(id: string): Customer | undefined {
  return id ? { id, email: id + "@example.com" } : undefined;
}
`
  );
  write(
    root,
    "src/services/paymentService.ts",
    `import { formatMoney } from "../utils/money";

export function chargeCard(customerId: string, cents: number): string {
  return "charge-" + customerId + "-" + formatMoney({ cents, currency: "USD" });
}

export function refundPayment(paymentRef: string, cents: number): string {
  return "refund-" + paymentRef + "-" + formatMoney({ cents, currency: "USD" });
}
`
  );
  write(
    root,
    "src/services/orderService.ts",
    `import { Order, saveOrder, findOrderById } from "../models/order";
import { chargeCard, refundPayment } from "./paymentService";
import { formatMoney } from "../utils/money";

export function createOrder(input: Omit<Order, "status" | "id">): Order {
  const order: Order = { ...input, id: "o-" + Math.random().toString(36).slice(2), status: "pending" };
  chargeCard(order.customerId, order.totalCents);
  return saveOrder({ ...order, status: "paid" });
}

export function applyDiscount(order: Order, percent: number): Order {
  const discounted = Math.round(order.totalCents * (1 - percent / 100));
  console.log("discount applied: " + formatMoney({ cents: discounted, currency: "USD" }));
  return saveOrder({ ...order, totalCents: discounted });
}

export function cancelOrder(orderId: string): Order {
  const order = findOrderById(orderId);
  if (!order) throw new Error("order not found");
  if (order.status === "cancelled") return order;
  if (order.status === "paid") {
    refundPayment("ref-" + order.id, order.totalCents);
  }
  return saveOrder({ ...order, status: "cancelled" });
}
`
  );
  write(
    root,
    "src/routes/orders.ts",
    `import { requireAuth, assertOwner, AuthedRequest } from "../middleware/auth";
import { createOrder, cancelOrder } from "../services/orderService";
import { findOrderById } from "../models/order";
import { validateOrderInput } from "../utils/validation";
import { formatMoney } from "../utils/money";

export function createOrderHandler(req: AuthedRequest) {
  requireAuth(req);
  validateOrderInput(req.body);
  return createOrder(req.body as never);
}

export function getOrderHandler(req: AuthedRequest) {
  requireAuth(req);
  const order = findOrderById(req.params.id);
  if (!order) throw new Error("404");
  assertOwner(req, order.customerId);
  return { ...order, total: formatMoney({ cents: order.totalCents, currency: "USD" }) };
}

export function cancelOrderHandler(req: AuthedRequest) {
  requireAuth(req);
  const order = findOrderById(req.params.id);
  if (!order) throw new Error("404");
  assertOwner(req, order.customerId);
  return cancelOrder(order.id);
}

export function registerOrderRoutes(app: { post: Function; get: Function; delete: Function }) {
  app.post("/orders", createOrderHandler);
  app.get("/orders/:id", getOrderHandler);
  app.delete("/orders/:id", cancelOrderHandler);
}
`
  );
  write(
    root,
    "src/routes/customers.ts",
    `import { requireAuth, AuthedRequest } from "../middleware/auth";
import { findCustomer } from "../models/customer";
import { formatMoney } from "../utils/money";

export function getCustomerHandler(req: AuthedRequest) {
  requireAuth(req);
  const c = findCustomer(req.params.id);
  return { ...c, credit: formatMoney({ cents: 0, currency: "USD" }) };
}

export function registerCustomerRoutes(app: { get: Function }) {
  app.get("/customers/:id", getCustomerHandler);
}
`
  );
  write(
    root,
    "src/routes/index.ts",
    `import { registerOrderRoutes } from "./orders";
import { registerCustomerRoutes } from "./customers";

export function registerAll(app: never) {
  registerOrderRoutes(app);
  registerCustomerRoutes(app);
}
`
  );
  write(
    root,
    "src/reports/orderReport.ts",
    `import { formatMoney } from "../utils/money";
import type { Order } from "../models/order";

export function renderOrderReport(orders: Order[]): string {
  return orders.map((o) => o.id + ": " + formatMoney({ cents: o.totalCents, currency: "USD" })).join("\\n");
}
`
  );
  write(
    root,
    "src/notifications/orderEmail.ts",
    `import { formatMoney } from "../utils/money";
import type { Order } from "../models/order";

export function buildOrderEmail(order: Order): string {
  return "Your order total is " + formatMoney({ cents: order.totalCents, currency: "USD" });
}
`
  );
  write(
    root,
    "src/__tests__/orders.route.test.ts",
    `import { createOrderHandler, getOrderHandler } from "../routes/orders";

describe("order routes", () => {
  it("requires auth", () => {
    expect(() => createOrderHandler({ userId: "", roles: [], params: {}, body: {} })).toThrow();
  });
  it("loads an order", () => {
    expect(getOrderHandler).toBeDefined();
  });
});
`
  );
  write(
    root,
    "src/__tests__/orderService.test.ts",
    `import { cancelOrder, applyDiscount } from "../services/orderService";

describe("orderService", () => {
  it("cancels a missing order with an error", () => {
    expect(() => cancelOrder("nope")).toThrow();
  });
  it("applies a discount", () => {
    expect(applyDiscount).toBeDefined();
  });
});
`
  );

  // ---- Python data layer with migrations --------------------------------
  write(
    root,
    "backend/models/invoice.py",
    `from dataclasses import dataclass


@dataclass
class Invoice:
    id: int
    customer_id: str
    amount_cents: int
    tax_cents: int = 0

    def total_cents(self) -> int:
        return self.amount_cents + self.tax_cents
`
  );
  write(
    root,
    "backend/repositories/invoice_repo.py",
    `from backend.models.invoice import Invoice

_rows = {}


def save_invoice(invoice: Invoice) -> Invoice:
    _rows[invoice.id] = (invoice.customer_id, invoice.amount_cents, invoice.tax_cents)
    return invoice


def find_invoice(invoice_id: int):
    row = _rows.get(invoice_id)
    if row is None:
        return None
    return Invoice(invoice_id, row[0], row[1], row[2])
`
  );
  write(
    root,
    "backend/api/invoices.py",
    `from backend.models.invoice import Invoice
from backend.repositories.invoice_repo import save_invoice


def create_invoice(payload: dict) -> Invoice:
    invoice = Invoice(payload["id"], payload["customer_id"], payload["amount_cents"])
    return save_invoice(invoice)
`
  );
  write(
    root,
    "backend/migrations/0001_create_invoice.py",
    `operations = [
    {"op": "create_table", "name": "invoice", "columns": ["id", "customer_id", "amount_cents"]},
]
dependencies = []
`
  );
  write(
    root,
    "backend/migrations/0002_add_tax.py",
    `operations = [
    {"op": "add_column", "table": "invoice", "column": "tax_cents", "default": 0},
]
dependencies = ["0001_create_invoice"]
`
  );
  write(
    root,
    "backend/tests/test_invoice_repo.py",
    `from backend.models.invoice import Invoice
from backend.repositories.invoice_repo import save_invoice, find_invoice


def test_roundtrip():
    save_invoice(Invoice(1, "c1", 500))
    assert find_invoice(1).total_cents() == 500
`
  );

  // ---- Large legacy file -------------------------------------------------
  const big = [`// Legacy report engine: generated sections. Do not hand-edit lightly.`, ``];
  for (let i = 0; i < LARGE_FILE_FUNCTIONS; i++) {
    const name = i === 70 ? LARGE_FILE_TARGET : `buildSection${i}`;
    big.push(`export function ${name}(rows: number[]): number {`);
    big.push(`  let acc = ${i};`);
    for (let k = 0; k < 18; k++) big.push(`  acc += (rows[${k % 4}] ?? 0) * ${k + 1};`);
    if (i === 70)
      big.push(`  return Math.floor(acc / 3); // rounds down: wrong for negative totals`);
    else big.push(`  return acc;`);
    big.push(`}`, ``);
  }
  write(root, "src/legacy/reportEngine.ts", big.join("\n"));

  // ---- Distractors (similar vocabulary, unrelated behaviour) --------------
  for (let i = 0; i < 70; i++) {
    write(
      root,
      `src/features/f${i}/feature${i}.ts`,
      `export interface Feature${i}Config { enabled: boolean; weight: number }

export function computeFeature${i}Total(items: number[], cfg: Feature${i}Config): number {
  // order of operations matters: weight first, then sum
  return items.reduce((a, b) => a + b * cfg.weight, 0) * (cfg.enabled ? 1 : 0);
}

export function describeFeature${i}(cfg: Feature${i}Config): string {
  return "feature ${i} " + (cfg.enabled ? "on" : "off");
}
`
    );
  }
  write(
    root,
    "src/services/shippingService.ts",
    `export function estimateShipping(weightKg: number): number {
  return Math.ceil(weightKg) * 150;
}

export function cancelShipment(trackingId: string): string {
  return "cancelled " + trackingId;
}
`
  );
  write(
    root,
    "README.md",
    "# Shop\n\nOrders API, invoices data layer and a legacy report engine.\n"
  );
}

// Each task: id, category, the natural-language request, and ground truth.
export const TASKS = [
  {
    id: "exact-symbol",
    category: "exact symbol lookup",
    task: "find where applyDiscount is defined",
    edit: ["src/services/orderService.ts"],
    support: [],
  },
  {
    id: "explain-function",
    category: "function explanation",
    task: "explain how cancelOrder works",
    edit: ["src/services/orderService.ts"],
    support: ["src/services/paymentService.ts", "src/models/order.ts"],
  },
  {
    id: "bugfix-local",
    category: "localized bug fix",
    task: "fix bug: cancelOrder does not refund the payment when the order is shipped",
    edit: ["src/services/orderService.ts"],
    support: [
      "src/services/paymentService.ts",
      "src/models/order.ts",
      "src/__tests__/orderService.test.ts",
    ],
  },
  {
    id: "api-endpoint",
    category: "API endpoint change",
    task: "add a PATCH /orders/:id endpoint that updates the shipping address of an order",
    edit: ["src/routes/orders.ts", "src/services/orderService.ts"],
    support: [
      "src/middleware/auth.ts",
      "src/utils/validation.ts",
      "src/models/order.ts",
      "src/__tests__/orders.route.test.ts",
    ],
  },
  {
    id: "db-migration",
    category: "database model and migration change",
    task: "add a currency column to the Invoice model and write a migration for it",
    edit: ["backend/models/invoice.py"],
    support: [
      "backend/migrations/0002_add_tax.py",
      "backend/repositories/invoice_repo.py",
      "backend/tests/test_invoice_repo.py",
    ],
  },
  {
    id: "refactor-cross-module",
    category: "cross-module refactoring",
    task: "rename formatMoney to formatCurrency everywhere it is used",
    edit: ["src/utils/money.ts", ...REFACTOR_USERS],
    support: [],
  },
  {
    id: "large-file",
    category: "large-file retrieval",
    task: `fix the rounding bug in ${LARGE_FILE_TARGET}`,
    edit: ["src/legacy/reportEngine.ts"],
    support: [],
    // The edit file is ~3,000 lines: delivering the declaration, not the file.
    span: { file: "src/legacy/reportEngine.ts", mustContain: `function ${LARGE_FILE_TARGET}` },
    maxFileFraction: 0.5,
  },
];
