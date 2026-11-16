import { DB_NAME as MICOMERC_DB } from "@/lib/database";
import type { Document } from "mongodb";
import clientPromise from "@/lib/mongodb";
import { NextResponse } from "next/server";

const DB_NAME = MICOMERC_DB;

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const from = params.get("from");
    const to = params.get("to");

    if (!from || !to) {
      return NextResponse.json(
        { message: "A start date and end date are required" },
        { status: 400 },
      );
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);

    if (
      Number.isNaN(fromDate.getTime()) ||
      Number.isNaN(toDate.getTime()) ||
      fromDate >= toDate
    ) {
      return NextResponse.json(
        { message: "The selected date range is invalid" },
        { status: 400 },
      );
    }

    const match: Document = {
      cancelled: { $ne: true },
      status: { $not: /^(cancelled|void|refunded)$/i },
      "payment.status": { $not: /^(cancelled|void|refunded)$/i },
      createdAt: { $gte: fromDate, $lt: toDate },
    };

    const client = await clientPromise();

    const items = await client
      .db(DB_NAME)
      .collection("sales")
      .aggregate<{
        productId: number;
        name: string;
        quantitySold: number;
      }>([
        { $match: match },
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.productId",
            name: { $first: "$items.name" },
            quantitySold: { $sum: "$items.quantity" },
          },
        },
        { $sort: { quantitySold: -1, name: 1 } },
        {
          $project: {
            _id: 0,
            productId: "$_id",
            name: 1,
            quantitySold: 1,
          },
        },
      ])
      .toArray();

    return NextResponse.json({
      items,
      totalUnits: items.reduce((total, item) => total + item.quantitySold, 0),
      productCount: items.length,
    });
  } catch (error) {
    console.error("Failed to load units sold report:", error);
    return NextResponse.json(
      { message: "Units sold report is unavailable" },
      { status: 500 },
    );
  }
}
