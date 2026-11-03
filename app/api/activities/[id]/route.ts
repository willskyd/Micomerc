import { DB_NAME as MICOMERC_DB } from "@/lib/database";
import { createHash } from "node:crypto";
import clientPromise from "@/lib/mongodb";
import { NextResponse } from "next/server";

const DB_NAME = MICOMERC_DB;
const COLLECTION = "activities";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const activityId = Number(id);

    if (!Number.isFinite(activityId)) {
      return NextResponse.json(
        { message: "Invalid activity ID" },
        { status: 400 }
      );
    }

    const body = await request.json();

    if (typeof body.read !== "boolean" || typeof body.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.operationId)) {
      return NextResponse.json(
        { message: "read must be a boolean" },
        { status: 400 }
      );
    }

    const client = await clientPromise();
    const db = client.db(DB_NAME);
    const hash = createHash("sha256").update(JSON.stringify({ read: body.read })).digest("hex");
    const collection = db.collection<any>(COLLECTION);
    const current = await collection.findOne({ id: activityId });
    if (!current) return NextResponse.json({ message: "Activity not found" }, { status: 404 });
    const prior = (current.appliedOperations ?? []).find((operation: { id: string }) => operation.id === body.operationId);
    if (prior) {
      if (prior.hash !== hash) return NextResponse.json({ message: "Operation ID was used for different activity changes" }, { status: 409 });
      const { _id, appliedOperations, ...replayed } = current;
      return NextResponse.json(replayed);
    }

    const result = await collection.updateOne(
      { id: activityId, appliedOperations: { $ne: body.operationId } },
      {
        $set: { read: body.read },
        $push: { appliedOperations: { id: body.operationId, hash } },
      } as any
    );

    if (result.matchedCount === 0) {
      const latest = await collection.findOne({ id: activityId });
      if (!latest) return NextResponse.json({ message: "Activity not found" }, { status: 404 });
      const applied = (latest.appliedOperations ?? []).find((operation: { id: string }) => operation.id === body.operationId);
      if (!applied) return NextResponse.json({ message: "Activity changed while this update was being saved" }, { status: 409 });
      if (applied.hash !== hash) return NextResponse.json({ message: "Operation ID was used for different activity changes" }, { status: 409 });
      const { _id, appliedOperations, ...replayed } = latest;
      return NextResponse.json(replayed);
    }

    const updatedActivity = await collection.findOne({ id: activityId });
    if (!updatedActivity) return NextResponse.json({ message: "Activity not found" }, { status: 404 });
    const { _id, appliedOperations, ...saved } = updatedActivity;
    return NextResponse.json(saved);
  } catch (error) {
    console.error("Failed to update activity:", error);

    return NextResponse.json(
      { message: "Failed to update activity" },
      { status: 500 }
    );
  }
}
