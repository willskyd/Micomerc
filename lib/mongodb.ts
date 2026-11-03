import { MongoClient } from "mongodb";

const options = {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  retryWrites: true,
};

declare global {
  // eslint-disable-next-line no-var
  var _mongoClient: MongoClient | undefined;
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

const globalForMongo = globalThis as typeof globalThis & {
  _mongoClient?: MongoClient;
  _mongoClientPromise?: Promise<MongoClient>;
};

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function connectWithRetry(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("Please define MONGODB_URI in your .env file");
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const client = new MongoClient(uri, options);

    try {
      await client.connect();
      globalForMongo._mongoClient = client;
      return client;
    } catch (error) {
      lastError = error;

      try {
        await client.close();
      } catch {
        // Ignore cleanup errors and allow the next attempt.
      }

      if (attempt < 3) {
        await delay(500 * 2 ** (attempt - 1));
      }
    }
  }

  throw lastError;
}

export default async function clientPromise(): Promise<MongoClient> {
  if (!globalForMongo._mongoClientPromise) {
    globalForMongo._mongoClientPromise = connectWithRetry().catch((error) => {
      // Clear a failed promise so the next API request can try again.
      globalForMongo._mongoClientPromise = undefined;
      globalForMongo._mongoClient = undefined;
      throw error;
    });
  }

  return globalForMongo._mongoClientPromise;
}