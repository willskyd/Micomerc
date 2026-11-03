import { createHash } from "node:crypto";
import type { Document } from "mongodb";
import { NextResponse } from "next/server";
import clientPromise from "@/lib/mongodb";
import { applyStockDelta, ensureCollections, InventoryError, INVENTORY_DB, InventoryProduct, isTransactionUnavailable, MOVEMENT_COLLECTION, recordStockMovement, readLowStockThreshold, StringIdDocument, withInventoryTransaction } from "@/lib/inventory";
import { aggregateTransferLines, parseTransferInput } from "@/lib/transfer-input";

type Transfer = StringIdDocument & { id: string; lines: Array<Record<string, unknown>>; revision: number; history?: Document[] };

function publicTransfer(value: Transfer) {
  const { _id, requestHash, ...transfer } = value;
  return transfer;
}

function aggregateStoredLines(lines: Array<Record<string, unknown>>) {
  const result = new Map<number, number>();
  for (const line of lines) {
    if (typeof line.productId !== "number" || typeof line.stockUnits !== "number" || !Number.isFinite(line.stockUnits) || line.stockUnits <= 0) {
      throw new InventoryError("This transfer has incomplete stock history and cannot be safely edited", 409);
    }
    result.set(line.productId, Math.round(((result.get(line.productId) ?? 0) + line.stockUnits) * 1000) / 1000);
  }
  return result;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    let raw: unknown;
    try { raw = await request.json(); } catch { throw new InventoryError("Request body must be valid JSON"); }
    if (typeof raw !== "object" || raw === null || !Number.isSafeInteger((raw as Record<string, unknown>).expectedRevision)) throw new InventoryError("Transfer revision is required; reload the record before editing", 409);
    const expectedRevision = Number((raw as Record<string, unknown>).expectedRevision);
    const input = parseTransferInput(raw);
    const requestHash = createHash("sha256").update(JSON.stringify({ id, expectedRevision, ...input, transferDate: input.transferDate.toISOString() })).digest("hex");
    const client = await clientPromise();
    const db = client.db(INVENTORY_DB);
    await ensureCollections(db, ["transfers", "branches", MOVEMENT_COLLECTION, "inventoryRequests"]);
    const result = await withInventoryTransaction(client, async (session) => {
      const requests = db.collection<StringIdDocument>("inventoryRequests");
      const replay = await requests.findOne({ _id: input.idempotencyKey }, { session });
      if (replay) {
        if (replay.requestHash !== requestHash) throw new InventoryError("This edit key was already used for different details", 409);
        const current = await db.collection<Transfer>("transfers").findOne({ id }, { session });
        if (!current) throw new InventoryError("Transfer not found", 404);
        return publicTransfer(current);
      }
      const transfers = db.collection<Transfer>("transfers");
      const original = await transfers.findOne({ id }, { session });
      if (!original) throw new InventoryError("Transfer not found", 404);
      if (original.stockAdjusted !== true || !Array.isArray(original.lines)) throw new InventoryError("This older transfer has no safe stock adjustment history and cannot be edited", 409);
      if (original.revision !== expectedRevision) throw new InventoryError("This transfer changed in another session. Reload it before editing", 409);
      const branch = await db.collection("branches").findOne({ id: input.destinationBranchId }, { session });
      if (!branch) throw new InventoryError("The selected destination branch no longer exists", 409);
      const products = db.collection<InventoryProduct>("products");
      const lines = [];
      for (const line of input.lines) {
        const product = await products.findOne({ id: line.productId }, { session });
        if (!product || typeof product.stock !== "number") throw new InventoryError("A selected product is no longer available", 409);
        lines.push({ ...line, productName: String(product.name ?? "Product"), sku: String(product.sku ?? product.model ?? ""), barcode: typeof product.barcode === "string" ? product.barcode : "" });
      }
      const previous = aggregateStoredLines(original.lines);
      const next = aggregateTransferLines(input.lines);
      const productIds = new Set([...previous.keys(), ...next.keys()]);
      const adjustments: Array<{ productId: number; deltaUnits: number }> = [];
      const threshold = await readLowStockThreshold(db, session);
      const now = new Date();
      for (const productId of productIds) {
        const delta = Math.round(((previous.get(productId) ?? 0) - (next.get(productId) ?? 0)) * 1000) / 1000;
        if (delta === 0) continue;
        const product = await products.findOne({ id: productId }, { session });
        if (!product || typeof product.stock !== "number") throw new InventoryError("A product from the original transfer is missing; the edit was blocked to protect stock", 409);
        if (delta < 0 && String(product.status ?? "").toLowerCase() === "discontinued") throw new InventoryError(`${product.name} is discontinued and cannot receive an additional transfer`, 409);
        await applyStockDelta(products, product, delta, threshold, session);
        const direction = delta > 0 ? "restore" : "deduct";
        await recordStockMovement(db, session, { id: `transfer:${id}:edit:${input.idempotencyKey}:${productId}`, productId, delta, type: delta > 0 ? "transfer_edit_restore" : "transfer_edit_out", sourceId: id, at: now, description: `${delta > 0 ? "Restored" : "Transferred"} ${Math.abs(delta)} units while editing ${original.reference}` });
        adjustments.push({ productId, deltaUnits: delta });
      }
      const nextSnapshot = { transferDate: input.transferDate, destinationBranchId: input.destinationBranchId, destinationNameAtTransfer: String(branch.name), sourceLocation: input.sourceLocation, lines, manualItems: input.manualItems, notes: input.notes };
      const previousSnapshot = { transferDate: original.transferDate, destinationBranchId: original.destinationBranchId, destinationNameAtTransfer: original.destinationNameAtTransfer, sourceLocation: original.sourceLocation, lines: original.lines, manualItems: original.manualItems ?? "", notes: original.notes ?? "" };
      const updateOperation = { $set: { ...nextSnapshot, revision: expectedRevision + 1, updatedAt: now }, $push: { history: { at: now, previous: previousSnapshot, next: nextSnapshot, stockAdjustments: adjustments, requestKey: input.idempotencyKey } } } as unknown as import("mongodb").UpdateFilter<Transfer>;
      const updated = await transfers.updateOne({ _id: original._id, revision: expectedRevision }, updateOperation, { session });
      if (updated.matchedCount !== 1) throw new InventoryError("This transfer changed in another session. Reload it before editing", 409);
      const saved = await transfers.findOne({ _id: original._id }, { session });
      if (!saved) throw new Error("Updated transfer could not be read");
      await requests.insertOne({ _id: input.idempotencyKey, requestHash, sourceType: "transfer_edit", sourceId: id, createdAt: now }, { session });
      return publicTransfer(saved);
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof InventoryError) return NextResponse.json({ message: error.message }, { status: error.status });
    if (isTransactionUnavailable(error)) return NextResponse.json({ message: "Transfer edits require MongoDB transaction support; no changes were made" }, { status: 503 });
    console.error("Failed to edit transfer:", error);
    return NextResponse.json({ message: "Transfer could not be updated" }, { status: 500 });
  }
}
