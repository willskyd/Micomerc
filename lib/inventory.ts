import type { ClientSession, Collection, Db, Document, MongoClient } from "mongodb";

import { DB_NAME } from "./database";

export const INVENTORY_DB = DB_NAME;
export const PRODUCT_COLLECTION = "products";
export const MOVEMENT_COLLECTION = "stockMovements";

export type StringIdDocument = Document & { _id: string };

export type InventoryProduct = Document & {
  _id?: string;
  id: number;
  name: string;
  model?: string;
  sku?: string;
  barcode?: string;
  stock: number;
  price?: number;
  status?: string;
  reservedStock?: number;
};

export class InventoryError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function isTransactionUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  const message = "message" in error ? error.message : undefined;
  return code === 20 || code === 263 || code === 303 ||
    (typeof message === "string" && /Transaction numbers are only allowed|does not support retryable writes/i.test(message));
}

export async function ensureCollections(db: Db, names: string[]): Promise<void> {
  for (const name of names) {
    try {
      await db.createCollection(name);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === 48) continue;
      throw error;
    }
  }
}

export async function withInventoryTransaction<T>(client: MongoClient, work: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = client.startSession();
  let outcome: { value: T } | undefined;
  try {
    await session.withTransaction(async () => {
      outcome = { value: await work(session) };
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    if (!outcome) throw new Error("Inventory transaction completed without a result");
    return outcome.value;
  } finally {
    await session.endSession();
  }
}

export async function readLowStockThreshold(db: Db, session: ClientSession): Promise<number> {
  const settings = await db.collection("settings").findOne({ key: "workspace" }, { session });
  const value = Number(settings?.lowStockThreshold ?? 30);
  return Number.isFinite(value) && value >= 0 ? value : 30;
}

export async function applyStockDelta(
  products: Collection<InventoryProduct>,
  product: InventoryProduct,
  delta: number,
  lowStockThreshold: number,
  session: ClientSession,
): Promise<number> {
  if (!Number.isSafeInteger(product.id) || !Number.isFinite(product.stock) || product.stock < 0 ||
      !Number.isFinite(delta) || !Number.isSafeInteger(Math.round(delta * 1000)) || Math.abs(delta * 1000 - Math.round(delta * 1000)) > 0.000001) {
    throw new InventoryError(`${product.name || "Product"} has invalid inventory data`, 409);
  }
  const nextStock = Math.round((product.stock + delta) * 1000) / 1000;
  const reservedStock = Number((product as InventoryProduct & { reservedStock?: number }).reservedStock ?? 0);
  if (!Number.isFinite(reservedStock) || reservedStock < 0 || !Number.isFinite(nextStock) || nextStock < reservedStock || nextStock > 1_000_000_000) {
    throw new InventoryError(`Insufficient stock for ${product.name}. Available: ${Math.max(0, product.stock - reservedStock)}`, 409);
  }
  const status = nextStock <= 0 ? "Out of stock" : nextStock <= lowStockThreshold ? "Low stock" : "In stock";
  const result = await products.updateOne(
    { id: product.id, stock: product.stock, $expr: { $gte: [{ $add: ['$stock', delta] }, { $ifNull: ['$reservedStock', 0] }] } },
    { $inc: { stock: delta }, $set: { status } },
    { session },
  );
  if (result.matchedCount !== 1) {
    throw new InventoryError(`Stock changed while saving ${product.name}. Reload inventory and try again`, 409);
  }
  return nextStock;
}

export async function recordStockMovement(
  db: Db,
  session: ClientSession,
  data: { id: string; productId: number; delta: number; type: string; sourceId: string; at: Date; description: string },
): Promise<void> {
  await db.collection<StringIdDocument>(MOVEMENT_COLLECTION).insertOne({
    _id: data.id,
    productId: data.productId,
    quantityChange: data.delta,
    unit: "unit",
    movementType: data.type,
    sourceRecordId: data.sourceId,
    description: data.description,
    createdAt: data.at,
  }, { session });
}

export function parseQuantity(value: unknown, label: string, max = 1_000_000): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max ||
      Math.abs(value * 1000 - Math.round(value * 1000)) > 0.000001) {
    throw new InventoryError(`${label} must be greater than zero and use no more than three decimal places`);
  }
  return Math.round(value * 1000) / 1000;
}

export function parseDate(value: unknown, label: string): Date {
  if (typeof value !== "string" || !value.trim()) throw new InventoryError(`${label} is required`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new InventoryError(`${label} is invalid`);
  return date;
}
