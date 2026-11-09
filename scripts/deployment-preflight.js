const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const requiredFiles = ["index.js", "package.json", "package-lock.json", "Procfile", "mayel/persistentAuth.js"];
const requiredEnv = ["MONGODB_URI", "SESSION_GENERATOR_KEY", "BOT_ID", "OWNER_NUMBER"];
const errors = [];
const warnings = [];

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) errors.push(`Missing required file: ${file}`);
}

for (const name of requiredEnv) {
  if (!String(process.env[name] || "").trim()) errors.push(`Missing required environment variable: ${name}`);
}

if (process.env.RAILWAY_REPLICAS && Number(process.env.RAILWAY_REPLICAS) > 1) {
  errors.push("Use exactly one replica per WhatsApp account; multiple sockets can cause connectionReplaced (405).");
}
if (String(process.env.SERVERLESS || "").toLowerCase() === "true") {
  errors.push("Disable serverless/sleep mode for a WhatsApp worker.");
}
if (!String(process.env.MONGODB_URI || "").startsWith("mongodb")) {
  warnings.push("MONGODB_URI is not set to a MongoDB connection string; persistent authentication will not work.");
}
if (process.version.split(".")[0].replace("v", "") < 18) {
  errors.push(`Node.js ${process.version} is too old; use Node.js 18 or newer.`);
}

console.log("HAYWHY_MDX_BOT deployment preflight");
for (const warning of warnings) console.log(`WARN: ${warning}`);
for (const error of errors) console.log(`ERROR: ${error}`);
if (!errors.length) console.log("PASS: files and production persistence configuration look ready.");
process.exitCode = errors.length ? 1 : 0;
