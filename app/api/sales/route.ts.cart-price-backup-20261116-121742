import { DB_NAME as MICOMERC_DB } from "@/lib/database";
import { normalizeWorkspaceName } from "@/lib/branding";
import { createHash } from "node:crypto";
import type { ClientSession, Document } from "mongodb";
import clientPromise from "@/lib/mongodb";
import { NextResponse } from "next/server";
import { ensureCollections, MOVEMENT_COLLECTION, recordStockMovement } from "@/lib/inventory";

const DB_NAME = MICOMERC_DB;
const SALES_COLLECTION = "sales";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ProductDocument = Document & {
  id: number;
  name: string;
  model?: string;
  sku?: string;
  barcode?: string;
  stock: number;
  price: number;
  status?: string;
  reservedStock?: number;
};

type SaleDocument = Document & {
  _id: string;
  id: string;
  receiptNumber: string;
  createdAt: Date;
  requestHash: string;
  items: Array<{ productId: number; quantity: number }>;
};

class CheckoutError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function publicSale(sale: SaleDocument) {
  const { _id, requestHash, ...result } = sale;
  return result;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}

function isTransactionUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  const message = "message" in error ? error.message : undefined;
  return code === 20 || code === 263 ||
    (typeof message === "string" && message.includes("Transaction numbers are only allowed"));
}

function normalizeCheckoutItems(value: unknown): { productId: number; quantity: number; quantityMilli: number }[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw new CheckoutError("Add at least one product before checkout", 400);
  }

  const quantities = new Map<number, number>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || !("productId" in entry) || !("quantity" in entry)) {
      throw new CheckoutError("Cart item is invalid", 400);
    }
    const { productId, quantity } = entry;
    if (typeof productId !== "number" || !Number.isSafeInteger(productId) || productId <= 0 ||
      typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) {
      throw new CheckoutError("Product IDs and quantities must be valid positive numbers", 400);
    }
    const quantityMilli = Math.round(quantity * 1000);
    if (Math.abs(quantity * 1000 - quantityMilli) > 0.000001) {
      throw new CheckoutError("Quantities can have at most three decimal places", 400);
    }
    quantities.set(productId, (quantities.get(productId) ?? 0) + quantityMilli);
  }

  return [...quantities.entries()].map(([productId, quantityMilli]) => ({
    productId,
    quantity: quantityMilli / 1000,
    quantityMilli,
  }));
}

function parseCashTendered(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 100) {
    throw new CheckoutError("Enter a valid cash amount received", 400);
  }
  const amountMinor = Math.round(value * 100);
  if (Math.abs(value * 100 - amountMinor) > 0.000001) {
    throw new CheckoutError("Cash received can have at most two decimal places", 400);
  }
  return amountMinor;
}

