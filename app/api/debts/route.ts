import { DB_NAME as MICOMERC_DB } from "@/lib/database";
import { createHash } from "node:crypto";
import clientPromise from "@/lib/mongodb";
import { normalizeDebtRequest } from "@/lib/debt";
import { applyStockDelta, ensureCollections, InventoryError, InventoryProduct, isTransactionUnavailable, MOVEMENT_COLLECTION, recordStockMovement, readLowStockThreshold, withInventoryTransaction } from "@/lib/inventory";
import type { ClientSession } from "mongodb";
import { NextResponse } from "next/server";

const DB_NAME = MICOMERC_DB;
const COLLECTION = "debts";
const PRODUCTS_COLLECTION = "products";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function publicDebt<T extends Record<string, unknown>>(debt: T) {
  const { _id, requestHash, ...value } = debt;
  return value;
}

// GET all debts
export async function GET() {
  try {
    const client = await clientPromise();
    const db = client.db(DB_NAME);

    const debts = await db
      .collection(COLLECTION)
      .find({})
      .sort({ id: 1 })
      .toArray();

    return NextResponse.json(debts.map((debt) => publicDebt(debt as Record<string, unknown>)));
  } catch (error) {
    console.error("Failed to fetch debts:", error);

    return NextResponse.json(
      { message: "Failed to fetch debts" },
      { status: 500 }
    );
  }
}

// POST a new debt
export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ message: "Request body must be valid JSON" }, { status: 400 });
    }

    const client = await clientPromise();
    const db = client.db(DB_NAME);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ message: "Debt details must be a JSON object" }, { status: 400 });
    }

    const key = "idempotencyKey" in body ? body.idempotencyKey : "";
    if (typeof key !== "string" || !UUID_PATTERN.test(key)) return NextResponse.json({ message: "A valid debt operation ID is required" }, { status: 400 });
    const products = Object.hasOwn(body, "item") ? [] : await db.collection(PRODUCTS_COLLECTION).find({}).toArray();
    const normalizedDebt = normalizeDebtRequest(body, products);
    const requestHash = createHash("sha256").update(JSON.stringify({ customer: normalizedDebt.customer, invoice: normalizedDebt.invoice, receiptNumber: normalizedDebt.receiptNumber ?? "", items: normalizedDebt.items, amount: normalizedDebt.amount, due: normalizedDebt.due, createdAt: normalizedDebt.createdAt, stockTracked: normalizedDebt.stockTracked })).digest("hex");
    await ensureCollections(db, [COLLECTION, MOVEMENT_COLLECTION]);
    const saved = await withInventoryTransaction(client, async (session: ClientSession) => {
      const collection = db.collection<any>(COLLECTION);
      const existing = await collection.findOne({ _id: key }, { session });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new InventoryError("This debt operation ID was already used for different details", 409);
        return { debt: publicDebt(existing as Record<string, unknown>), replayed: true };
      }
      const lastDebt = await collection.find({ id: { $type: "number" } }, { session }).sort({ id: -1 }).limit(1).toArray();
      const id = (lastDebt.length > 0 && typeof lastDebt[0].id === "number" ? lastDebt[0].id : 0) + 1;
      const debt = {
        _id: key, id, customer: normalizedDebt.customer, invoice: normalizedDebt.invoice,
        ...(normalizedDebt.receiptNumber ? { receiptNumber: normalizedDebt.receiptNumber } : {}),
        items: normalizedDebt.items, amount: Number(normalizedDebt.amount), payments: normalizedDebt.payments || [],
        due: normalizedDebt.due, createdAt: normalizedDebt.createdAt,
        ...(normalizedDebt.paidAt ? { paidAt: normalizedDebt.paidAt } : {}), requestHash, revision: 1,
      };
      if (normalizedDebt.stockTracked) {
        const stockProducts = db.collection<InventoryProduct>(PRODUCTS_COLLECTION);
        const threshold = await readLowStockThreshold(db, session);
        for (const item of debt.items) {
          const product = await stockProducts.findOne({ id: item.productId }, { session });
          if (!product) throw new InventoryError(`Product ${item.productId} was not found in stock`, 409);
          await applyStockDelta(stockProducts, product, -Number(item.quantity), threshold, session);
          await recordStockMovement(db, session, { id: `debt:${key}:${item.productId}`, productId: item.productId!, delta: -Number(item.quantity), type: "debt_sale", sourceId: key, at: new Date(normalizedDebt.createdAt), description: `Stock issued on debt invoice ${debt.invoice}` });
        }
      }
      await collection.insertOne(debt, { session });
      return { debt: publicDebt(debt as Record<string, unknown>), replayed: false };
    });
    return NextResponse.json(saved.debt, { status: saved.replayed ? 200 : 201 });
  } catch (error) {
    if (error instanceof InventoryError) return NextResponse.json({ message: error.message }, { status: error.status });
    if (isTransactionUnavailable(error)) return NextResponse.json({ message: "Debt creation requires MongoDB transaction support; no debt or stock was changed" }, { status: 503 });
    console.error("Failed to create debt:", error);

    const message = error instanceof Error ? error.message : "Failed to create debt";
    const status = message.includes("not enough stock") || message.includes("required") || message.includes("invalid") || message.includes("Select") || message.includes("Add at least one") || message.includes("Product") || message.includes("must be")
      ? 400
      : 500;

    return NextResponse.json(
      { message },
      { status }
    );
  }
}
