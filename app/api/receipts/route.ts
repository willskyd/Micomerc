import { DB_NAME as MICOMERC_DB } from "@/lib/database";
import { createHash } from "node:crypto";
import clientPromise from "@/lib/mongodb";
import { NextResponse } from "next/server";

const DB_NAME = MICOMERC_DB;
const COLLECTION = "receipts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// GET all receipts
export async function GET() {
  try {
    const client = await clientPromise();
    const db = client.db(DB_NAME);

    const receipts = await db
      .collection(COLLECTION)
      .find({})
      .sort({ id: -1 })
      .toArray();

    return NextResponse.json(receipts);
  } catch (error) {
    console.error("Failed to fetch receipts:", error);

    return NextResponse.json(
      { message: "Failed to fetch receipts" },
      { status: 500 }
    );
  }
}

// POST a new receipt
export async function POST(request: Request) {
  try {
    const body = await request.json();

    const {
      name,
      model,
      quantity,
      invoice,
      date,
    } = body;

    if (
      !name ||
      !model ||
      quantity === undefined ||
      !invoice ||
      !date
    ) {
      return NextResponse.json(
        { message: "Missing required fields" },
        { status: 400 }
      );
    }

    const client = await clientPromise();
    const db = client.db(DB_NAME);
    const collection = db.collection<any>(COLLECTION);
    const operationId = typeof body.operationId === "string" ? body.operationId : "";
    if (operationId && !UUID.test(operationId)) return NextResponse.json({ message: "Receipt operation ID is invalid" }, { status: 400 });
    const idempotentReceipt = { name: String(name).trim(), model: String(model).trim(), quantity: Number(quantity), invoice: String(invoice).trim(), date: String(date).trim() };
    if (operationId) {
      const replay = await collection.findOne({ _id: operationId });
      if (replay) {
        const hash = createHash("sha256").update(JSON.stringify(idempotentReceipt)).digest("hex");
        if (replay.requestHash !== hash) return NextResponse.json({ message: "Receipt operation ID was used for different details" }, { status: 409 });
        const { _id, requestHash, ...saved } = replay;
        return NextResponse.json(saved);
      }
    }

    const requestedId = body.id;
    if (operationId && (!Number.isSafeInteger(requestedId) || requestedId <= 0)) return NextResponse.json({ message: "A valid receipt ID is required" }, { status: 400 });
    let id: number;
    if (operationId) {
      id = requestedId as number;
      if (await collection.findOne({ id })) return NextResponse.json({ message: "This receipt ID is already in use" }, { status: 409 });
    } else {
      const lastReceipt = await collection
      .find({})
      .sort({ id: -1 })
      .limit(1)
      .toArray();
      id = lastReceipt.length > 0 ? lastReceipt[0].id + 1 : 1;
    }

    const receipt = {
      ...(operationId ? { _id: operationId, requestHash: createHash("sha256").update(JSON.stringify(idempotentReceipt)).digest("hex"), revision: 1 } : {}),
      id,
      ...idempotentReceipt,
    };

    await collection.insertOne(receipt);

    const { _id, requestHash, ...saved } = receipt;
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    console.error("Failed to create receipt:", error);

    return NextResponse.json(
      { message: "Failed to create receipt" },
      { status: 500 }
    );
  }
}
