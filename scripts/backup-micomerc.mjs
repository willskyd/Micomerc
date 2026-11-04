import { createRequire } from "node:module";
import { MongoClient } from "mongodb";
import { EJSON } from "bson";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const uri = process.env.MICOMERC_MONGODB_URI;

if (!uri || !/^mongodb(\+srv)?:\/\//.test(uri)) {
  throw new Error("MICOMERC_MONGODB_URI is missing or invalid. No backup was created.");
}

const dbName = "micomerc";
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(
  os.homedir(),
  "User",
  "Micomerc-backups",
  `micomerc-${timestamp}`
);

const hash = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const client = new MongoClient(uri, {
  serverSelectionTimeoutMS: 20000,
  connectTimeoutMS: 10000,
});

try {
  await client.connect();

  const db = client.db(dbName);
  await db.command({ ping: 1 });

  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const collectionNames = (
    await db.listCollections({}, { nameOnly: true }).toArray()
  )
    .map((item) => item.name)
    .sort();

  const manifest = {
    database: dbName,
    createdAt: new Date().toISOString(),
    collections: [],
  };

  for (const name of collectionNames) {
    const documents = await db.collection(name).find({}).toArray();
    const content = EJSON.stringify(documents, null, 2, { relaxed: false });
    const file = path.join(backupDir, `${name}.ejson`);

    fs.writeFileSync(file, content, { mode: 0o600 });

    const savedContent = fs.readFileSync(file, "utf8");
    const restored = EJSON.parse(savedContent);

    if (
      restored.length !== documents.length ||
      hash(savedContent) !== hash(content)
    ) {
      throw new Error(`Backup verification failed for collection: ${name}`);
    }

    manifest.collections.push({
      name,
      documentCount: documents.length,
      sha256: hash(savedContent),
      file: `${name}.ejson`,
    });

    console.log(`Verified ${name}: ${documents.length} documents`);
  }

  fs.writeFileSync(
    path.join(backupDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    { mode: 0o600 }
  );

  const total = manifest.collections.reduce(
    (sum, item) => sum + item.documentCount,
    0
  );

  console.log("\nBACKUP VERIFIED");
  console.log(`Database: ${dbName}`);
  console.log(`Collections: ${manifest.collections.length}`);
  console.log(`Documents: ${total}`);
  console.log(`Backup directory: ${backupDir}`);
} finally {
  await client.close().catch(() => {});
}
