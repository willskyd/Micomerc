import { DB_NAME as MICOMERC_DB } from "@/lib/database";
import { createHash } from "node:crypto";
import clientPromise from "@/lib/mongodb";
import { isValidBarcode, normalizeBarcode } from "@/lib/barcode";
import { NextResponse } from "next/server";
import { ensureCollections, InventoryError, INVENTORY_DB, isTransactionUnavailable, withInventoryTransaction } from "@/lib/inventory";

const DB_NAME = MICOMERC_DB;
const COLLECTION = "products";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const productId = Number(id);

    if (!Number.isSafeInteger(productId) || productId <= 0) {
      return NextResponse.json(
        { message: "Invalid product ID" },
        { status: 400 }
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ message: "Request body must be valid JSON" }, { status: 400 });
    }
    if (!isRecord(body)) {
      return NextResponse.json({ message: "Product updates must be a JSON object" }, { status: 400 });
    }

    const allowedFields = [
      "name",
      "model",
      "sku",
      "barcode",
      "category",
      "stock",
      "price",
      "status",
    ];

    const updates: Record<string, unknown> = {};

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    if ("barcode" in updates) {
      const barcodeValue = updates.barcode;
      if (typeof barcodeValue !== "string") {
        return NextResponse.json({ message: "Barcode must be text" }, { status: 400 });
      }
      const barcode = normalizeBarcode(barcodeValue);
      if (!isValidBarcode(barcode)) {
        return NextResponse.json(
          { message: "Barcode must be 128 characters or fewer and contain no control characters" },
          { status: 400 }
        );
      }
      updates.barcode = barcode;
    }

    if ("stock" in updates) {
      const stock = Number(updates.stock);
      if (!Number.isFinite(stock) || stock < 0) {
        return NextResponse.json({ message: "Stock must be a non-negative number" }, { status: 400 });
      }
      updates.stock = stock;
    }

    if ("price" in updates) {
      const price = Number(updates.price);
      if (!Number.isFinite(price) || price < 0) {
        return NextResponse.json({ message: "Price must be a non-negative number" }, { status: 400 });
      }
      updates.price = price;
    }

    if ("status" in updates &&
      !["In stock", "Low stock", "Out of stock", "Discontinued"].includes(String(updates.status))) {
      return NextResponse.json({ message: "Product status is invalid" }, { status: 400 });
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { message: "No fields to update" },
        { status: 400 }
      );
    }

    const client = await clientPromise();
    const db = client.db(DB_NAME);
    const collection = db.collection<any>(COLLECTION);
    const operationId = typeof body.operationId === "string" ? body.operationId : "";
    const expectedRevision = body.expectedRevision;
    if (operationId && (!UUID.test(operationId) || typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) return NextResponse.json({ message: "Product operation ID and revision are required" }, { status: 400 });
    const requestHash = createHash("sha256").update(JSON.stringify(updates)).digest("hex");
    const existing = await collection.findOne({ id: productId });
    if (!existing) return NextResponse.json({ message: "Product not found" }, { status: 404 });
    if (typeof updates.stock === "number" && updates.stock < Number(existing.reservedStock ?? 0)) return NextResponse.json({ message: "Stock cannot be reduced below quantities reserved for pending orders" }, { status: 409 });
    if (operationId) {
      const replay = (existing.appliedOperations ?? []).find((operation: any) => operation.id === operationId);
      if (replay) {
        if (replay.hash !== requestHash) return NextResponse.json({ message: "This product operation ID was used for different updates" }, { status: 409 });
        const { _id, appliedOperations, ...saved } = existing;
        return NextResponse.json(saved);
      }
      const revision = Number.isSafeInteger(existing.revision) ? existing.revision : 0;
      if (revision !== expectedRevision) return NextResponse.json({ message: "Product changed on the server. Review it before retrying." }, { status: 409 });
    }

    if (typeof updates.barcode === "string" && updates.barcode) {
      const duplicateBarcode = await collection.findOne({
        $expr: {
          $eq: [
            { $trim: { input: { $cond: [{ $eq: [{ $type: "$barcode" }, "string"] }, "$barcode", ""] } } },
            updates.barcode,
          ],
        },
        id: { $ne: productId },
      });
      if (duplicateBarcode) {
        return NextResponse.json(
          { message: "That barcode is already assigned to another product" },
          { status: 409 }
        );
      }
    }

    const filter: Record<string, unknown> = { id: productId };
    let update: Record<string, unknown> = { $set: updates };
    if (operationId) {
      const revision = Number.isSafeInteger(existing.revision) ? existing.revision : 0;
      filter.revision = existing.revision ?? { $exists: false };
      filter.appliedOperations = { $not: { $elemMatch: { id: operationId } } };
      update = { $set: { ...updates, revision: revision + 1 }, $push: { appliedOperations: { id: operationId, hash: requestHash } } };
    }
    const result = await collection.updateOne(filter, update as any);

    if (result.matchedCount === 0) {
      const latest = await collection.findOne({ id: productId });
      if (latest && operationId) return NextResponse.json({ message: "Product changed on the server. Review the current record before retrying." }, { status: 409 });
      return NextResponse.json(
        { message: "Product not found" },
        { status: 404 }
      );
    }

    const updatedProduct = await collection.findOne({
      id: productId,
    });
    if (operationId) {
      const { _id, appliedOperations, ...saved } = updatedProduct;
      return NextResponse.json(saved);
    }
    return NextResponse.json(updatedProduct);
  } catch (error) {
    console.error("Failed to update product:", error);

    return NextResponse.json(
      { message: "Failed to update product" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const productId = Number(id);

    if (!Number.isFinite(productId)) {
      return NextResponse.json(
        { message: "Invalid product ID" },
        { status: 400 }
      );
    }

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const operationId = typeof body?.operationId === "string" ? body.operationId : "";
    if (operationId && !UUID.test(operationId)) return NextResponse.json({ message: "Product delete operation ID is invalid" }, { status: 400 });
    const client = await clientPromise();
    const db = client.db(INVENTORY_DB);
    if (!operationId) {
      const result = await db.collection(COLLECTION).deleteOne({ id: productId });
      if (result.deletedCount === 0) return NextResponse.json({ message: "Product not found" }, { status: 404 });
    } else {
      await ensureCollections(db, ["operationLedger"]);
      const requestHash = createHash("sha256").update(JSON.stringify({ action: "product.delete", productId })).digest("hex");
      await withInventoryTransaction(client, async (session) => {
        const ledger = db.collection<any>("operationLedger");
        const replay = await ledger.findOne({ _id: operationId }, { session });
        if (replay) {
          if (replay.requestHash !== requestHash) throw new InventoryError("This delete operation ID was used for different product details", 409);
          return;
        }
        const products = db.collection<any>(COLLECTION);
        const existing = await products.findOne({ id: productId }, { session });
        if (!existing) throw new InventoryError("Product not found", 404);
        if (Number(existing.reservedStock ?? 0) > 0) throw new InventoryError("Product has stock reserved by a pending order and cannot be deleted", 409);
        const removed = await products.deleteOne({ id: productId, $expr: { $eq: [{ $ifNull: ["$reservedStock", 0] }, 0] } }, { session });
        if (removed.deletedCount !== 1) throw new InventoryError("Product stock changed while deleting it. Review inventory and retry", 409);
        await ledger.insertOne({ _id: operationId, requestHash, type: "product.delete", recordId: productId, createdAt: new Date() }, { session });
      });
    }

    return NextResponse.json({
      success: true,
      message: "Product deleted successfully",
    });
  } catch (error) {
    if (error instanceof InventoryError) return NextResponse.json({ message: error.message }, { status: error.status });
    if (isTransactionUnavailable(error)) return NextResponse.json({ message: "Product deletion requires MongoDB transactions; no product was deleted" }, { status: 503 });
    console.error("Failed to delete product:", error);

    return NextResponse.json(
      { message: "Failed to delete product" },
      { status: 500 }
    );
  }
}
