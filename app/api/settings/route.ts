import { DB_NAME as MICOMERC_DB } from "@/lib/database";
import { normalizeWorkspaceName } from "@/lib/branding";
import { createHash } from "node:crypto";
import clientPromise from "@/lib/mongodb";
import { NextResponse } from "next/server";

const DB_NAME = MICOMERC_DB;
const COLLECTION = "settings";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const defaultSettings = {
  workspace: "Micomerc",
  currency: "NGN",
  notifications: "All activity",
  lowStockThreshold: "30",
  dateFormat: "MMM D, YYYY",
};

export async function GET() {
  try {
    const client = await clientPromise();
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION);

    let settings = await collection.findOne({ key: "workspace" });

    if (!settings) {
      const newSettings = {
        key: "workspace",
        revision: 0,
        ...defaultSettings,
      };

      await collection.insertOne(newSettings);
      settings = await collection.findOne({ key: "workspace" });
    }

    if (!settings) {
      throw new Error("Settings could not be loaded");
    }

    const { _id, key, ...publicSettings } = settings;

    return NextResponse.json({
      ...publicSettings,
      workspace: normalizeWorkspaceName(publicSettings.workspace),
    });
  } catch (error) {
    console.error("Failed to load settings:", error);

    return NextResponse.json(
      { message: "Failed to load settings" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ message: "Settings must be an object" }, { status: 400 });
    const input = body as Record<string, unknown>;

    const allowedFields = [
      "workspace",
      "currency",
      "notifications",
      "lowStockThreshold",
      "dateFormat",
    ];

    const updates: Record<string, string> = {};

    for (const field of allowedFields) {
      if (input[field] !== undefined) {
        updates[field] = String(input[field]);
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { message: "No settings to update" },
        { status: 400 }
      );
    }

    const client = await clientPromise();
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION);
    const operationId = typeof input.operationId === "string" ? input.operationId : "";
    const expectedRevision = input.expectedRevision;
    if (operationId && (!UUID.test(operationId) || typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) return NextResponse.json({ message: "Settings operation ID and revision are required" }, { status: 400 });
    const requestHash = createHash("sha256").update(JSON.stringify(updates)).digest("hex");
    const current = await collection.findOne({ key: "workspace" });
    if (operationId && current) {
      const replay = (current.appliedOperations ?? []).find((operation: { id: string }) => operation.id === operationId);
      if (replay) {
        if (replay.hash !== requestHash) return NextResponse.json({ message: "Settings operation ID was used for different changes" }, { status: 409 });
        const { _id, key, appliedOperations, operationHashes, ...saved } = current;
        return NextResponse.json({
          ...saved,
          workspace: normalizeWorkspaceName(saved.workspace),
        });
      }
      const revision = Number.isSafeInteger(current.revision) ? current.revision : 0;
      if (revision !== expectedRevision) return NextResponse.json({ message: "Workspace settings changed on the server. Reload them before retrying." }, { status: 409 });
    }
    if (operationId && !current) return NextResponse.json({ message: "Workspace settings are not initialized; reload before saving" }, { status: 409 });
    const filter: Record<string, unknown> = { key: "workspace" };
    let update: Record<string, unknown> = { $set: { ...updates, key: "workspace" } };
    if (operationId) {
      const revision = Number.isSafeInteger(current?.revision) ? Number(current?.revision) : 0;
      filter.revision = current?.revision ?? { $exists: false };
      update = { $set: { ...updates, key: "workspace", revision: revision + 1 }, $push: { appliedOperations: { id: operationId, hash: requestHash } } };
    }
    const changed = await collection.updateOne(filter, update as any, { upsert: !operationId && !current });
    if (operationId && changed.matchedCount !== 1) return NextResponse.json({ message: "Workspace settings changed while this update was being saved" }, { status: 409 });

    const settings = await collection.findOne({ key: "workspace" });

    if (!settings) {
      throw new Error("Settings could not be saved");
    }

    const { _id, key, appliedOperations, operationHashes, ...publicSettings } = settings;

    return NextResponse.json({
      ...publicSettings,
      workspace: normalizeWorkspaceName(publicSettings.workspace),
    });
  } catch (error) {
    console.error("Failed to update settings:", error);

    return NextResponse.json(
      { message: "Failed to update settings" },
      { status: 500 }
    );
  }
}
