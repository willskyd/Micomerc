import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import clientPromise from "@/lib/mongodb";
import { applyStockDelta, ensureCollections, InventoryError, INVENTORY_DB, InventoryProduct, isTransactionUnavailable, MOVEMENT_COLLECTION, parseDate, recordStockMovement, readLowStockThreshold, StringIdDocument, withInventoryTransaction } from "@/lib/inventory";

const COLLECTION = "storeReceipts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Receipt = StringIdDocument & { id: string; requestHash: string; productId: number; stockUnits: number };

function publicReceipt(value: Receipt) {
  const { _id, requestHash, ...receipt } = value;
  return receipt;
}

function parseBody(value: unknown) {
  if (typeof value !== "object" || value === null) throw new InventoryError("Receipt details are invalid");
  const body = value as Record<string, unknown>;
  const idempotencyKey = body.idempotencyKey;
  const productId = body.productId;
  const cartons = body.cartons;
  const individualUnits = body.individualUnits;
  const unitsPerCarton = body.unitsPerCarton;
  if (typeof idempotencyKey !== "string" || !UUID.test(idempotencyKey)) throw new InventoryError("Receipt request key is invalid");
  if (typeof productId !== "number" || !Number.isSafeInteger(productId) || productId <= 0) throw new InventoryError("Select a valid catalog product");
  if (typeof cartons !== "number" || !Number.isSafeInteger(cartons) || cartons < 0 || cartons > 100_000) throw new InventoryError("Cartons must be a whole number from 0 to 100,000");
  if (typeof individualUnits !== "number" || !Number.isSafeInteger(individualUnits) || individualUnits < 0 || individualUnits > 1_000_000_000) throw new InventoryError("Individual units must be a whole number of zero or more");
  let parsedUnitsPerCarton: number | null = null;
  if (unitsPerCarton !== null && unitsPerCarton !== undefined && unitsPerCarton !== "") {
    if (typeof unitsPerCarton !== "number" || !Number.isSafeInteger(unitsPerCarton) || unitsPerCarton < 1 || unitsPerCarton > 100_000) throw new InventoryError("Units per carton must be a whole number from 1 to 100,000");
    parsedUnitsPerCarton = unitsPerCarton;
  }
  if (cartons > 0 && parsedUnitsPerCarton === null) throw new InventoryError("Enter units per carton when recording cartons");
  const totalUnits = individualUnits + cartons * (parsedUnitsPerCarton ?? 0);
  if (!Number.isSafeInteger(totalUnits) || totalUnits <= 0 || totalUnits > 1_000_000_000) throw new InventoryError("Enter a positive receipt quantity within the supported limit");
  const receivedAt = parseDate(body.receivedAt, "Receiving date");
  const supplier = typeof body.supplier === "string" ? body.supplier.trim() : "";
  const deliveryReference = typeof body.deliveryReference === "string" ? body.deliveryReference.trim() : "";
  const notes = typeof body.notes === "string" ? body.notes.trim() : "";
  if (supplier.length > 120 || deliveryReference.length > 100 || notes.length > 500) throw new InventoryError("Supplier, reference, or notes exceed the allowed length");
  const valueToHash = { productId, cartons, individualUnits, unitsPerCarton: parsedUnitsPerCarton, receivedAt: receivedAt.toISOString(), supplier, deliveryReference, notes };
  return { idempotencyKey, productId, cartons, individualUnits, unitsPerCarton: parsedUnitsPerCarton, totalUnits, receivedAt, supplier, deliveryReference, notes, requestHash: createHash("sha256").update(JSON.stringify(valueToHash)).digest("hex") };
}

export async function GET() {
  try {
    const client = await clientPromise();
    const records = await client.db(INVENTORY_DB).collection<Receipt>(COLLECTION)
      .find({}, { projection: { requestHash: 0 } }).sort({ receivedAt: -1, createdAt: -1 }).toArray();
    return NextResponse.json(records.map(publicReceipt));
  } catch (error) {
    console.error("Failed to load Store receipts:", error);
    return NextResponse.json({ message: "Store records are unavailable" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    let raw: unknown;
    try { raw = await request.json(); } catch { throw new InventoryError("Request body must be valid JSON"); }
    const input = parseBody(raw);
    const client = await clientPromise();
    const db = client.db(INVENTORY_DB);
    await ensureCollections(db, [COLLECTION, MOVEMENT_COLLECTION]);
    const saved = await withInventoryTransaction(client, async (session) => {
      const receipts = db.collection<Receipt>(COLLECTION);
      const existing = await receipts.findOne({ _id: input.idempotencyKey }, { session });
      if (existing) {
        if (existing.requestHash !== input.requestHash) throw new InventoryError("This receipt key was already used for different details", 409);
        return { receipt: publicReceipt(existing), replayed: true };
      }
      const products = db.collection<InventoryProduct>("products");
      const product = await products.findOne({ id: input.productId }, { session });
      if (!product || typeof product.stock !== "number") throw new InventoryError("The selected product is no longer available", 409);
      if (String(product.status ?? "").toLowerCase() === "discontinued") throw new InventoryError(`${product.name} is discontinued`, 409);
      const threshold = await readLowStockThreshold(db, session);
      await applyStockDelta(products, product, input.totalUnits, threshold, session);
      const now = new Date();
      const receipt: Receipt = {
        _id: input.idempotencyKey,
        id: input.idempotencyKey,
        reference: `RCV-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${input.idempotencyKey.slice(0, 6).toUpperCase()}`,
        productId: product.id,
        productName: String(product.name),
        sku: String(product.sku ?? product.model ?? ""),
        barcode: typeof product.barcode === "string" ? product.barcode : "",
        supplier: input.supplier,
        receivedAt: input.receivedAt,
        cartons: input.cartons,
        individualUnits: input.individualUnits,
        unitsPerCarton: input.unitsPerCarton,
        totalUnits: input.totalUnits,
        stockUnits: input.totalUnits,
        deliveryReference: input.deliveryReference,
        notes: input.notes,
        status: "Recorded",
        stockAdjusted: true,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        requestHash: input.requestHash,
      };
      await receipts.insertOne(receipt, { session });
      await recordStockMovement(db, session, { id: `store:${receipt.id}:create:${product.id}`, productId: product.id, delta: input.totalUnits, type: "store_receipt", sourceId: receipt.id, at: now, description: `Received ${input.totalUnits} units at Store (${receipt.reference})` });
      return { receipt: publicReceipt(receipt), replayed: false };
    });
    return NextResponse.json(saved.receipt, { status: saved.replayed ? 200 : 201 });
  } catch (error) {
    if (error instanceof InventoryError) return NextResponse.json({ message: error.message }, { status: error.status });
    if (isTransactionUnavailable(error)) return NextResponse.json({ message: "Store receipts require MongoDB transaction support; no stock or receipt was changed" }, { status: 503 });
    console.error("Failed to record Store receipt:", error);
    return NextResponse.json({ message: "Store receipt could not be saved" }, { status: 500 });
  }
}
