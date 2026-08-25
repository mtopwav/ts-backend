const path = require("path");
const dotenv = require("dotenv");

const envDir = __dirname;
const nodeEnv = process.env.NODE_ENV || "development";

if (nodeEnv === "production") {
  dotenv.config({ path: path.join(envDir, ".env") });
} else {
  // Local development — never load production .env
  dotenv.config({ path: path.join(envDir, ".env.development") });
  dotenv.config({ path: path.join(envDir, ".env.local"), override: true });
}

module.exports = { nodeEnv };
