// Claude Code と Codex のフック (ADR 0003 決定 2)。標準入力で 1 件受け、助言があれば JSON を 1 つ書く。
// 何が起きても終了コード 0 で、判定が出なければ何も書かない (fail open)。
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { advise, ask, type Verdict } from "../src/foreman.ts";
import { adviseAtEntry, diffFacts, entryOf } from "../src/milestone.ts";
import { buildState, modeOf, repoFacts } from "../src/state.ts";

type Saved = { verdict?: Verdict; seen: string[] };

const stateFile = (sid: string) => join(tmpdir(), "foreman", `${sid.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

function load(sid: string): Saved {
  try {
    return JSON.parse(readFileSync(stateFile(sid), "utf8"));
  } catch {
    return { seen: [] };
  }
}

function save(sid: string, s: Saved): void {
  mkdirSync(join(tmpdir(), "foreman"), { recursive: true });
  writeFileSync(stateFile(sid), JSON.stringify(s));
}

/** 見立ての数値だけを残す。依頼文も射影も残さない。 */
function log(entry: Record<string, unknown>): void {
  try {
    const dir = join(homedir(), ".local", "state", "foreman");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // ログが書けなくても助言は出す
  }
}

function emit(event: string, lines: string[]): void {
  if (!lines.length) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: lines.join("\n") } }),
  );
}

async function main(): Promise<void> {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const event = String(input.hook_event_name ?? "");
  const sid = String(input.session_id ?? "nosession");
  const cwd = String(input.cwd ?? process.cwd());

  if (event === "UserPromptSubmit") {
    const prompt = String(input.prompt ?? "").trim();
    if (!prompt) return;
    const facts = repoFacts(cwd);
    const mode = modeOf(facts);
    const state = buildState(prompt, facts, mode);
    if (!state) return;
    const verdict = await ask(state);
    if (!verdict) return;
    const saved = load(sid);
    save(sid, { ...saved, verdict });
    log({ event, mode, verdict });
    emit(event, [
      "着手前の見立て (助言であって指示ではない。合わないと思ったら従わなくてよい):",
      ...advise(verdict).map((l) => `- ${l}`),
    ]);
    return;
  }

  if (event === "PreToolUse") {
    const entry = entryOf(String(input.tool_name ?? ""), input.tool_input);
    if (!entry) return;
    const saved = load(sid);
    const seen = new Set(saved.seen);
    const lines = adviseAtEntry(entry, saved.verdict, diffFacts(cwd), seen);
    if (!lines.length) return;
    save(sid, { ...saved, seen: [...seen] });
    log({ event, entry, advised: lines.length });
    emit(event, lines);
  }
}

// process.exit は使わない。macOS ではパイプへの書き込みが非同期で、途中で切れる。
main().catch(() => {});
