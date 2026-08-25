const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

const envDir = __dirname;
const prodPath = path.join(envDir, ".env");
const devPath = path.join(envDir, ".env.development");
const localPath = path.join(envDir, ".env.local");

// Shell/pm2 NODE_ENV wins. If unset and .env exists (typical on VPS), use production.
const explicitEnv = process.env.NODE_ENV;
const useProduction =
  explicitEnv === "production" ||
  (!explicitEnv && fs.existsSync(prodPath));

if (useProduction) {
  dotenv.config({ path: prodPath });
} else {
  dotenv.config({ path: devPath });
  dotenv.config({ path: localPath, override: true });
}

const nodeEnv =
  process.env.NODE_ENV || (useProduction ? "production" : "development");

module.exports = { nodeEnv };
