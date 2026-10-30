// Starts the web app (port 3000) and the funnel tester (port 4000) together, so
// funnel tests work locally with one command: npm run dev:all
import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (name, args) => {
  const child = spawn(npm, args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  const prefix = (line) => line && console.log(`[${name}] ${line}`);
  child.stdout.on("data", (d) => String(d).split(/\r?\n/).forEach(prefix));
  child.stderr.on("data", (d) => String(d).split(/\r?\n/).forEach(prefix));
  child.on("exit", (code) => {
    console.log(`[${name}] stopped (exit ${code}) - stopping the other one too`);
    process.exit(code ?? 0);
  });
  return child;
};

const children = [run("app", ["run", "dev"]), run("tester", ["run", "tester"])];
process.on("SIGINT", () => children.forEach((c) => c.kill()));
