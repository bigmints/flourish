import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const portFlag = process.argv.indexOf("--port");
const defaultPort = portFlag >= 0 ? process.argv[portFlag + 1] : "3210";
const port = process.env.PORT || defaultPort;

if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error(`Invalid port: ${port}`);
}

const child = spawn(
  process.execPath,
  [path.join(root, "node_modules", "next", "dist", "bin", "next"), "dev", "--hostname", "127.0.0.1", "--port", port],
  { cwd: root, env: process.env, stdio: "inherit" },
);

process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("error", (error) => {
  console.error(`Could not start Flourish: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
