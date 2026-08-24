/**
 * Free a TCP port before starting the dev server (Windows-friendly).
 * Usage: node scripts/kill-port.js 5000
 */
const { execSync } = require("child_process");

const port = process.argv[2] || "5000";
const isWin = process.platform === "win32";

try {
  if (isWin) {
    const out = execSync(`netstat -ano | findstr ":${port}"`, { encoding: "utf8" });
    const pids = new Set();
    out.split("\n").forEach((line) => {
      if (!line.includes(`:${port}`)) return;
      const match = line.match(/LISTENING\s+(\d+)\s*$/);
      if (match && match[1] !== "0") pids.add(match[1]);
    });
    if (pids.size === 0) {
      console.log(`Port ${port} is free.`);
      process.exit(0);
    }
    pids.forEach((pid) => {
      execSync(`taskkill /PID ${pid} /F`, { stdio: "inherit" });
      console.log(`Stopped process ${pid} on port ${port}`);
    });
  } else {
    execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: "inherit", shell: true });
    console.log(`Freed port ${port}`);
  }
} catch {
  console.log(`Port ${port} is free (no listener found).`);
}
