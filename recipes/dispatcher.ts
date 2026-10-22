import { RyeChannel, type Message } from "@ryedb/sdk";

export interface Job {
  worker: string;
  body: string;
}
export interface Outcome {
  worker: string;
  body: string;
  /** The worker's answer, or undefined if none arrived before the deadline. */
  result?: string;
}

/**
 * Send one task to each worker and collect the answers. Results come back as `result` messages whose `reply_to` is the task, so
 * answers are matched to tasks, not to arrival order. Anything not answered by `timeoutMs` is returned without a result: a missing
 * answer is a fact to report, not an error to hide.
 */
export async function dispatch(ch: RyeChannel, jobs: Job[], o: { timeoutMs?: number } = {}): Promise<Outcome[]> {
  const sentJobs = new Map<number, Job>(); // task seq -> job
  const answers = new Map<number, string>(); // task seq -> answer; kept apart from sentJobs because an answer can beat the bookkeeping
  const ac = new AbortController();
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const timer = setTimeout(finish, o.timeoutMs ?? 30_000);
  const allAnswered = (): boolean => sentJobs.size === jobs.length && [...sentJobs.keys()].every((seq) => answers.has(seq));

  // Listen before sending. The stream replays from the start, so an answer that beats this loop to the channel is still seen.
  void (async () => {
    for await (const m of ch.stream({ signal: ac.signal })) {
      if (m.kind === "result" && m.reply_to !== null && !answers.has(m.reply_to)) answers.set(m.reply_to, m.body);
      if (allAnswered()) finish();
    }
  })().catch(finish);

  for (const j of jobs) {
    const sent: Message = await ch.post({ to: j.worker, kind: "task", body: j.body });
    sentJobs.set(sent.seq, j);
  }
  if (allAnswered()) finish();
  await done;
  clearTimeout(timer);
  ac.abort();
  return [...sentJobs].map(([seq, j]) => ({ worker: j.worker, body: j.body, result: answers.get(seq) }));
}
