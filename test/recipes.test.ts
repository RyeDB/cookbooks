import { test } from "node:test";
import assert from "node:assert/strict";
import { RyeChannel } from "@ryedb/sdk";
import { runWorker } from "../recipes/worker-loop.ts";
import { dispatch } from "../recipes/dispatcher.ts";
import { notify } from "../recipes/ci-notifier.ts";
import { fakeDaemon } from "./fake-daemon.ts";

const as = (d: { port: number; token(a: string): string }, agent: string) => new RyeChannel({ port: d.port, agentToken: d.token(agent) });

test("worker-loop: answers a task that was already waiting and one that arrives later, each exactly once, and receipts both", async () => {
  const d = await fakeDaemon(["lead", "worker-1"]);
  try {
    const lead = as(d, "lead");
    const first = await lead.post({ to: "worker-1", kind: "task", body: "rebuild the index" });
    const ac = new AbortController();
    const handled: string[] = [];
    const w = runWorker(as(d, "worker-1"), (t) => { handled.push(t.body); return `done: ${t.body}`; }, { signal: ac.signal });
    const second = await lead.post({ to: "worker-1", kind: "task", body: "clear the cache" });
    for (let i = 0; i < 200 && d.log.filter((m) => m.kind === "result").length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await w;
    assert.deepEqual(handled.sort(), ["clear the cache", "rebuild the index"]);
    const results = d.log.filter((m) => m.kind === "result");
    assert.deepEqual(results.map((m) => [m.reply_to, m.body]).sort(), [[first.seq, "done: rebuild the index"], [second.seq, "done: clear the cache"]].sort());
    assert.deepEqual(d.receipts.filter((r) => r.seq === first.seq).map((r) => r.state).sort(), ["done", "received"]);
    assert.equal((await as(d, "worker-1").tasks()).length, 0, "no task is left open");
  } finally { await d.close(); }
});

test("worker-loop: a handler that throws still answers, saying it failed", async () => {
  const d = await fakeDaemon(["lead", "worker-1"]);
  try {
    const t = await as(d, "lead").post({ to: "worker-1", kind: "task", body: "explode" });
    const ac = new AbortController();
    const w = runWorker(as(d, "worker-1"), () => { throw new Error("disk full"); }, { signal: ac.signal });
    for (let i = 0; i < 200 && !d.log.some((m) => m.kind === "result"); i++) await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await w;
    const r = d.log.find((m) => m.kind === "result")!;
    assert.equal(r.reply_to, t.seq);
    assert.equal(r.body, "failed: disk full");
  } finally { await d.close(); }
});

test("dispatcher: sends one task per worker, matches answers to tasks not to arrival order, and reports a missing answer", async () => {
  const d = await fakeDaemon(["lead", "a", "b", "c"]);
  try {
    const ac = new AbortController();
    // a answers slowly, b quickly, c never: the outcome must follow the jobs, not the arrival order.
    const wa = runWorker(as(d, "a"), async (t) => { await new Promise((r) => setTimeout(r, 120)); return "A:" + t.body; }, { signal: ac.signal });
    const wb = runWorker(as(d, "b"), (t) => "B:" + t.body, { signal: ac.signal });
    const out = await dispatch(as(d, "lead"), [{ worker: "a", body: "x" }, { worker: "b", body: "y" }, { worker: "c", body: "z" }], { timeoutMs: 800 });
    ac.abort();
    await Promise.all([wa, wb]);
    assert.deepEqual(out.map((o) => [o.worker, o.result]), [["a", "A:x"], ["b", "B:y"], ["c", undefined]]);
  } finally { await d.close(); }
});

test("dispatcher: finishes as soon as everything is answered, without waiting for the deadline", async () => {
  const d = await fakeDaemon(["lead", "a"]);
  try {
    const ac = new AbortController();
    const wa = runWorker(as(d, "a"), (t) => t.body.toUpperCase(), { signal: ac.signal });
    const t0 = Date.now();
    const out = await dispatch(as(d, "lead"), [{ worker: "a", body: "ping" }], { timeoutMs: 5000 });
    ac.abort();
    await wa;
    assert.equal(out[0]!.result, "PING");
    assert.ok(Date.now() - t0 < 2000, "returned early");
  } finally { await d.close(); }
});

test("ci-notifier: a failure is a request, a pass is a note; the message says what, where and a link; it cannot be posted as another agent", async () => {
  const d = await fakeDaemon(["ci"]);
  try {
    const ch = as(d, "ci");
    await notify(ch, { state: "failed", what: "unit tests", branch: "main", sha: "abc1234def", url: "https://ci/run/9" });
    await notify(ch, { state: "passed", what: "unit tests", branch: "main", sha: "abc1234def" });
    assert.deepEqual(d.log.map((m) => [m.kind, m.from_agent, m.to_agent]), [["request", "ci", null], ["note", "ci", null]]);
    assert.equal(d.log[0]!.body, "CI failed: unit tests on main (abc1234) https://ci/run/9");
    assert.equal(d.log[1]!.body, "CI passed: unit tests on main (abc1234)");
  } finally { await d.close(); }
});
