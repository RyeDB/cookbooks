import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for the RyeChannel port of a RyeDB daemon, implementing only what the recipes use, per the public channel-port
// contract (https://github.com/RyeDB/SDK/blob/main/contracts/channel-port.openapi.json). It lets the recipes be tested without core.
// Behaviours that matter to the recipes: authenticated senders cannot post as someone else; a feed is messages addressed to the agent
// or to everyone, not its own; a task is done when it is receipted done or a result replies to it; the stream replays then goes live.
interface Msg { seq: number; channel: string; from_agent: string; to_agent: string | null; kind: string; body: string; reply_to: number | null; via: "port"; auth: 0 | 1; ts: number }

export async function fakeDaemon(agents: string[]) {
  const tokens = new Map(agents.map((a) => [`ryc_${a}`, a]));
  const log: Msg[] = [];
  const receipts: { seq: number; agent: string; state: string }[] = [];
  const listeners = new Set<{ agent: string; send: (m: Msg) => void }>();
  const forAgent = (m: Msg, agent: string) => m.from_agent !== agent && (m.to_agent === null || m.to_agent === agent);
  const json = (res: ServerResponse, code: number, v: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
  const body = (req: IncomingMessage) => new Promise<any>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b ? JSON.parse(b) : {})); });

  const server = createServer(async (req, res) => {
    const agent = tokens.get(String(req.headers["x-ryedb-agent-token"]));
    if (!agent) return json(res, 401, { error: "no credential" });
    const url = new URL(req.url!, "http://x");
    const after = Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0) || 0;
    if (url.pathname === "/channel/post") {
      const b = await body(req);
      if (b.from !== undefined && b.from !== agent) return json(res, 403, { error: "an authenticated agent cannot post as another" });
      const m: Msg = { seq: log.length + 1, channel: "main", from_agent: agent, to_agent: b.to ?? null, kind: b.kind ?? "note", body: b.body, reply_to: b.reply_to ?? null, via: "port", auth: 1, ts: Date.now() };
      log.push(m);
      for (const l of listeners) if (forAgent(m, l.agent)) l.send(m);
      return json(res, 200, m);
    }
    if (url.pathname === "/channel/read") return json(res, 200, log.filter((m) => m.seq > after && forAgent(m, agent)));
    if (url.pathname === "/channel/ack") {
      const b = await body(req);
      const seqs: number[] = (b.seqs ?? [b.seq]).filter((n: number) => log.some((m) => m.seq === n));
      for (const seq of seqs) receipts.push({ seq, agent, state: b.state ?? "received" });
      return json(res, 200, { acked: seqs, state: b.state ?? "received" });
    }
    if (url.pathname === "/channel/tasks") {
      const st = url.searchParams.get("state") ?? "open";
      const tasks = log.filter((m) => m.kind === "task" && (m.to_agent === agent || m.to_agent === null) && m.from_agent !== agent).map((m) => ({
        ...m,
        state: receipts.some((r) => r.seq === m.seq && r.agent === agent && r.state === "done") || log.some((x) => x.reply_to === m.seq && x.kind === "result") ? "done" : "open",
      }));
      return json(res, 200, tasks.filter((t) => st === "all" || t.state === st));
    }
    if (url.pathname === "/channel/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let sent = after;
      const send = (m: Msg) => { if (m.seq > sent) { sent = m.seq; res.write(`id: ${m.seq}\nevent: message\ndata: ${JSON.stringify(m)}\n\n`); } };
      const l = { agent, send };
      listeners.add(l);
      for (const m of log) if (forAgent(m, agent)) send(m);
      req.on("close", () => listeners.delete(l));
      return;
    }
    json(res, 404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    token: (agent: string) => `ryc_${agent}`,
    log,
    receipts,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
