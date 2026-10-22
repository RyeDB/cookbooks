import { RyeChannel } from "@ryedb/sdk";

/**
 * Tell the agents working on a project that CI changed state. Broadcast by default (everyone sees it at their next hook); pass `to`
 * to address one agent. The message carries what a person would want first: what happened, where, and a link.
 *
 *   RYEDB_ROOT=/path/to/project RYEDB_AGENT_TOKEN=ryc_... node recipes/ci-notifier.ts failed "unit tests" main abc1234 https://ci/run/9
 */
export async function notify(ch: RyeChannel, e: { state: "passed" | "failed"; what: string; branch: string; sha: string; url?: string; to?: string }): Promise<number> {
  const body = `CI ${e.state}: ${e.what} on ${e.branch} (${e.sha.slice(0, 7)})${e.url ? ` ${e.url}` : ""}`;
  const m = await ch.post({ body, to: e.to, kind: e.state === "failed" ? "request" : "note" });
  return m.seq;
}

if (import.meta.main) {
  const [state, what, branch, sha, url] = process.argv.slice(2);
  if ((state !== "passed" && state !== "failed") || !what || !branch || !sha) {
    console.error('usage: ci-notifier.ts passed|failed "<what>" <branch> <sha> [url]');
    process.exit(2);
  }
  const root = process.env.RYEDB_ROOT;
  if (!root) { console.error("set RYEDB_ROOT to the project directory"); process.exit(2); }
  const ch = await RyeChannel.fromProject(root, { agentToken: process.env.RYEDB_AGENT_TOKEN, agent: "ci" });
  console.log(`posted #${await notify(ch, { state, what, branch, sha, url })}`);
}
