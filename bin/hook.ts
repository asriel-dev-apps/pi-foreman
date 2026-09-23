// Claude Code と Codex のフック (ADR 0003 決定 2)。標準入力で 1 件受け、助言があれば JSON を 1 つ書く。
// 何が起きても終了コード 0 で、判定が出なければ何も書かない (fail open)。
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { advise, ask, type Verdict } from "../src/foreman.ts";
import { adviseAtEntry, diffFacts, entryOf, RISKY_PATH } from "../src/milestone.ts";
import { buildState, modeOf, repoFacts, rulesVerdict } from "../src/state.ts";

type Saved = { verdict?: Verdict };

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
const dir = () => join(tmpdir(), "foreman");
const stateFile = (sid: string) => join(dir(), `${safe(sid)}.json`);

/** 1 セッション 1 回の権利を取る。並行するフックどうしでも排他作成で 1 つだけが勝つ。 */
function claimer(sid: string): (key: string) => boolean {
  return (key) => {
    try {
      mkdirSync(dir(), { recursive: true });
      writeFileSync(join(dir(), `${safe(sid)}.${safe(key)}`), "", { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
}

function load(sid: string): Saved {
  try {
    return JSON.parse(readFileSync(stateFile(sid), "utf8"));
  } catch {
    return {};
  }
}

function save(sid: string, s: Saved): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(stateFile(sid), JSON.stringify(s));
}

/** 依頼文・射影・パスは残さない (ADR 0003 決定 6)。 */
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
  if (SHADOW || !lines.length) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: lines.join("\n") } }),
  );
}

// shadow: 判定はすべて行い、ログにだけ残して文脈には何も足さない (ADR 0003 決定 6)
const SHADOW = process.env.FOREMAN_SHADOW === "1";

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
    if (mode === "off") return;
    // 両方残すのは、Jev: full の repo で同じ依頼に対するルール表と jev を比べるため
    const rules = rulesVerdict(prompt);
    const jev = mode === "full" ? await ask(buildState(prompt, facts, "full")!) : null;
    const verdict = mode === "full" ? jev : rules;
    const lines = verdict
      ? ["着手前の見立て (助言であって指示ではない。合わないと思ったら従わなくてよい):", ...advise(verdict).map((l) => `- ${l}`)]
      : [];
    if (verdict) save(sid, { verdict });
    log({ event, session_id: sid, transcript_path: input.transcript_path ?? null, shadow: SHADOW, mode, rules, jev, advice: lines });
    emit(event, lines);
    return;
  }

  if (event === "PreToolUse") {
    const tool = String(input.tool_name ?? "");
    const entry = entryOf(tool, input.tool_input);
    if (!entry) return;
    const diff = diffFacts(cwd);
    const kinds: string[] = [];
    const claim = claimer(sid);
    const lines = adviseAtEntry(entry, load(sid).verdict, diff, (key) => {
      const ok = claim(key);
      if (ok) kinds.push(key === "risky" ? "risky" : "milestone");
      return ok;
    });
    // 助言の有無にかかわらず 1 行。パスは残さず件数だけ (助言の文面はパスを含むので種類だけ)
    log({
      event,
      session_id: sid,
      shadow: SHADOW,
      tool_name: tool,
      entry,
      diffLines: diff?.lines ?? null,
      riskyHits: diff ? diff.paths.filter((p) => RISKY_PATH.test(p)).length : 0,
      advice: kinds,
    });
    emit(event, lines);
  }
}

// process.exit は使わない。macOS ではパイプへの書き込みが非同期で、途中で切れる。
main().catch(() => {});
