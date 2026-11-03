import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import clientPromise from "@/lib/mongodb";
import { INVENTORY_DB, InventoryError } from "@/lib/inventory";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null || !("name" in body)) throw new InventoryError("Branch name is required");
    const name = (body as { name: unknown }).name;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80) throw new InventoryError("Branch name must be 1 to 80 characters");
    const input = body as Record<string, unknown>;
    const operationId = input.operationId;
    const expectedRevision = input.expectedRevision;
    if (typeof operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId) || typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new InventoryError("Branch operation ID and revision are required");
    const hash = createHash("sha256").update(JSON.stringify({ name: name.trim() })).digest("hex");
    const client = await clientPromise();
    const collection = client.db(INVENTORY_DB).collection<any>("branches");
    const current = await collection.findOne({ id });
    if (!current) throw new InventoryError("Branch not found", 404);
    const prior = (current.appliedOperations ?? []).find((operation: { id: string }) => operation.id === operationId);
    if (prior) {
      if (prior.hash !== hash) throw new InventoryError("Branch operation ID was used for different changes", 409);
      const { _id, appliedOperations, ...branch } = current;
      return NextResponse.json(branch);
    }
    const revision = Number.isSafeInteger(current.revision) ? Number(current.revision) : 0;
    if (revision !== expectedRevision) throw new InventoryError("Branch changed on the server; reload before renaming", 409);
    const duplicate = await collection.findOne({ name: { $regex: `^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" }, id: { $ne: id } });
    if (duplicate) throw new InventoryError("A branch with that name already exists", 409);
    const changed = await collection.updateOne({ id, revision: current.revision ?? { $exists: false } }, { $set: { name: name.trim(), updatedAt: new Date(), revision: revision + 1 }, $push: { appliedOperations: { id: operationId, hash } } } as any);
    if (changed.matchedCount !== 1) throw new InventoryError("Branch changed on the server; reload before renaming", 409);
    const result = await collection.findOne({ id });
    if (!result) throw new InventoryError("Branch not found", 404);
    const { _id, ...branch } = result;
    return NextResponse.json(branch);
  } catch (error) {
    if (error instanceof InventoryError) return NextResponse.json({ message: error.message }, { status: error.status });
    console.error("Failed to rename branch:", error);
    return NextResponse.json({ message: "Branch could not be renamed" }, { status: 500 });
  }
}
