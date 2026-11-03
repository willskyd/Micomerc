import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import clientPromise from "@/lib/mongodb";
import { applyStockDelta, ensureCollections, InventoryError, INVENTORY_DB, InventoryProduct, isTransactionUnavailable, MOVEMENT_COLLECTION, recordStockMovement, readLowStockThreshold, StringIdDocument, withInventoryTransaction } from "@/lib/inventory";
import { aggregateTransferLines, parseTransferInput } from "@/lib/transfer-input";

const COLLECTION = "transfers";
type Transfer = StringIdDocument & { id: string; requestHash: string; lines: Array<Record<string, unknown>> };

function publicTransfer(value: Transfer) {
  const { _id, requestHash, ...transfer } = value;
  return transfer;
}

function duplicateKey(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}

export async function GET() {
  try {
    const client = await clientPromise();
    const records = await client.db(INVENTORY_DB).collection<Transfer>(COLLECTION)
      .find({}, { projection: { requestHash: 0 } }).sort({ transferDate: -1, createdAt: -1 }).toArray();
    return NextResponse.json(records.map(publicTransfer));
  } catch (error) {
    console.error("Failed to load transfers:", error);
    return NextResponse.json({ message: "Transfer history is unavailable" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let input: ReturnType<typeof parseTransferInput>;
  try { input = parseTransferInput(await request.json()); }
  catch (error) {
    if (error instanceof InventoryError) return NextResponse.json({ message: error.message }, { status: error.status });
    return NextResponse.json({ message: "Request body must be valid JSON" }, { status: 400 });
  }
  const requestHash = createHash("sha256").update(JSON.stringify({ ...input, transferDate: input.transferDate.toISOString() })).digest("hex");
  try {
    const client = await clientPromise();
    const db = client.db(INVENTORY_DB);
    await ensureCollections(db, [COLLECTION, "branches", MOVEMENT_COLLECTION]);
    const saved = await withInventoryTransaction(client, async (session) => {
      const transfers = db.collection<Transfer>(COLLECTION);
      const existing = await transfers.findOne({ _id: input.idempotencyKey }, { session });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new InventoryError("This transfer key was already used for different details", 409);
        return { transfer: publicTransfer(existing), replayed: true };
      }
      const branchCollection = db.collection("branches");
      const existingBranch = await branchCollection.findOne({ id: input.destinationBranchId }, { session });
      if (!existingBranch) throw new InventoryError("The selected destination branch no longer exists", 409);
      const destinationName = String(existingBranch.name);
      const products = db.collection<InventoryProduct>("products");
      const lines = [];
      for (const line of input.lines) {
        const product = await products.findOne({ id: line.productId }, { session });
        if (!product || typeof product.stock !== "number") throw new InventoryError("A selected product is no longer available", 409);
        if (String(product.status ?? "").toLowerCase() === "discontinued") throw new InventoryError(`${product.name} is discontinued`, 409);
        lines.push({ ...line, productName: String(product.name ?? "Product"), sku: String(product.sku ?? product.model ?? ""), barcode: typeof product.barcode === "string" ? product.barcode : "" });
      }
      const threshold = await readLowStockThreshold(db, session);
      const now = new Date();
      for (const [productId, stockUnits] of aggregateTransferLines(input.lines)) {
        const product = await products.findOne({ id: productId }, { session });
        if (!product) throw new InventoryError("A selected product is no longer available", 409);
        await applyStockDelta(products, product, -stockUnits, threshold, session);
        await recordStockMovement(db, session, { id: `transfer:${input.idempotencyKey}:create:${productId}`, productId, delta: -stockUnits, type: "transfer_out", sourceId: input.idempotencyKey, at: now, description: `Transferred ${stockUnits} units to ${destinationName}` });
      }
      const transfer: Transfer = {
        _id: input.idempotencyKey,
        id: input.idempotencyKey,
        reference: `TRF-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${input.idempotencyKey.slice(0, 6).toUpperCase()}`,
        transferDate: input.transferDate,
        destinationBranchId: input.destinationBranchId,
        destinationNameAtTransfer: destinationName,
        sourceLocation: input.sourceLocation,
        lines,
        manualItems: input.manualItems,
        notes: input.notes,
        status: "Recorded",
        stockAdjusted: true,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        requestHash,
      };
      await transfers.insertOne(transfer, { session });
      return { transfer: publicTransfer(transfer), replayed: false };
    });
    return NextResponse.json(saved.transfer, { status: saved.replayed ? 200 : 201 });
  } catch (error) {
    if (error instanceof InventoryError) return NextResponse.json({ message: error.message }, { status: error.status });
    if (isTransactionUnavailable(error)) return NextResponse.json({ message: "Transfers require MongoDB transaction support; no stock or transfer was changed" }, { status: 503 });
    if (duplicateKey(error)) {
      const client = await clientPromise();
      const existing = await client.db(INVENTORY_DB).collection<Transfer>(COLLECTION).findOne({ _id: input.idempotencyKey });
      if (existing?.requestHash === requestHash) return NextResponse.json(publicTransfer(existing), { status: 200 });
    }
    console.error("Failed to save transfer:", error);
    return NextResponse.json({ message: "Transfer could not be saved" }, { status: 500 });
  }
}
