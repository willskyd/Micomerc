import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import clientPromise from "@/lib/mongodb";
import { applyStockDelta, ensureCollections, InventoryError, INVENTORY_DB, InventoryProduct, isTransactionUnavailable, parseDate, recordStockMovement, readLowStockThreshold, StringIdDocument, withInventoryTransaction } from "@/lib/inventory";

const COLLECTION = "storeReceipts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Receipt = StringIdDocument & { id: string; productId: number; stockUnits: number; revision: number; history?: import("mongodb").Document[] };

function publicReceipt(value: Receipt) {
  const { _id, requestHash, ...receipt } = value;
  return receipt;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null) throw new InventoryError("Receipt update details are invalid");
    const input = body as Record<string, unknown>;
    const key = input.idempotencyKey;
    const expectedRevision = input.expectedRevision;
    if (typeof key !== "string" || !UUID.test(key)) throw new InventoryError("Receipt update key is invalid");
    if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1) throw new InventoryError("Reload the receipt and try again", 409);
    const cartons = input.cartons;
    const individualUnits = input.individualUnits;
    const upcRaw = input.unitsPerCarton;
    if (typeof cartons !== "number" || !Number.isSafeInteger(cartons) || cartons < 0 || cartons > 100_000) throw new InventoryError("Cartons must be a whole number from 0 to 100,000");
    if (typeof individualUnits !== "number" || !Number.isSafeInteger(individualUnits) || individualUnits < 0 || individualUnits > 1_000_000_000) throw new InventoryError("Individual units must be a whole number of zero or more");
    let unitsPerCarton: number | null = null;
    if (upcRaw !== null && upcRaw !== undefined && upcRaw !== "") {
      if (typeof upcRaw !== "number" || !Number.isSafeInteger(upcRaw) || upcRaw < 1 || upcRaw > 100_000) throw new InventoryError("Units per carton must be a whole number from 1 to 100,000");
      unitsPerCarton = upcRaw;
    }
    if (cartons > 0 && unitsPerCarton === null) throw new InventoryError("Enter units per carton when recording cartons");
    const totalUnits = individualUnits + cartons * (unitsPerCarton ?? 0);
    if (!Number.isSafeInteger(totalUnits) || totalUnits <= 0 || totalUnits > 1_000_000_000) throw new InventoryError("Enter a positive receipt quantity within the supported limit");
    const receivedAt = parseDate(input.receivedAt, "Receiving date");
    const supplier = typeof input.supplier === "string" ? input.supplier.trim() : "";
    const deliveryReference = typeof input.deliveryReference === "string" ? input.deliveryReference.trim() : "";
    const notes = typeof input.notes === "string" ? input.notes.trim() : "";
    if (supplier.length > 120 || deliveryReference.length > 100 || notes.length > 500) throw new InventoryError("Supplier, reference, or notes exceed the allowed length");
    const fields = { cartons, individualUnits, unitsPerCarton, totalUnits, stockUnits: totalUnits, receivedAt, supplier, deliveryReference, notes };
    const hash = createHash("sha256").update(JSON.stringify({ id, expectedRevision, ...fields, receivedAt: receivedAt.toISOString() })).digest("hex");

    const client = await clientPromise();
    const db = client.db(INVENTORY_DB);
    await ensureCollections(db, [COLLECTION, "inventoryRequests"]);
    const result = await withInventoryTransaction(client, async (session) => {
      const requests = db.collection<StringIdDocument>("inventoryRequests");
      const previousRequest = await requests.findOne({ _id: key }, { session });
      if (previousRequest) {
        if (previousRequest.requestHash !== hash) throw new InventoryError("This update key was already used for different details", 409);
        const saved = await db.collection<Receipt>(COLLECTION).findOne({ id }, { session });
        if (!saved) throw new InventoryError("Receipt not found", 404);
        return { receipt: publicReceipt(saved), replayed: true };
      }
      const receipts = db.collection<Receipt>(COLLECTION);
      const receipt = await receipts.findOne({ id }, { session });
      if (!receipt) throw new InventoryError("Receipt not found", 404);
      if (receipt.stockAdjusted !== true || typeof receipt.stockUnits !== "number") throw new InventoryError("This older Store record has no safe stock-adjustment history and cannot be edited", 409);
      if (receipt.revision !== Number(expectedRevision)) throw new InventoryError("This receipt changed in another session. Reload it before saving", 409);
      const delta = totalUnits - receipt.stockUnits;
      const products = db.collection<InventoryProduct>("products");
      const product = await products.findOne({ id: receipt.productId }, { session });
      if (!product || typeof product.stock !== "number") throw new InventoryError("The original product is missing; this receipt cannot be safely adjusted", 409);
      const now = new Date();
      if (delta !== 0) {
        await applyStockDelta(products, product, delta, await readLowStockThreshold(db, session), session);
        await recordStockMovement(db, session, { id: `store:${receipt.id}:edit:${key}:${receipt.productId}`, productId: receipt.productId, delta, type: "store_receipt_adjustment", sourceId: receipt.id, at: now, description: `Adjusted Store receipt ${receipt.reference} by ${delta} units` });
      }
      const historyEntry = { at: now, previous: { cartons: receipt.cartons, individualUnits: receipt.individualUnits, unitsPerCarton: receipt.unitsPerCarton, totalUnits: receipt.stockUnits }, next: { cartons, individualUnits, unitsPerCarton, totalUnits }, stockDeltaUnits: delta };
      const updateOperation = { $set: { ...fields, supplier, deliveryReference, notes, revision: receipt.revision + 1, updatedAt: now }, $push: { history: historyEntry } } as unknown as import("mongodb").UpdateFilter<Receipt>;
      const update = await receipts.updateOne({ _id: receipt._id, revision: receipt.revision }, updateOperation, { session });
      if (update.matchedCount !== 1) throw new InventoryError("This receipt changed in another session. Reload it before saving", 409);
      const saved = await receipts.findOne({ _id: receipt._id }, { session });
      if (!saved) throw new Error("Updated receipt could not be read");
      await requests.insertOne({ _id: key, requestHash: hash, sourceType: "store_receipt_edit", sourceId: id, createdAt: now }, { session });
      return { receipt: publicReceipt(saved), replayed: false };
    });
    return NextResponse.json(result.receipt, { status: 200 });
  } catch (error) {
    if (error instanceof InventoryError) return NextResponse.json({ message: error.message }, { status: error.status });
    if (isTransactionUnavailable(error)) return NextResponse.json({ message: "Store edits require MongoDB transaction support; no changes were made" }, { status: 503 });
    console.error("Failed to edit Store receipt:", error);
    return NextResponse.json({ message: "Store receipt could not be updated" }, { status: 500 });
  }
}
