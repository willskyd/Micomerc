import { DB_NAME as MICOMERC_DB } from "@/lib/database";
import { createHash } from "node:crypto";
import clientPromise from "@/lib/mongodb";
import { NextResponse } from "next/server";

const DB_NAME = MICOMERC_DB;
const COLLECTION = "activities";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// GET all activities
export async function GET() {
  try {
    const client = await clientPromise();
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION);

    const activities = await collection
      .find({})
      .sort({ id: -1 })
      .toArray();

    return NextResponse.json(activities);
  } catch (error) {
    console.error("Failed to load activities:", error);

    return NextResponse.json(
      { message: "Failed to load activities" },
      { status: 500 }
    );
  }
}

// POST a new activity
export async function POST(request: Request) {
  try {
    const body = await request.json();

    const operationId =
      typeof body.operationId === "string" ? body.operationId : "";

    if (!UUID_PATTERN.test(operationId)) {
      return NextResponse.json(
        { message: "A valid activity operation ID is required" },
        { status: 400 }
      );
    }

    const text = String(body.text || "").trim();

    const detail = body.detail
      ? String(body.detail).trim()
      : undefined;

    const time = String(body.time || "").trim();

    if (!text || !time) {
      return NextResponse.json(
        { message: "Activity text and time are required" },
        { status: 400 }
      );
    }

    const client = await clientPromise();
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION);

    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          text,
          detail: detail ?? "",
          time,
        })
      )
      .digest("hex");

    const existing = await collection.findOne({ _id: operationId });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        return NextResponse.json(
          {
            message:
              "Activity operation ID was used for different details",
          },
          { status: 409 }
        );
      }

      const { _id, requestHash: savedHash, ...publicActivity } = existing;

      return NextResponse.json(publicActivity);
    }

    const activity = {
      _id: operationId,
      id: Number.parseInt(
        operationId.replaceAll("-", "").slice(0, 12),
        16
      ),
      text,
      ...(detail ? { detail } : {}),
      time,
      read: false,
      requestHash,
    };

    await collection.insertOne(activity);

    const {
      _id,
      requestHash: savedHash,
      ...publicActivity
    } = activity;

    return NextResponse.json(publicActivity, { status: 201 });
  } catch (error) {
    console.error("Failed to create activity:", error);

    return NextResponse.json(
      { message: "Failed to create activity" },
      { status: 500 }
    );
  }
}