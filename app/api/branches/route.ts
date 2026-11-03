import { NextResponse } from "next/server";
import clientPromise from "@/lib/mongodb";
import { INVENTORY_DB, InventoryError } from "@/lib/inventory";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET() {
  try {
    const client = await clientPromise();
    const records = await client.db(INVENTORY_DB).collection("branches").find({}).sort({ name: 1 }).toArray();
    const persisted = records.map(({ _id, ...record }) => record);
    return NextResponse.json(persisted);
  } catch (error) {
    console.error("Failed to load branches:", error);
    return NextResponse.json({ message: "Branch list is unavailable" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null) throw new InventoryError("Branch details are invalid");
    const { id, name } = body as Record<string, unknown>;
    if (typeof id !== "string" || (!UUID.test(id) && !/^branch-[a-z0-9-]{1,40}$/i.test(id))) throw new InventoryError("Branch ID is invalid");
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80) throw new InventoryError("Branch name must be 1 to 80 characters");
    const client = await clientPromise();
    const collection = client.db(INVENTORY_DB).collection("branches");
    const existing = await collection.findOne({ $or: [{ id }, { name: { $regex: `^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } }] });
    if (existing) {
      if (existing.id === id && existing.name === name.trim()) return NextResponse.json({ id: existing.id, name: existing.name, createdAt: existing.createdAt }, { status: 200 });
      return NextResponse.json({ message: "A branch with that name or ID already exists" }, { status: 409 });
    }
    const branch = { id, name: name.trim(), createdAt: new Date() };
    await collection.insertOne(branch);
    return NextResponse.json(branch, { status: 201 });
  } catch (error) {
    if (error instanceof InventoryError) return NextResponse.json({ message: error.message }, { status: error.status });
    console.error("Failed to add branch:", error);
    return NextResponse.json({ message: "Branch could not be saved" }, { status: 500 });
  }
}
