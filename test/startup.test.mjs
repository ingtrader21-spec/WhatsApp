import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

test("documented node entrypoint starts a reachable server on Linux", async () => {
  const port = 18782;
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      WHATSAPP_PRODUCTION_SEND: "false",
      WHATSAPP_EXTERNAL_RECIPIENTS: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    let response;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (child.exitCode !== null) break;
      try {
        response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) break;
      } catch {}
      await sleep(100);
    }

    assert.equal(child.exitCode, null, stderr || "server exited before becoming reachable");
    assert.ok(response?.ok, stderr || "health endpoint did not become reachable");
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(body.command_authority, "middleware-v3");
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(1000)
    ]);
  }
});
