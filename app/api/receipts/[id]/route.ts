import { DB_NAME as MICOMERC_DB } from "@/lib/database";
import { createHash } from "node:crypto";
import clientPromise from "@/lib/mongodb";
import { NextResponse } from "next/server";
import { ensureCollections, InventoryError, isTransactionUnavailable, withInventoryTransaction } from "@/lib/inventory";

const DB_NAME = MICOMERC_DB;
const COLLECTION = "receipts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// UPDATE receipt
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const receiptId = Number(id);

    if (!Number.isFinite(receiptId)) {
      return NextResponse.json(
        { message: "Invalid receipt ID" },
        { status: 400 }
      );
    }

    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ message: "Receipt update must be an object" }, { status: 400 });
    const input = body as Record<string, any>;

    const updates: Record<string, string | number> = {};

    if (input.name !== undefined) {
      updates.name = String(input.name).trim();
    }

    if (input.model !== undefined) {
      updates.model = String(input.model).trim();
    }

    if (input.quantity !== undefined) {
      const quantity = Number(input.quantity);

      if (!Number.isFinite(quantity) || quantity < 0) {
        return NextResponse.json(
          { message: "Invalid quantity" },
          { status: 400 }
        );
      }

      updates.quantity = quantity;
    }

    if (input.invoice !== undefined) {
      updates.invoice = String(input.invoice).trim();
    }

    if (input.date !== undefined) {
      updates.date = String(input.date).trim();
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
    const operationId = typeof input.operationId === "string" ? input.operationId : "";
    const expectedRevision = input.expectedRevision;
    if (operationId && (!UUID.test(operationId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) return NextResponse.json({ message: "Receipt operation ID and revision are required" }, { status: 400 });
    const requestHash = createHash("sha256").update(JSON.stringify(updates)).digest("hex");
    const existing = await collection.findOne({ id: receiptId });
    if (!existing) return NextResponse.json({ message: "Receipt not found" }, { status: 404 });
    if (operationId) {
      const replay = (existing.appliedOperations ?? []).find((operation: any) => operation.id === operationId);
      if (replay) {
        if (replay.hash !== requestHash) return NextResponse.json({ message: "Receipt operation ID was used for different updates" }, { status: 409 });
        const { _id, appliedOperations, ...saved } = existing;
        return NextResponse.json(saved);
      }
      const revision = Number.isSafeInteger(existing.revision) ? existing.revision : 0;
      if (revision !== expectedRevision) return NextResponse.json({ message: "Receipt changed on the server. Review it before retrying." }, { status: 409 });
    }

    const filter: Record<string, unknown> = { id: receiptId };
    let operation: Record<string, unknown> = { $set: updates };
    if (operationId) {
      const revision = Number.isSafeInteger(existing.revision) ? existing.revision : 0;
      filter.revision = existing.revision ?? { $exists: false };
      filter.appliedOperations = { $not: { $elemMatch: { id: operationId } } };
      operation = { $set: { ...updates, revision: revision + 1 }, $push: { appliedOperations: { id: operationId, hash: requestHash } } };
    }
    const result = await collection.updateOne(filter, operation as any);

    if (result.matchedCount === 0) {
      const latest = await collection.findOne({ id: receiptId });
      if (latest && operationId) return NextResponse.json({ message: "Receipt changed on the server. Review the current record before retrying." }, { status: 409 });
      return NextResponse.json(
        { message: "Receipt not found" },
        { status: 404 }
      );
    }

    const updatedReceipt = await collection.findOne({ id: receiptId });

    if (operationId) {
      const { _id, appliedOperations, ...saved } = updatedReceipt;
      return NextResponse.json(saved);
    }
    return NextResponse.json(updatedReceipt);
  } catch (error) {
    console.error("Failed to update receipt:", error);

    return NextResponse.json(
      { message: "Failed to update receipt" },
      { status: 500 }
    );
  }
}

// DELETE receipt
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const receiptId = Number(id);

    if (!Number.isFinite(receiptId)) {
      return NextResponse.json(
        { message: "Invalid receipt ID" },
        { status: 400 }
      );
    }

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const operationId = typeof body?.operationId === "string" ? body.operationId : "";
    if (operationId && !UUID.test(operationId)) return NextResponse.json({ message: "Receipt delete operation ID is invalid" }, { status: 400 });
    const client = await clientPromise();
    const db = client.db(DB_NAME);
    if (!operationId) {
      const result = await db.collection(COLLECTION).deleteOne({ id: receiptId });
      if (result.deletedCount === 0) return NextResponse.json({ message: "Receipt not found" }, { status: 404 });
    } else {
      await ensureCollections(db, ["operationLedger"]);
      const requestHash = createHash("sha256").update(JSON.stringify({ action: "receipt.delete", receiptId })).digest("hex");
      await withInventoryTransaction(client, async (session) => {
        const ledger = db.collection<any>("operationLedger");
        const replay = await ledger.findOne({ _id: operationId }, { session });
        if (replay) {
          if (replay.requestHash !== requestHash) throw new InventoryError("This delete operation ID was used for different receipt details", 409);
          return;
        }
        const removed = await db.collection(COLLECTION).deleteOne({ id: receiptId }, { session });
        if (removed.deletedCount !== 1) throw new InventoryError("Receipt not found", 404);
        await ledger.insertOne({ _id: operationId, requestHash, type: "receipt.delete", recordId: receiptId, createdAt: new Date() }, { session });
      });
    }

    return NextResponse.json({
      message: "Receipt deleted successfully",
    });
  } catch (error) {
    if (error instanceof InventoryError) return NextResponse.json({ message: error.message }, { status: error.status });
    if (isTransactionUnavailable(error)) return NextResponse.json({ message: "Receipt deletion requires MongoDB transactions; no receipt was deleted" }, { status: 503 });
    console.error("Failed to delete receipt:", error);

    return NextResponse.json(
      { message: "Failed to delete receipt" },
      { status: 500 }
    );
  }
}
