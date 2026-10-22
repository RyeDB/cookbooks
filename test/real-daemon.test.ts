import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RyeChannel } from "@ryedb/sdk";
import { runWorker } from "../recipes/worker-loop.ts";
import { dispatch } from "../recipes/dispatcher.ts";

// Runs the recipes against a real RyeDB daemon when you have a built core checkout: RYEDB_CORE=/path/to/core npm test.
// Without it this test is skipped, and the stand-in daemon in fake-daemon.ts is what the other tests use.
const core = process.env.RYEDB_CORE;
test("the worker and dispatcher recipes work end to end against the real daemon", { skip: core ? false : "set RYEDB_CORE to a built core checkout" }, async () => {
  const { startDaemon } = (await import(join(core!, "packages/daemon/dist/index.js"))) as { startDaemon: (o: { root: string; idleMs: number }) => Promise<{ store: any; close(): Promise<void> }> };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ryedb-cookbook-")));
  const port = await new Promise<number>((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
  mkdirSync(join(root, ".ryedb"), { recursive: true });
  writeFileSync(join(root, ".ryedb", "config.json"), JSON.stringify({ httpPort: port }));
  writeFileSync(join(root, ".ryedb", "token"), "k".repeat(48));
  const d = await startDaemon({ root, idleMs: 60_000 });
  try {
    const as = (a: string) => new RyeChannel({ port, agentToken: d.store.issueCredential(a) });
    const ac = new AbortController();
    const w = runWorker(as("worker-1"), (t) => `ok: ${t.body}`, { signal: ac.signal });
    const out = await dispatch(as("lead"), [{ worker: "worker-1", body: "rebuild the index" }], { timeoutMs: 5000 });
    ac.abort();
    await w;
    assert.equal(out[0]!.result, "ok: rebuild the index");
  } finally {
    await d.close();
    rmSync(root, { recursive: true, force: true });
  }
});
