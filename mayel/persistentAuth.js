const fs = require("fs-extra");
const path = require("path");
const { MongoClient } = require("mongodb");
const { useMultiFileAuthState } = require("prince-baileys");

function cleanKey(value) {
  return String(value || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 180) || "default";
}

function getMongoUri() {
  return String(process.env.MONGODB_URI || "").trim();
}

function getDatabaseName() {
  return String(process.env.MONGODB_DB || "haywhy_mdx_bot").trim() || "haywhy_mdx_bot";
}

function explainMongoError(error) {
  const message = error?.message || String(error);
  if (/authentication|credentials|auth/i.test(message)) {
    return `${message}. Check the MongoDB username and password.`;
  }
  if (/server selection|timed out|ECONNREFUSED|TLS|SSL/i.test(message)) {
    return `${message}. In MongoDB Atlas, allow Railway/your host in Network Access.`;
  }
  return message;
}

async function createPersistentAuthState({ directory, sessionKey }) {
  const mongoUri = getMongoUri();
  if (!mongoUri) {
    throw new Error("MONGODB_URI is required for persistent WhatsApp authentication.");
  }

  const safeSessionKey = cleanKey(sessionKey || process.env.BOT_ID || "default");
  await fs.ensureDir(directory);

  const client = new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
    maxPoolSize: 5,
  });
  await client.connect();

  const collection = client
    .db(getDatabaseName())
    .collection("whatsapp_auth_files");

  async function readRemoteFiles() {
    const documents = await collection.find({ bot: safeSessionKey }).toArray();
    for (const document of documents) {
      if (!document.file || !document.data) continue;
      const target = path.join(directory, path.basename(document.file));
      await fs.writeFile(target, Buffer.from(document.data, "base64"));
    }
    return documents.length;
  }

  let uploadTimer = null;
  let uploadInProgress = null;
  let uploadAgain = false;
  let closed = false;
  let remoteCleared = false;

  async function uploadLocalFiles() {
    if (closed || remoteCleared) return;
    const names = await fs.readdir(directory);
    const files = names.filter((name) => name.endsWith(".json"));
    if (!files.length || closed || remoteCleared) return;

    const operations = [];
    for (const file of files) {
      if (closed || remoteCleared) return;
      const data = (await fs.readFile(path.join(directory, file))).toString("base64");
      operations.push({
        updateOne: {
          filter: { bot: safeSessionKey, file },
          update: {
            $set: { bot: safeSessionKey, file, data, updatedAt: new Date() },
          },
          upsert: true,
        },
      });
    }

    if (operations.length && !closed && !remoteCleared) {
      await collection.bulkWrite(operations, { ordered: false });
    }
  }

  const persist = async () => {
    if (closed || remoteCleared) return;
    if (uploadInProgress) {
      uploadAgain = true;
      return uploadInProgress;
    }
    uploadInProgress = uploadLocalFiles()
      .catch((error) => {
        if (!closed && !remoteCleared) {
          console.error("[AUTH] MongoDB session backup failed:", explainMongoError(error));
        }
      })
      .finally(() => {
        uploadInProgress = null;
        if (uploadAgain && !closed && !remoteCleared) {
          uploadAgain = false;
          schedulePersist();
        }
      });
    return uploadInProgress;
  };

  const schedulePersist = () => {
    if (closed || remoteCleared) return;
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(() => { void persist(); }, 350);
    uploadTimer.unref?.();
  };

  async function clearRemoteFiles() {
    remoteCleared = true;
    clearTimeout(uploadTimer);
    uploadAgain = false;
    if (uploadInProgress) await uploadInProgress.catch(() => {});
    await collection.deleteMany({ bot: safeSessionKey });
  }

  async function close() {
    if (closed) return;
    closed = true;
    clearTimeout(uploadTimer);
    uploadAgain = false;
    if (uploadInProgress) await uploadInProgress.catch(() => {});
    await client.close().catch(() => {});
  }

  try {
    const remoteCount = await readRemoteFiles();
    const auth = await useMultiFileAuthState(directory);

    const saveCreds = async () => {
      if (closed || remoteCleared) return;
      await auth.saveCreds();
      schedulePersist();
    };

    if (!remoteCount) {
      await persist();
      console.log(`[AUTH] Initialized MongoDB-backed session: ${safeSessionKey}`);
    } else {
      console.log(`[AUTH] Restored ${remoteCount} session files from MongoDB: ${safeSessionKey}`);
    }

    return {
      state: auth.state,
      saveCreds,
      clearRemoteFiles,
      close,
      sessionKey: safeSessionKey,
    };
  } catch (error) {
    await close();
    throw new Error(`[AUTH] Persistent session initialization failed: ${explainMongoError(error)}`);
  }
}

module.exports = { createPersistentAuthState };
