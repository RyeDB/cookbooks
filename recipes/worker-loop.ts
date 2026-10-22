import { RyeChannel, type Message, type Task } from "@ryedb/sdk";

export type Handler = (task: Message) => Promise<string> | string;

/**
 * Take tasks addressed to this agent and answer them. For each task: receipt it as received, run the handler, post the handler's
 * text as a `result` that replies to the task, then receipt it done. A handler that throws still gets a result (saying it failed),
 * so the sender is never left waiting on silence.
 *
 * Tasks that were already waiting when the worker started are picked up first (`tasks()`), then new ones arrive on the stream.
 * Each task is handled once, even if it shows up in both. Ends when `signal` aborts.
 */
export async function runWorker(ch: RyeChannel, handle: Handler, o: { signal?: AbortSignal } = {}): Promise<void> {
  const seen = new Set<number>();
  const work = async (t: Message): Promise<void> => {
    if (seen.has(t.seq)) return;
    seen.add(t.seq);
    await ch.ack(t.seq, { state: "received" });
    let text: string;
    try {
      text = await handle(t);
    } catch (e) {
      text = `failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    await ch.post({ to: t.from_agent, kind: "result", replyTo: t.seq, body: text });
    await ch.ack(t.seq, { state: "done" });
  };

  for (const t of (await ch.tasks()) as Task[]) await work(t);
  for await (const m of ch.stream({ signal: o.signal })) if (m.kind === "task") await work(m);
}
