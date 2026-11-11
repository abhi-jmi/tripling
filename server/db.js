import { MongoClient } from "mongodb";
import { mongoFailureDetails } from "./mongo-diagnostics.js";
import { randomUUID } from "node:crypto";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

export function validateMongoConfiguration(env, uri) {
  if (typeof uri !== "string" || !/^mongodb(?:\+srv)?:\/\//.test(uri))
    throw new Error(
      "Configure MONGODB_URI or MONGODB_SECRET_ARN containing a MongoDB uri.",
    );
  if (env.NODE_ENV === "production") {
    for (const [key, value] of new URLSearchParams(uri.split("?")[1] || "")) {
      if (
        (/^(tls|ssl)$/i.test(key) && value.toLowerCase() === "false") ||
        (/^(tlsInsecure|tlsAllowInvalidCertificates|tlsAllowInvalidHostnames)$/i.test(
          key,
        ) &&
          value.toLowerCase() === "true")
      )
        throw new Error("Production MongoDB requires verified TLS.");
    }
  }
  const database = env.MONGODB_DATABASE || "tripling";
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(database))
    throw new Error("Use a valid MONGODB_DATABASE name.");
  return database;
}
export async function createDatabase(env = process.env) {
  let uri = env.MONGODB_URI;
  if (!uri && env.MONGODB_SECRET_ARN) {
    const secrets = new SecretsManagerClient({ region: env.AWS_REGION });
    try {
      const value = await secrets.send(
        new GetSecretValueCommand({ SecretId: env.MONGODB_SECRET_ARN }),
      );
      try {
        uri = JSON.parse(value.SecretString || "{}").uri;
      } catch {
        throw new Error("MongoDB secret must contain a JSON uri field.");
      }
    } finally {
      secrets.destroy();
    }
  }
  const name = validateMongoConfiguration(env, uri);
  let client;
  try {
    client = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      ...(env.NODE_ENV === "production" ? { tls: true } : {}),
      ...(env.MONGODB_TLS_CA_FILE
        ? { tlsCAFile: env.MONGODB_TLS_CA_FILE }
        : {}),
    });
    await client.connect();
    const hello = await client.db("admin").command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid")
      throw new Error(
        "MongoDB must be a replica set or Atlas cluster: transactions are required.",
      );
    return new MongoStore(client, client.db(name));
  } catch (e) {
    await client?.close();
    throw Object.assign(
      new Error(
        "MongoDB connection failed. Check credentials, network access, TLS and replica-set configuration.",
      ),
      {
        code: e.code || "MONGODB_UNAVAILABLE",
        diagnostic: mongoFailureDetails(e),
      },
    );
  }
}
export class MongoStore {
  constructor(client, database, session = null) {
    this.client = client;
    this.database = database;
    this.session = session;
  }
  opts(options = {}) {
    return { ...options, ...(this.session ? { session: this.session } : {}) };
  }
  async one(name, filter = {}, options = {}) {
    return this.database
      .collection(name)
      .findOne(filter, this.opts({ projection: { _id: 0 }, ...options }));
  }
  async all(name, filter = {}, options = {}) {
    return this.database
      .collection(name)
      .find(filter, this.opts({ projection: { _id: 0 }, ...options }))
      .toArray();
  }
  async count(name, filter = {}) {
    return this.database.collection(name).countDocuments(filter, this.opts());
  }
  async insert(name, data) {
    const doc = withDefaults(name, data);
    await this.database.collection(name).insertOne(doc, this.opts());
    const { _id, ...result } = doc;
    return result;
  }
  async update(name, filter, update, options = {}) {
    return this.database
      .collection(name)
      .updateOne(filter, update, this.opts(options));
  }
  async updateMany(name, filter, update, options = {}) {
    return this.database
      .collection(name)
      .updateMany(filter, update, this.opts(options));
  }
  async remove(name, filter) {
    return this.database.collection(name).deleteOne(filter, this.opts());
  }
  async removeMany(name, filter) {
    return this.database.collection(name).deleteMany(filter, this.opts());
  }
  async take(name, filter) {
    return this.database
      .collection(name)
      .findOneAndDelete(
        filter,
        this.opts({ projection: { _id: 0 }, includeResultMetadata: false }),
      );
  }
  async change(name, filter, update, options = {}) {
    return this.database.collection(name).findOneAndUpdate(
      filter,
      update,
      this.opts({
        returnDocument: "after",
        includeResultMetadata: false,
        projection: { _id: 0 },
        ...options,
      }),
    );
  }
  async ping() {
    await this.database.command({ ping: 1 });
  }
  async close() {
    await this.client.close();
  }
}
export function withDefaults(name, data) {
  const now = new Date(),
    id = data.id ?? randomUUID();
  const defaults = {
    users: {
      password_hash: null,
      first_name: null,
      last_name: null,
      display_name: "Traveler",
      city: "",
      gender: "",
      bio: "",
      adult_confirmed: false,
    },
    trips: { status: "open", plan: "", rules: "", image: "manali" },
    reports: { status: "new", note: "" },
    notifications: { read_at: null },
    user_blocks: { ended_at: null, context_trip_id: null },
    trip_members: { joined_at: now },
    trip_participants: {
      first_joined_at: now,
      last_joined_at: now,
      left_at: null,
    },
    join_requests: { status: "pending", updated_at: now },
    legal_acceptances: { accepted_at: now },
  };
  return {
    _id: data._id ?? id,
    id,
    created_at: now,
    ...defaults[name],
    ...data,
  };
}
export async function transaction(store, action) {
  const session = store.client.startSession();
  try {
    return await session.withTransaction(
      () => action(new MongoStore(store.client, store.database, session)),
      {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
        maxCommitTimeMS: 15000,
      },
    );
  } finally {
    await session.endSession();
  }
}
// Conflicting membership decisions write the same trip/user documents. MongoDB
// retries the entire transaction on write conflicts, preventing overbooking and
// block/approval write skew across ECS tasks.
export async function lockTrip(db, id) {
  return db.change("trips", { id }, { $inc: { _revision: 1 } });
}
export async function lockTravelers(db, ids) {
  for (const id of [...new Set(ids)].sort())
    await db.update("users", { id }, { $inc: { _safety_revision: 1 } });
}
