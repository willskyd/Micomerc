import { createRequire } from "node:module";
import { MongoClient } from "mongodb";
import { EJSON } from "bson";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const uri = process.env.MICOMERC_MONGODB_URI;
const backupDir = path.join(
  process.env.HOME,
  "User/Micomerc-backups/micomerc-2026-11-03T11-37-23-516Z"
);

if (!uri || !/^mongodb(\+srv)?:\/\//.test(uri)) {
  throw new Error("Dedicated Micomerc MongoDB URI missing. Aborting.");
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8")
);

if (manifest.database !== "micomerc" || manifest.collections.length !== 14) {
  throw new Error("Backup manifest does not match expected Micomerc backup. Aborting.");
}

const hash = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });

try {
  await client.connect();

  const db = client.db("micomerc");
  await db.command({ ping: 1 });

  const currentNames = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((item) => item.name)
    .sort();

  const backupNames = manifest.collections.map((item) => item.name).sort();

  if (JSON.stringify(currentNames) !== JSON.stringify(backupNames)) {
    throw new Error("Live collection list differs from backup. Aborting.");
  }

  for (const item of manifest.collections) {
    const file = path.join(backupDir, item.file);
    const content = fs.readFileSync(file, "utf8");
    const docs = EJSON.parse(content);

    if (hash(content) !== item.sha256 || docs.length !== item.documentCount) {
      throw new Error(`Backup verification failed for ${item.name}. Aborting.`);
    }

    const liveCount = await db.collection(item.name).countDocuments();

    if (liveCount !== item.documentCount) {
      throw new Error(
        `${item.name} has ${liveCount} live documents; backup has ${item.documentCount}. Aborting.`
      );
    }
  }

  console.log("Backup and live database checks passed.");
  console.log("Starting transaction to clear all 14 Micomerc collections...");

  const session = client.startSession();

  try {
    await session.withTransaction(async () => {
      for (const item of manifest.collections) {
        const result = await db.collection(item.name).deleteMany({}, { session });

        if (result.deletedCount !== item.documentCount) {
          throw new Error(`Unexpected deletion count for ${item.name}.`);
        }
      }

      for (const item of manifest.collections) {
        const remaining = await db.collection(item.name).countDocuments({}, { session });
        if (remaining !== 0) {
          throw new Error(`${item.name} is not empty. Aborting transaction.`);
        }
      }
    });
  } finally {
    await session.endSession();
  }

  console.log("\nMICOMERC DATA RESET VERIFIED");
  console.log("Collections cleared: 14");
  console.log("Documents removed: 52");
  console.log("Collections and indexes preserved.");
} finally {
  await client.close();
}
