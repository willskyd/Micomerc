import { DB_NAME as MICOMERC_DB } from "@/lib/database";
import type { Document } from "mongodb";
import clientPromise from "@/lib/mongodb";
import { NextResponse } from "next/server";

const DB_NAME = MICOMERC_DB;
const COLLECTION = "sales";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SaleDocument = Document & { _id: string; requestHash?: string };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_PATTERN.test(id)) {
      return NextResponse.json({ message: "Invalid sale reference" }, { status: 400 });
    }

    const client = await clientPromise();
    const sale = await client.db(DB_NAME).collection<SaleDocument>(COLLECTION)
      .findOne({ _id: id }, { projection: { requestHash: 0 } });
    if (!sale) {
      return NextResponse.json({ message: "Sale not found" }, { status: 404 });
    }

    const { _id, ...publicSale } = sale;
    return NextResponse.json(publicSale);
  } catch (error) {
    console.error("Failed to load POS sale:", error);
    return NextResponse.json({ message: "Sale receipt is unavailable" }, { status: 500 });
  }
}
