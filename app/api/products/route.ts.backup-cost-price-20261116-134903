import { DB_NAME as MICOMERC_DB } from "@/lib/database";
import { createHash } from "node:crypto";
import clientPromise from "@/lib/mongodb";
import { isValidBarcode, normalizeBarcode } from "@/lib/barcode";
import { NextResponse } from "next/server";

const DB_NAME = MICOMERC_DB;
const COLLECTION = "products";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// GET all products
export async function GET() {
  try {
    const client = await clientPromise();
    const db = client.db(DB_NAME);

    const products = await db
      .collection(COLLECTION)
      .find({})
      .sort({ id: 1 })
      .toArray();

    return NextResponse.json(products);
  } catch (error) {
    console.error("Failed to fetch products:", error);

    return NextResponse.json(
      { message: "Failed to fetch products" },
      { status: 500 }
    );
  }
}

// POST a new product
export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ message: "Request body must be valid JSON" }, { status: 400 });
    }
    if (!isRecord(body)) {
      return NextResponse.json({ message: "Product details must be a JSON object" }, { status: 400 });
    }

    const { name, model, sku, category, stock, price, status } = body;
    const barcodeValue = body.barcode === undefined ? "" : body.barcode;
    const parsedStock = Number(stock);
    const parsedPrice = Number(price);

    if (
      typeof name !== "string" || !name.trim() ||
      typeof model !== "string" || !model.trim() ||
      typeof sku !== "string" || !sku.trim() ||
      typeof category !== "string" || !category.trim() ||
      typeof status !== "string" || !status.trim() ||
      stock === undefined || !Number.isFinite(parsedStock) || parsedStock < 0 ||
      price === undefined || !Number.isFinite(parsedPrice) || parsedPrice < 0 ||
      typeof barcodeValue !== "string"
    ) {
      return NextResponse.json(
        { message: "Product details are invalid or incomplete" },
        { status: 400 }
      );
    }

    const barcode = normalizeBarcode(barcodeValue);
    if (!isValidBarcode(barcode)) {
      return NextResponse.json(
        { message: "Barcode must be 128 characters or fewer and contain no control characters" },
        { status: 400 }
      );
    }

    const client = await clientPromise();
    const db = client.db(DB_NAME);

    const collection = db.collection<any>(COLLECTION);
    const operationId = typeof body.operationId === "string" ? body.operationId : "";
    if (operationId && !UUID.test(operationId)) return NextResponse.json({ message: "Product operation ID is invalid" }, { status: 400 });
    const productInput = { name: name.trim(), model: model.trim(), sku: sku.trim(), category: category.trim(), barcode, stock: parsedStock, price: parsedPrice, status: String(status).trim() };
    const requestHash = createHash("sha256").update(JSON.stringify(productInput)).digest("hex");
    if (operationId) {
      const replay = await collection.findOne({ _id: operationId });
      if (replay) {
        if (replay.requestHash !== requestHash) return NextResponse.json({ message: "This product operation ID was used for different details" }, { status: 409 });
        const { _id, requestHash: ignored, ...saved } = replay;
        return NextResponse.json(saved);
      }
    }
    if (barcode) {
      const duplicateBarcode = await collection.findOne({
        $expr: { $eq: [{ $trim: { input: { $cond: [{ $eq: [{ $type: "$barcode" }, "string"] }, "$barcode", ""] } } }, barcode] },
      });
      if (duplicateBarcode) return NextResponse.json({ message: "That barcode is already assigned to another product" }, { status: 409 });
    }
    const requestedId = body.id;
    if (operationId && (typeof requestedId !== "number" || !Number.isSafeInteger(requestedId) || requestedId <= 0)) return NextResponse.json({ message: "A valid product ID is required for an offline product" }, { status: 400 });
    let id: number;
    if (operationId) {
      id = requestedId as number;
      if (await collection.findOne({ id })) return NextResponse.json({ message: "This product ID is already in use. Review the local product before syncing." }, { status: 409 });
    } else {
      const lastProduct = await collection
      .find({})
      .sort({ id: -1 })
      .limit(1)
      .toArray();
      id = lastProduct.length > 0 ? lastProduct[0].id + 1 : 1;
    }

    const product = {
      ...(operationId ? { _id: operationId, requestHash, revision: 1 } : {}),
      id,
      ...productInput,
    };

    await collection.insertOne(product);

    const { _id, requestHash: ignored, ...saved } = product;
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    console.error("Failed to create product:", error);

    return NextResponse.json(
      { message: "Failed to create product" },
      { status: 500 }
    );
  }
}