export async function GET(request: Request) {
  try {
    const client = await clientPromise();
    const db = client.db(DB_NAME);
    const url = new URL(request.url);
    const params = url.searchParams;
    const limitParam = params.get("limit");
    const requestedLimit = limitParam ? Number(limitParam) : 20;
    const limit = Number.isInteger(requestedLimit) ? Math.min(50, Math.max(1, requestedLimit)) : 20;
    const clauses: Document[] = [
      { cancelled: { $ne: true } },
      { status: { $not: /^(cancelled|void|refunded)$/i } },
      { "payment.status": { $not: /^(cancelled|void|refunded)$/i } },
    ];
    const from = params.get("from");
    const to = params.get("to");
    if (from) {
      const fromDate = new Date(from);
      if (Number.isNaN(fromDate.getTime())) return NextResponse.json({ message: "Invalid start date" }, { status: 400 });
      clauses.push({ createdAt: { $gte: fromDate } });
    }
    if (to) {
      const toDate = new Date(to);
      if (Number.isNaN(toDate.getTime())) return NextResponse.json({ message: "Invalid end date" }, { status: 400 });
      clauses.push({ createdAt: { $lt: toDate } });
    }
    const search = params.get("q")?.trim();
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      clauses.push({ receiptNumber: { $regex: escaped, $options: "i" } });
    }
    const excludedIds = (params.get("exclude") ?? "").split(",").filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 20);
    if (excludedIds.length) clauses.push({ _id: { $nin: excludedIds } });
    const match = { $and: clauses };
    const cursor = params.get("cursor");
    let cursorFilter: Document | null = null;
    if (cursor) {
      try {
        const [dateValue, idValue] = Buffer.from(cursor, "base64url").toString("utf8").split("|", 2);
        const date = new Date(dateValue);
        if (!idValue || Number.isNaN(date.getTime())) throw new Error("Bad cursor");
        cursorFilter = { $and: [match, { $or: [{ createdAt: { $lt: date } }, { createdAt: date, _id: { $lt: idValue } }] }] };
      } catch {
        return NextResponse.json({ message: "Sales page cursor is invalid" }, { status: 400 });
      }
    }
    const collection = db.collection<SaleDocument>(SALES_COLLECTION);
    const [rows, total, aggregate] = await Promise.all([
      collection.find(cursorFilter ?? match, { projection: { requestHash: 0 } })
        .sort({ createdAt: -1, _id: -1 }).limit(params.get("paged") === "1" ? limit + 1 : limit).toArray(),
      collection.countDocuments(match),
      collection.aggregate<{ totalMinor: number; unitsSold: number }>([
        { $match: match },
        { $group: { _id: null, totalMinor: { $sum: "$totalMinor" }, unitsSold: { $sum: { $reduce: { input: { $ifNull: ["$items", []] }, initialValue: 0, in: { $add: ["$$value", { $ifNull: ["$$this.quantity", 0] }] } } } } } },
      ]).toArray(),
    ]);
    const hasMore = params.get("paged") === "1" && rows.length > limit;
    const sales = rows.slice(0, limit);
    if (params.get("paged") !== "1") return NextResponse.json(sales.map(publicSale));
    const last = sales.at(-1);
    const nextCursor = hasMore && last ? Buffer.from(`${new Date(last.createdAt).toISOString()}|${last._id}`).toString("base64url") : null;
    return NextResponse.json({
      sales: sales.map(publicSale),
      total,
      hasMore,
      nextCursor,
      summary: { saleCount: total, totalMinor: aggregate[0]?.totalMinor ?? 0, unitsSold: aggregate[0]?.unitsSold ?? 0 },
    });
  } catch (error) {
    console.error("Failed to load POS sales:", error);
    return NextResponse.json({ message: "Sales history is unavailable" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "Request body must be valid JSON" }, { status: 400 });
  }

  try {
    if (typeof body !== "object" || body === null || !("idempotencyKey" in body) ||
      !("items" in body) || !("cashTendered" in body)) {
      throw new CheckoutError("Checkout request is incomplete", 400);
    }
    const { idempotencyKey } = body;
    if (typeof idempotencyKey !== "string" || !UUID_PATTERN.test(idempotencyKey)) {
      throw new CheckoutError("Checkout request key is invalid; please retry checkout", 400);
    }

    const items = normalizeCheckoutItems(body.items);
    const amountTenderedMinor = parseCashTendered(body.cashTendered);
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ items: items.map(({ productId, quantityMilli }) => ({ productId, quantityMilli })), amountTenderedMinor }))
      .digest("hex");

    const client = await clientPromise();
    const db = client.db(DB_NAME);
    await ensureCollections(db, [SALES_COLLECTION, MOVEMENT_COLLECTION]);
    const products = db.collection<ProductDocument>("products");
    const sales = db.collection<SaleDocument>(SALES_COLLECTION);
    const session: ClientSession = client.startSession();
    let committedSale: SaleDocument | null = null;
    let committedInventory: ProductDocument[] = [];
    let replayed = false;

    try {
      await session.withTransaction(async () => {
        const existingSale = await sales.findOne({ _id: idempotencyKey }, { session });
        if (existingSale) {
          if (existingSale.requestHash !== requestHash) {
            throw new CheckoutError("This checkout key was already used for a different cart", 409);
          }
          committedSale = existingSale;
          replayed = true;
          committedInventory = await products.find({ id: { $in: existingSale.items.map((item) => item.productId) } }, { session }).toArray();
          return;
        }

        const settings = await db.collection("settings").findOne({ key: "workspace" }, { session });
        const thresholdValue = Number(settings?.lowStockThreshold ?? 30);
        const lowStockThreshold = Number.isFinite(thresholdValue) && thresholdValue >= 0 ? thresholdValue : 30;
        const requestedIds = items.map((item) => item.productId);
        const foundProducts = await products.find({ id: { $in: requestedIds } }, { session }).toArray();
        const byId = new Map(foundProducts.map((product) => [product.id, product]));
        const missing = requestedIds.find((id) => !byId.has(id));
        if (missing !== undefined) throw new CheckoutError("A cart product no longer exists in inventory", 409);

        const saleLines = items.map((item) => {
          const product = byId.get(item.productId);
          if (!product) throw new CheckoutError("A cart product no longer exists in inventory", 409);
          if (typeof product.stock !== "number" || !Number.isFinite(product.stock) || product.stock < 0) {
            throw new CheckoutError(`${product.name || "A product"} has invalid inventory data`, 409);
          }
          if (String(product.status ?? "").trim().toLowerCase() === "discontinued") {
            throw new CheckoutError(`${product.name} is discontinued and cannot be sold`, 409);
          }
          const availableStock = product.stock - Number(product.reservedStock ?? 0);
          if (availableStock < item.quantity) {
            throw new CheckoutError(`Insufficient stock for ${product.name}. Available: ${Math.max(0, availableStock)}`, 409);
          }
          if (typeof product.price !== "number" || !Number.isFinite(product.price) || product.price < 0 || product.price > Number.MAX_SAFE_INTEGER / 100) {
            throw new CheckoutError(`${product.name} has an invalid selling price`, 409);
          }
          const unitPriceMinor = Math.round(product.price * 100);
          const lineTotalMinor = Math.round(unitPriceMinor * item.quantityMilli / 1000);
          return {
            productId: product.id,
            name: String(product.name ?? "Product"),
            sku: String(product.sku ?? product.model ?? ""),
            barcode: typeof product.barcode === "string" ? product.barcode : "",
            quantity: item.quantity,
            unitPriceMinor,
            lineTotalMinor,
          };
        });

        const subtotalMinor = saleLines.reduce((total, line) => total + line.lineTotalMinor, 0);
        if (!Number.isSafeInteger(subtotalMinor) || subtotalMinor < 0) {
          throw new CheckoutError("The cart total is outside the supported range", 400);
        }
        if (amountTenderedMinor < subtotalMinor) {
          throw new CheckoutError("Cash received is less than the amount due", 400);
        }

        const createdAt = new Date();
        for (const item of items) {
          const product = byId.get(item.productId);
          if (!product) throw new CheckoutError("A cart product no longer exists in inventory", 409);
          const remainingStock = Math.round((product.stock - item.quantity) * 1000) / 1000;
          const status = remainingStock <= 0
            ? "Out of stock"
            : remainingStock <= lowStockThreshold
              ? "Low stock"
              : "In stock";
          const updated = await products.updateOne(
            { id: item.productId, status: { $not: /^Discontinued$/i }, $expr: { $gte: [{ $subtract: ['$stock', { $ifNull: ['$reservedStock', 0] }] }, item.quantity] } },
            { $inc: { stock: -item.quantity }, $set: { status } },
            { session },
          );
          if (updated.matchedCount !== 1) {
            throw new CheckoutError(`Stock changed during checkout for ${product.name}. Please review the cart`, 409);
          }
          await recordStockMovement(db, session, {
            id: `sale:${idempotencyKey}:${item.productId}`,
            productId: item.productId,
            delta: -item.quantity,
            type: "sale",
            sourceId: idempotencyKey,
            at: createdAt,
            description: `Sold ${item.quantity} units on receipt ${idempotencyKey}`,
          });
        }
        committedInventory = await products.find({ id: { $in: requestedIds } }, { session }).toArray();

        const workspace = normalizeWorkspaceName(settings?.workspace);
        const currencySetting = settings?.currency;
        const currency = ["NGN", "USD", "EUR", "GBP"].includes(String(currencySetting))
          ? String(currencySetting)
          : "NGN";
        const sale: SaleDocument = {
          _id: idempotencyKey,
          id: idempotencyKey,
          receiptNumber: `MM-${createdAt.toISOString().slice(0, 10).replace(/-/g, "")}-${idempotencyKey.toUpperCase()}`,
          businessName: workspace,
          currency,
          createdAt,
          items: saleLines,
          subtotalMinor,
          discountMinor: 0,
          taxMinor: 0,
          totalMinor: subtotalMinor,
          payment: {
            method: "cash",
            status: "paid",
            amountTenderedMinor,
            changeMinor: amountTenderedMinor - subtotalMinor,
          },
          requestHash,
        };
        await sales.insertOne(sale, { session });
        committedSale = sale;
      }, {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const existingSale = await sales.findOne({ _id: idempotencyKey });
        if (existingSale?.requestHash === requestHash) {
          const inventory = await db.collection<ProductDocument>("products").find({ id: { $in: existingSale.items.map((item) => item.productId) } }).toArray();
          return NextResponse.json({ ...publicSale(existingSale), inventory }, { status: 200 });
        }
        if (existingSale) throw new CheckoutError("This checkout key was already used for a different cart", 409);
      }
      throw error;
    } finally {
      await session.endSession();
    }

    if (!committedSale) throw new Error("Checkout transaction finished without a saved sale");
    return NextResponse.json({ ...publicSale(committedSale), inventory: committedInventory }, { status: replayed ? 200 : 201 });
  } catch (error) {
    if (error instanceof CheckoutError) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }
    if (isTransactionUnavailable(error)) {
      console.error("POS checkout requires MongoDB transaction support:", error);
      return NextResponse.json(
        { message: "Checkout is unavailable because the database does not support atomic transactions" },
        { status: 503 }
      );
    }
    console.error("POS checkout failed:", error);
    return NextResponse.json({ message: "Checkout could not be completed. The cart was not confirmed" }, { status: 500 });
  }
}
