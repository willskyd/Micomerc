import { DB_NAME as MICOMERC_DB } from "@/lib/database";
import { createHash } from "node:crypto";
import clientPromise from "@/lib/mongodb";
import { NextResponse } from "next/server";

const DB_NAME = MICOMERC_DB;
const COLLECTION = "debts";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function debtSelector(value: string): { id: number | string } | null {
  const numericId = Number(value);
  if (Number.isSafeInteger(numericId) && numericId > 0) return { id: numericId };
  return value.trim() ? { id: value } : null;
}

function publicDebt(value: Record<string, any>) {
  const { _id, appliedOperations, ...debt } = value;
  return debt;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const selector = debtSelector(id);
    if (!selector) return NextResponse.json({ message: "Invalid debt ID" }, { status: 400 });
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ message: "Debt update must be an object" }, { status: 400 });
    const input = body as Record<string, any>;
    if (typeof input.operationId !== "string" || !UUID_PATTERN.test(input.operationId)) return NextResponse.json({ message: "A valid operation ID is required" }, { status: 400 });
    const expectedRevision = input.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return NextResponse.json({ message: "A valid debt revision is required" }, { status: 400 });

    const client = await clientPromise();
    const collection = client.db(DB_NAME).collection<any>(COLLECTION);
    const existing = await collection.findOne(selector);
    if (!existing) return NextResponse.json({ message: "Debt not found" }, { status: 404 });
    const updates: Record<string, unknown> = {};
    for (const field of ["customer", "invoice", "receiptNumber", "items", "amount", "payments", "due", "createdAt", "paidAt"]) {
      if (input[field] !== undefined) updates[field] = input[field];
    }
    const requestHash = createHash("sha256").update(JSON.stringify(updates)).digest("hex");
    const priorOperation = (existing.appliedOperations ?? []).find((operation: any) => operation.id === input.operationId);
    if (priorOperation) {
      if (priorOperation.hash !== requestHash) return NextResponse.json({ message: "Operation ID was already used for different debt details" }, { status: 409 });
      return NextResponse.json(publicDebt(existing));
    }

    const currentRevision = Number.isSafeInteger(existing.revision) ? existing.revision : 0;
    if (currentRevision !== expectedRevision) return NextResponse.json({ message: "Debt changed on the server. Review the current record before retrying." }, { status: 409 });
    if (updates.amount !== undefined && (!Number.isFinite(Number(updates.amount)) || Number(updates.amount) <= 0)) return NextResponse.json({ message: "Debt amount must be greater than zero" }, { status: 400 });
    if (updates.payments !== undefined) {
      if (!Array.isArray(updates.payments) || updates.payments.some((payment: any) => !payment || (typeof payment.id !== "string" && typeof payment.id !== "number") || !Number.isFinite(Number(payment.amount)) || Number(payment.amount) <= 0 || typeof payment.date !== "string")) {
        return NextResponse.json({ message: "Payments must have a valid ID, positive amount, and date" }, { status: 400 });
      }
      const incoming = updates.payments as Array<{ id: string | number; amount: number; date: string }>;
      const prior = Array.isArray(existing.payments) ? existing.payments : [];
      if (prior.some((payment: any) => !incoming.some((next) => next.id === payment.id && Number(next.amount) === Number(payment.amount) && next.date === payment.date))) {
        return NextResponse.json({ message: "Existing payments cannot be changed or removed" }, { status: 409 });
      }
      if (new Set(incoming.map((payment) => String(payment.id))).size !== incoming.length) return NextResponse.json({ message: "Payment IDs must be unique" }, { status: 400 });
      const paid = incoming.reduce((sum, payment) => sum + Math.round(Number(payment.amount) * 100), 0);
      const amount = Math.round(Number(updates.amount ?? existing.amount) * 100);
      if (paid > amount) return NextResponse.json({ message: "Payments cannot exceed the debt balance" }, { status: 400 });
      if (updates.paidAt && paid !== amount) return NextResponse.json({ message: "A debt can only be marked paid when its full balance is covered" }, { status: 400 });
    }
    const result = await collection.updateOne(
      { ...selector, revision: existing.revision ?? { $exists: false }, appliedOperations: { $not: { $elemMatch: { id: input.operationId } } } },
      { $set: { ...updates, revision: currentRevision + 1 }, $push: { appliedOperations: { id: input.operationId, hash: requestHash } } } as any,
    );
    if (result.matchedCount === 0) return NextResponse.json({ message: "Debt changed on the server. Review the current record before retrying." }, { status: 409 });
    const updated = await collection.findOne(selector);
    return NextResponse.json(publicDebt(updated));
  } catch (error) {
    console.error("Failed to update debt:", error);
    return NextResponse.json({ message: "Failed to update debt" }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const selector = debtSelector(id);
    if (!selector) return NextResponse.json({ message: "Invalid debt ID" }, { status: 400 });
    const client = await clientPromise();
    const result = await client.db(DB_NAME).collection(COLLECTION).deleteOne(selector);
    if (result.deletedCount === 0) return NextResponse.json({ message: "Debt not found" }, { status: 404 });
    return NextResponse.json({ success: true, message: "Debt deleted successfully" });
  } catch (error) {
    console.error("Failed to delete debt:", error);
    return NextResponse.json({ message: "Failed to delete debt" }, { status: 500 });
  }
}
