const path = require("path");
const dotenv = require("dotenv");

const envPath = path.join(__dirname, ".env");

dotenv.config({
  path: envPath
});

module.exports = {
  nodeEnv: process.env.NODE_ENV || "production"
};

module.exports = { nodeEnv };
