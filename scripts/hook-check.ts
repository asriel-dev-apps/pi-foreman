// node scripts/hook-check.ts — ADR 0003 の受け入れテスト: `node bin/hook.ts` の入出力。
// bin/hook.ts はまだ無い。すべて赤で正常 (未実装)。ネットワークには出ない
// (FOREMAN_ENDPOINT をローカルのスタブに向ける)。
import assert from "node:assert";
import { spawn, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOK_PATH = join(REPO_ROOT, "bin/hook.ts");

// 依頼文の中身が外に出ていないことを確かめるための固有トークン。
// 英数字のみ (JSON の \u エスケープでの取りこぼしを避ける)。
const PROMPT_TOKEN = "Zanzibarpalace1234";
const PROMPT = `${PROMPT_TOKEN} の画面を直して。ユーザーが困っている。`;
// リポジトリ名も送信本文に出てはいけない (射影はリポジトリ名もパスも入れない)。
// 汎用的な "repo" ではなく固有の名前にしないと、既存の repoSummary() 実装のような
// "repository: <basename>" 混入を見逃す。
const REPO_NAME_TOKEN = "OkapiFoundryRepo7";

// ---- ちいさなテストランナー ----------------------------------------------
type Case = { name: string; fn: () => void | Promise<void> };
const cases: Case[] = [];
function check(name: string, fn: Case["fn"]) {
  cases.push({ name, fn });
}

// ---- スタブサーバ ---------------------------------------------------------
type StubResponder = (body: string, callIndex: number) => { status: number; body: string };

async function startStub(respond: StubResponder) {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      requests.push(data);
      const { status, body } = respond(data, requests.length);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub: no port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function jevBody(v: {
  size?: number;
  risky?: number;
  visual?: number;
  delegable?: number;
  parallel?: number;
  kind?: string;
  confidence?: number;
}): string {
  return JSON.stringify({
    answers: {
      size: { score: v.size ?? 0.1 },
      risky: { noul: v.risky ?? 0.1 },
      visual: { noul: v.visual ?? 0.1 },
      delegable: { noul: v.delegable ?? 0.5 },
      parallel: { noul: v.parallel ?? 0.1 },
      kind: { choice: v.kind ?? "other", confidence: v.confidence ?? 0.9 },
    },
  });
}

function ok200(body: string) {
  return { status: 200, body };
}

// ---- 使い捨て git リポジトリ ----------------------------------------------
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  return execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function initRepo(dir: string, env: NodeJS.ProcessEnv) {
  git(dir, ["init", "-q", "-b", "main"], env);
  git(dir, ["config", "user.email", "test@example.com"], env);
  git(dir, ["config", "user.name", "Test"], env);
}

function commitAll(dir: string, env: NodeJS.ProcessEnv, msg: string) {
  git(dir, ["add", "-A"], env);
  git(dir, ["commit", "-q", "-m", msg], env);
}

function nLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";
}

// ---- ケースごとの隔離された環境 --------------------------------------------
type Scenario = {
  repoDir: string;
  homeDir: string;
  tmpDir: string;
  env: NodeJS.ProcessEnv;
};

function freshScenario(endpoint: string, opts: { apiKey?: string | null; repoDirName?: string } = {}): Scenario {
  const base = mkdtempSync(join(tmpdir(), "pf-scn-"));
  const repoDir = join(base, opts.repoDirName ?? "repo");
  const homeDir = join(base, "home");
  const tmpDir = join(base, "tmp");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: homeDir,
    TMPDIR: tmpDir,
    FOREMAN_ENDPOINT: endpoint,
  };
  const apiKey = opts.apiKey === undefined ? "dummy-typesafe-key" : opts.apiKey;
  if (apiKey) env.TYPESAFE_API_KEY = apiKey;
  return { repoDir, homeDir, tmpDir, env };
}

function writeAgents(scn: Scenario, content: string) {
  writeFileSync(join(scn.repoDir, "AGENTS.md"), content);
}

/** 射影であることの確認: 依頼文の全文・リポジトリ名・cwd のパスがどれも送信本文に無い。 */
function assertProjectedOnly(requests: string[], scn: Scenario, note: string) {
  for (const body of requests) {
    assert.doesNotMatch(body, new RegExp(PROMPT_TOKEN), `${note}: 依頼文の全文が送信本文に含まれている (射影されていない)`);
    assert.doesNotMatch(body, new RegExp(REPO_NAME_TOKEN), `${note}: リポジトリ名が送信本文に含まれている`);
    assert.ok(!body.includes(scn.repoDir), `${note}: cwd のパスが送信本文に含まれている`);
  }
}

// ---- フックの起動 ----------------------------------------------------------
type HookResult = { stdout: string; stderr: string; code: number | null };

function runHook(cwd: string, env: NodeJS.ProcessEnv, stdin: string): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`hook timed out (10s). stderr so far: ${stderr.slice(0, 500)}`));
    }, 10_000);
    child.on("error", (e) => {
      clearTimeout(killer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(stdin);
  });
}

function hookInput(o: Record<string, unknown>): string {
  return JSON.stringify(o);
}

function userPromptSubmit(sessionId: string, cwd: string, prompt = PROMPT, opts: { transcriptPath?: string } = {}) {
  const o: Record<string, unknown> = { hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd, prompt };
  if (opts.transcriptPath !== undefined) o.transcript_path = opts.transcriptPath;
  return hookInput(o);
}

function preToolUse(sessionId: string, cwd: string, toolName: string, toolInput: unknown) {
  return hookInput({ hook_event_name: "PreToolUse", session_id: sessionId, cwd, tool_name: toolName, tool_input: toolInput });
}

function assertExitOk(r: HookResult, note: string) {
  assert.equal(r.code, 0, `${note}: 終了コードは常に 0 のはず。stderr: ${r.stderr.slice(0, 300)}`);
}

function assertNoStdout(r: HookResult, note: string) {
  assert.equal(r.stdout.trim(), "", `${note}: 標準出力は空のはず。got: ${r.stdout.slice(0, 300)}`);
}

// ---- shadow モード (決定6) のためのヘルパー ---------------------------------

/** ログには依頼文・射影・パスを残さないはず。 */
function withShadow(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, FOREMAN_SHADOW: "1" };
}

function logPath(scn: Scenario): string {
  return join(scn.homeDir, ".local", "state", "foreman", "log.jsonl");
}

/** ログの生テキスト。ファイルが無ければ空文字列。 */
function readLogRaw(scn: Scenario): string {
  try {
    return readFileSync(logPath(scn), "utf8");
  } catch {
    return "";
  }
}

/** ログを 1 行 1 JSON としてパースした配列。ファイルが無ければ空配列。 */
function readLogLines(scn: Scenario): any[] {
  const raw = readLogRaw(scn);
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function shadowScenarioWithLightVerdict(sessionId: string) {
  const stub = await startStub(() => ok200(jevBody({ size: 0, risky: 0.05 })));
  const scn = freshScenario(stub.url);
  scn.env = withShadow(scn.env);
  initRepo(scn.repoDir, scn.env);
  writeAgents(scn, "Jev: full\n");
  commitAll(scn.repoDir, scn.env, "init");
  const pre = await runHook(scn.repoDir, scn.env, userPromptSubmit(sessionId, scn.repoDir));
  assertExitOk(pre, `準備 shadow UserPromptSubmit (${sessionId})`);
  await stub.close();
  return scn;
}

async function shadowScenarioWithVerdictAndDiff(
  sessionId: string,
  verdict: { size: number; risky: number },
  addedLines: number,
  extraFile?: string,
) {
  const stub = await startStub(() => ok200(jevBody(verdict)));
  const scn = freshScenario(stub.url);
  scn.env = withShadow(scn.env);
  initRepo(scn.repoDir, scn.env);
  writeAgents(scn, "Jev: full\n");
  writeFileSync(join(scn.repoDir, "base.txt"), "base\n");
  commitAll(scn.repoDir, scn.env, "init on main");
  git(scn.repoDir, ["checkout", "-q", "-b", "feature"], scn.env);
  writeFileSync(join(scn.repoDir, "src.txt"), nLines(addedLines));
  if (extraFile) {
    mkdirSync(join(scn.repoDir, extraFile.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(scn.repoDir, extraFile), "-- risky change --\n");
  }
  commitAll(scn.repoDir, scn.env, "diff on feature");
  const pre = await runHook(scn.repoDir, scn.env, userPromptSubmit(sessionId, scn.repoDir));
  assertExitOk(pre, `準備 shadow UserPromptSubmit (${sessionId})`);
  await stub.close();
  return scn;
}

function parseAdvice(r: HookResult, note: string): { hookSpecificOutput: { hookEventName: string; additionalContext: string } } {
  let parsed: any;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`${note}: 標準出力が JSON でパースできない。got: ${r.stdout.slice(0, 300)}`);
  }
  assert.ok(parsed.hookSpecificOutput, `${note}: hookSpecificOutput が無い`);
  assert.ok(typeof parsed.hookSpecificOutput.additionalContext === "string", `${note}: additionalContext が無い`);
  return parsed;
}

// ===========================================================================
// 1. 送る内容の既定: AGENTS.md の Jev: 行で決まる (無い/git外なら射影、依頼文の全文は出ない)
// ===========================================================================

check("Jev 行が無いリポジトリでは依頼文もリポジトリ名もパスも送られない (射影される)", async () => {
  const stub = await startStub(() => ok200(jevBody({})));
  const scn = freshScenario(stub.url, { repoDirName: REPO_NAME_TOKEN });
  initRepo(scn.repoDir, scn.env);
  writeFileSync(join(scn.repoDir, "README.md"), "hello\n");
  commitAll(scn.repoDir, scn.env, "init");
  // AGENTS.md 無し、または Jev 行が無い状態。
  const r = await runHook(scn.repoDir, scn.env, userPromptSubmit("s-noline", scn.repoDir));
  assertExitOk(r, "Jev 行なし");
  assertProjectedOnly(stub.requests, scn, "Jev 行なし");
  await stub.close();
});

check("Jev 行が無いリポジトリでは、スタブへの送信が一度も起きない (決定4・5の結果: 既定はルール表で判定しどこにも送らない)", async () => {
  const stub = await startStub(() => ok200(jevBody({})));
  const scn = freshScenario(stub.url);
  initRepo(scn.repoDir, scn.env);
  writeFileSync(join(scn.repoDir, "README.md"), "hello\n");
  commitAll(scn.repoDir, scn.env, "init"); // AGENTS.md 無し、または Jev 行が無い状態
  const r = await runHook(scn.repoDir, scn.env, userPromptSubmit("s-noline-zero", scn.repoDir));
  assertExitOk(r, "Jev 行なし/ゼロ送信");
  assert.equal(stub.requests.length, 0, "Jev 行が無いのにスタブへ送信が起きた (決定5の結果に反する)");
  await stub.close();
});

check("Jev 行が無いリポジトリでも、送信ゼロのまま UserPromptSubmit の助言 (ルール表由来) は出る", async () => {
  const stub = await startStub(() => ok200(jevBody({})));
  const scn = freshScenario(stub.url);
  initRepo(scn.repoDir, scn.env);
  writeFileSync(join(scn.repoDir, "README.md"), "hello\n");
  commitAll(scn.repoDir, scn.env, "init"); // Jev 行なし
  const prompt = "この関数は何をしていますか？";
  const r = await runHook(scn.repoDir, scn.env, userPromptSubmit("s-rules-light", scn.repoDir, prompt));
  assertExitOk(r, "ルール表/軽い質問");
  assert.equal(stub.requests.length, 0, "ルール表判定のはずがスタブへ送信が起きた");
  // 「軽いタスク」の判定そのもの (rulesVerdict の語彙・閾値) は ADR が固定していないので断定しない。
  // 助言そのものは UserPromptSubmit の判定点1が必ず返す (決定2)。
  parseAdvice(r, "ルール表/軽い質問");
  await stub.close();
});

check("Jev: full では依頼文の全文が送られる (対照実験・スタブの疎通確認)", async () => {
  const stub = await startStub(() => ok200(jevBody({})));
  const scn = freshScenario(stub.url);
  initRepo(scn.repoDir, scn.env);
  writeAgents(scn, "Jev: full\n");
  commitAll(scn.repoDir, scn.env, "init");
  const r = await runHook(scn.repoDir, scn.env, userPromptSubmit("s-full", scn.repoDir));
  assertExitOk(r, "Jev: full");
  assert.ok(stub.requests.length >= 1, "Jev: full なのに送信が一度も起きなかった");
  assert.ok(
    stub.requests.some((b) => b.includes(PROMPT_TOKEN)),
    "Jev: full なのに依頼文の全文が送信本文に含まれていない",
  );
  await stub.close();
});

check("Jev: off では送信が一切起きず、軽いタスクの助言も出ない", async () => {
  const stub = await startStub(() => ok200(jevBody({})));
  const scn = freshScenario(stub.url);
  initRepo(scn.repoDir, scn.env);
  writeAgents(scn, "Jev: off\n");
  commitAll(scn.repoDir, scn.env, "init");
  const r = await runHook(scn.repoDir, scn.env, userPromptSubmit("s-off", scn.repoDir));
  assertExitOk(r, "Jev: off");
  assertNoStdout(r, "Jev: off");
  assert.equal(stub.requests.length, 0, "Jev: off なのにスタブへ送信が起きた");
  await stub.close();
});

check("git リポジトリの外では Jev: full と書いてあっても射影になる", async () => {
  const stub = await startStub(() => ok200(jevBody({})));
  const scn = freshScenario(stub.url, { repoDirName: REPO_NAME_TOKEN });
  // repoDir を git init しない。pi-foreman 自身の下にも置かない (mkdtemp は os.tmpdir() 直下)。
  writeAgents(scn, "Jev: full\n");
  const r = await runHook(scn.repoDir, scn.env, userPromptSubmit("s-nogit", scn.repoDir));
  assertExitOk(r, "git 外");
  assertProjectedOnly(stub.requests, scn, "git 外");
  await stub.close();
});

check("git リポジトリの外では Jev: full と書いてあってもスタブへの送信が一度も起きない (決定4・5の結果)", async () => {
  const stub = await startStub(() => ok200(jevBody({})));
  const scn = freshScenario(stub.url, { repoDirName: REPO_NAME_TOKEN });
  writeAgents(scn, "Jev: full\n");
  const r = await runHook(scn.repoDir, scn.env, userPromptSubmit("s-nogit-zero", scn.repoDir));
  assertExitOk(r, "git 外/ゼロ送信");
  assert.equal(stub.requests.length, 0, "git の外なのにスタブへ送信が起きた (決定5の結果に反する)");
  await stub.close();
});

// ===========================================================================
// 2. 軽いタスクの見立て
// ===========================================================================

check("軽いタスクの見立てには「軽いタスク」を含む助言が UserPromptSubmit で返る", async () => {
  const stub = await startStub(() => ok200(jevBody({ size: 0, risky: 0.05 })));
  const scn = freshScenario(stub.url);
  initRepo(scn.repoDir, scn.env);
  writeAgents(scn, "Jev: full\n");
  commitAll(scn.repoDir, scn.env, "init");
  const r = await runHook(scn.repoDir, scn.env, userPromptSubmit("s-light", scn.repoDir));
  assertExitOk(r, "軽いタスク");
  const parsed = parseAdvice(r, "軽いタスク");
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(parsed.hookSpecificOutput.additionalContext, /軽いタスク/);
  await stub.close();
});

check("size がちょうど 0.5 では「軽いタスク」にならない (境界, size < 0.5 かつ risky < 0.3)", async () => {
  const stub = await startStub(() => ok200(jevBody({ size: 0.5, risky: 0.05 })));
  const scn = freshScenario(stub.url);
  initRepo(scn.repoDir, scn.env);
  writeAgents(scn, "Jev: full\n");
  commitAll(scn.repoDir, scn.env, "init");
  const r = await runHook(scn.repoDir, scn.env, userPromptSubmit("s-boundary", scn.repoDir));
  assertExitOk(r, "size=0.5 境界");
  if (r.stdout.trim()) {
    const parsed = parseAdvice(r, "size=0.5 境界");
    assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /軽いタスク/);
  }
  await stub.close();
});

// ===========================================================================
// 3. fail open: 判定が得られない異常系ではエージェントを止めない
// ===========================================================================

check("スタブが 500 を返すと fail open (標準出力なし・終了コード0) — 決定5", async () => {
  const stub = await startStub(() => ({ status: 500, body: "error" }));
  const scn = freshScenario(stub.url);
  initRepo(scn.repoDir, scn.env);
  writeAgents(scn, "Jev: full\n");
  commitAll(scn.repoDir, scn.env, "init");
  const r = await runHook(scn.repoDir, scn.env, userPromptSubmit("s-500", scn.repoDir));
  assertExitOk(r, "500");
  assertNoStdout(r, "500");
  await stub.close();
});

check("スタブが壊れた JSON を返すと fail open — 決定5", async () => {
  const stub = await startStub(() => ({ status: 200, body: "{not json" }));
  const scn = freshScenario(stub.url);
  initRepo(scn.repoDir, scn.env);
  writeAgents(scn, "Jev: full\n");
  commitAll(scn.repoDir, scn.env, "init");
  const r = await runHook(scn.repoDir, scn.env, userPromptSubmit("s-badjson", scn.repoDir));
  assertExitOk(r, "壊れたJSON");
  assertNoStdout(r, "壊れたJSON");
  await stub.close();
});

check("スタブの応答に必須フィールド (kind) が欠けていると fail open (欠けたり範囲外の値は判定なしとして扱う)", async () => {
  const stub = await startStub(() =>
    ok200(JSON.stringify({ answers: { size: { score: 1 }, risky: { noul: 0.1 }, visual: { noul: 0.1 }, delegable: { noul: 0.5 }, parallel: { noul: 0.1 } } })),
  );
  const scn = freshScenario(stub.url);
  initRepo(scn.repoDir, scn.env);
  writeAgents(scn, "Jev: full\n");
  commitAll(scn.repoDir, scn.env, "init");
  const r = await runHook(scn.repoDir, scn.env, userPromptSubmit("s-missing", scn.repoDir));
  assertExitOk(r, "kind欠落");
  assertNoStdout(r, "kind欠落");
  await stub.close();
});

check("スタブの応答に parallel が欠けていると fail open (欠けたり範囲外の値は判定なしとして扱う)", async () => {
  const stub = await startStub(() =>
    ok200(JSON.stringify({ answers: { size: { score: 1 }, risky: { noul: 0.1 }, visual: { noul: 0.1 }, delegable: { noul: 0.5 }, kind: { choice: "other", confidence: 0.9 } } })),
  );
  const scn = freshScenario(stub.url);
  initRepo(scn.repoDir, scn.env);
  writeAgents(scn, "Jev: full\n");
  commitAll(scn.repoDir, scn.env, "init");
  const r = await runHook(scn.repoDir, scn.env, userPromptSubmit("s-missing-parallel", scn.repoDir));
  assertExitOk(r, "parallel欠落");
  assertNoStdout(r, "parallel欠落");
  await stub.close();
});

check("スタブの応答が範囲外の値 (risky > 1) だと fail open (欠けたり範囲外の値は判定なしとして扱う)", async () => {
  const stub = await startStub(() => ok200(jevBody({ risky: 1.2 })));
  const scn = freshScenario(stub.url);
  initRepo(scn.repoDir, scn.env);
  writeAgents(scn, "Jev: full\n");
  commitAll(scn.repoDir, scn.env, "init");
  const r = await runHook(scn.repoDir, scn.env, userPromptSubmit("s-outofrange", scn.repoDir));
  assertExitOk(r, "範囲外");
  assertNoStdout(r, "範囲外");
  await stub.close();
});

check("TYPESAFE_API_KEY が無いと送信せず fail open — ADR 0001 ask()", async () => {
  const stub = await startStub(() => ok200(jevBody({})));
  const scn = freshScenario(stub.url, { apiKey: null });
  initRepo(scn.repoDir, scn.env);
  writeAgents(scn, "Jev: full\n");
  commitAll(scn.repoDir, scn.env, "init");
  const r = await runHook(scn.repoDir, scn.env, userPromptSubmit("s-nokey", scn.repoDir));
  assertExitOk(r, "APIキー無し");
  assertNoStdout(r, "APIキー無し");
  assert.equal(stub.requests.length, 0, "APIキー無しなのに送信が起きた");
  await stub.close();
});

check("壊れた標準入力は fail open (標準出力なし・終了コード0)", async () => {
  const stub = await startStub(() => ok200(jevBody({})));
  const scn = freshScenario(stub.url);
  initRepo(scn.repoDir, scn.env);
  writeAgents(scn, "Jev: full\n");
  commitAll(scn.repoDir, scn.env, "init");
  const r = await runHook(scn.repoDir, scn.env, "not json at all {{{");
  assertExitOk(r, "壊れた標準入力");
  assertNoStdout(r, "壊れた標準入力");
  await stub.close();
});

// ===========================================================================
// helpers for PreToolUse scenarios (判定点3・4)
// ===========================================================================

async function scenarioWithLightVerdict(sessionId: string) {
  const stub = await startStub(() => ok200(jevBody({ size: 0, risky: 0.05 })));
  const scn = freshScenario(stub.url);
  initRepo(scn.repoDir, scn.env);
  writeAgents(scn, "Jev: full\n");
  commitAll(scn.repoDir, scn.env, "init");
  const pre = await runHook(scn.repoDir, scn.env, userPromptSubmit(sessionId, scn.repoDir));
  assertExitOk(pre, `準備 UserPromptSubmit (${sessionId})`);
  await stub.close();
  return scn;
}

/**
 * main に基点コミットを作り、feature ブランチを切って、その上に差分をコミットする。
 * (main のまま変更をコミットすると merge-base が HEAD になり差分 0 に潰れるため。)
 * extraFile を渡すとその1件も同じコミットに含める (危険パスのテスト用)。
 */
async function scenarioWithVerdictAndDiff(sessionId: string, verdict: { size: number; risky: number }, addedLines: number, extraFile?: string) {
  const stub = await startStub(() => ok200(jevBody(verdict)));
  const scn = freshScenario(stub.url);
  initRepo(scn.repoDir, scn.env);
  writeAgents(scn, "Jev: full\n");
  writeFileSync(join(scn.repoDir, "base.txt"), "base\n");
  commitAll(scn.repoDir, scn.env, "init on main");
  git(scn.repoDir, ["checkout", "-q", "-b", "feature"], scn.env);
  // 差分を作る (基点からの追加行のみ、削除は無し)。feature ブランチにコミットする。
  writeFileSync(join(scn.repoDir, "src.txt"), nLines(addedLines));
  if (extraFile) {
    mkdirSync(join(scn.repoDir, extraFile.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(scn.repoDir, extraFile), "-- risky change --\n");
  }
  commitAll(scn.repoDir, scn.env, "diff on feature");
  const pre = await runHook(scn.repoDir, scn.env, userPromptSubmit(sessionId, scn.repoDir));
  assertExitOk(pre, `準備 UserPromptSubmit (${sessionId})`);
  await stub.close();
  return scn;
}

// ===========================================================================
// 4. PreToolUse: rv (独立レビュー) の入口
// ===========================================================================

check("rv 入口 (Skill review) で軽いタスクなら「マイルストーン」の助言が出る", async () => {
  const sessionId = "s-rv-skill";
  const scn = await scenarioWithLightVerdict(sessionId);
  const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Skill", { skill: "review" }));
  assertExitOk(r, "rv/Skill");
  const parsed = parseAdvice(r, "rv/Skill");
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(parsed.hookSpecificOutput.additionalContext, /マイルストーン/);
});

check("rv 入口 (Bash で rv-brief を含むコマンド) で「マイルストーン」の助言が出る", async () => {
  const sessionId = "s-rv-bash";
  const scn = await scenarioWithLightVerdict(sessionId);
  const command = `codex --search exec --json "$(cat ~/dev-docs/x/rv-brief.md)"`;
  const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Bash", { command }));
  assertExitOk(r, "rv/Bash");
  const parsed = parseAdvice(r, "rv/Bash");
  assert.match(parsed.hookSpecificOutput.additionalContext, /マイルストーン/);
});

check("rv 入口 (herdr pane run 経由の rv-brief) で「マイルストーン」の助言が出る  (herdr 経由も含む)", async () => {
  const sessionId = "s-rv-herdr";
  const scn = await scenarioWithLightVerdict(sessionId);
  const inner = `codex --search exec --json "$(cat ~/dev-docs/x/rv-brief.md)"`;
  const command = `herdr pane run w1:p2 "${inner.replace(/"/g, '\\"')}"`;
  const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Bash", { command }));
  assertExitOk(r, "rv/herdr");
  const parsed = parseAdvice(r, "rv/herdr");
  assert.match(parsed.hookSpecificOutput.additionalContext, /マイルストーン/);
});

// ===========================================================================
// 5. PreToolUse: HTML 進捗レポートの入口
// ===========================================================================

check("HTML 入口 (Write で reports/…/index.html) で「マイルストーン」の助言が出る", async () => {
  const sessionId = "s-html-write";
  const scn = await scenarioWithLightVerdict(sessionId);
  const filePath = join("project-docs", "p", "reports", "2026-09-23-x", "index.html");
  const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Write", { file_path: filePath, content: "<html></html>" }));
  assertExitOk(r, "HTML/Write");
  const parsed = parseAdvice(r, "HTML/Write");
  assert.match(parsed.hookSpecificOutput.additionalContext, /マイルストーン/);
});

check("HTML 入口 (Codex apply_patch で reports/….html を追加) で「マイルストーン」の助言が出る", async () => {
  const sessionId = "s-html-applypatch";
  const scn = await scenarioWithLightVerdict(sessionId);
  const patch = "*** Begin Patch\n*** Add File: project-docs/p/reports/a/index.html\n+<html></html>\n*** End Patch";
  const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "apply_patch", { command: patch }));
  assertExitOk(r, "HTML/apply_patch");
  const parsed = parseAdvice(r, "HTML/apply_patch");
  assert.match(parsed.hookSpecificOutput.additionalContext, /マイルストーン/);
});

check("HTML 入口 (Bash のヒアドキュメントで reports/*.html) で「マイルストーン」の助言が出る", async () => {
  const sessionId = "s-html-heredoc";
  const scn = await scenarioWithLightVerdict(sessionId);
  const command = "cat > reports/a.html <<EOF\n<html></html>\nEOF";
  const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Bash", { command }));
  assertExitOk(r, "HTML/heredoc");
  const parsed = parseAdvice(r, "HTML/heredoc");
  assert.match(parsed.hookSpecificOutput.additionalContext, /マイルストーン/);
});

check("HTML 入口 (reporter エージェント) で「マイルストーン」の助言が出る", async () => {
  const sessionId = "s-html-agent";
  const scn = await scenarioWithLightVerdict(sessionId);
  const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Agent", { subagent_type: "reporter", prompt: "write the report" }));
  assertExitOk(r, "HTML/reporter");
  const parsed = parseAdvice(r, "HTML/reporter");
  assert.match(parsed.hookSpecificOutput.additionalContext, /マイルストーン/);
});

// ===========================================================================
// 6. 同じ助言は 1 セッションにつき種類ごとに 1 回までしか出ない
// ===========================================================================

check("同じセッションで rv 入口を2回踏んでも、2回目は助言が繰り返されない", async () => {
  const sessionId = "s-once";
  const scn = await scenarioWithLightVerdict(sessionId);
  const first = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Skill", { skill: "review" }));
  assertExitOk(first, "1回目");
  parseAdvice(first, "1回目"); // 1回目は出るはず (前提)

  const second = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Skill", { skill: "review" }));
  assertExitOk(second, "2回目");
  assertNoStdout(second, "2回目 (同じセッション・同じ種類の rv 助言の繰り返し)");
});

// ===========================================================================
// 7. 出てはいけない場面 (負例)
// ===========================================================================

check("PreToolUse で rv/HTML と無関係なツール (Read) には助言が出ない", async () => {
  const sessionId = "s-neg-read";
  const scn = await scenarioWithLightVerdict(sessionId);
  const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Read", { file_path: "src/foo.ts" }));
  assertExitOk(r, "Read");
  assertNoStdout(r, "Read");
});

check("PreToolUse で rv/HTML と無関係な Bash コマンド (ls) には助言が出ない", async () => {
  const sessionId = "s-neg-ls";
  const scn = await scenarioWithLightVerdict(sessionId);
  const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Bash", { command: "ls" }));
  assertExitOk(r, "ls");
  assertNoStdout(r, "ls");
});

check(
  "rv 入口でも、見立てが重く・差分が大きく (>20行)・危険パスも無ければ助言は出ない",
  async () => {
    const sessionId = "s-neg-heavy-large";
    const scn = await scenarioWithVerdictAndDiff(sessionId, { size: 2.5, risky: 0.1 }, 21);
    const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Skill", { skill: "review" }));
    assertExitOk(r, "重い・大差分・非危険パス");
    assertNoStdout(r, "重い・大差分・非危険パス");
  },
);

check("rv 入口では、保存した見立てが軽ければ差分が21行あっても「マイルストーン」が出る (保存した見立てが実際に使われている)", async () => {
  const sessionId = "s-light-large-diff";
  const scn = await scenarioWithVerdictAndDiff(sessionId, { size: 0, risky: 0.05 }, 21);
  const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Skill", { skill: "review" }));
  assertExitOk(r, "軽い・大差分");
  const parsed = parseAdvice(r, "軽い・大差分");
  assert.match(parsed.hookSpecificOutput.additionalContext, /マイルストーン/);
});

check("PreToolUse で Skill だが review 以外の skill には rv の助言が出ない", async () => {
  const sessionId = "s-neg-skill-other";
  const scn = await scenarioWithLightVerdict(sessionId);
  const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Skill", { skill: "other" }));
  assertExitOk(r, "Skill/other");
  assertNoStdout(r, "Skill/other");
});

check("Write でも reports/ 配下でない .html には HTML の助言が出ない", async () => {
  const sessionId = "s-neg-write-nonreports";
  const scn = await scenarioWithLightVerdict(sessionId);
  const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Write", { file_path: "docs/index.html", content: "<html></html>" }));
  assertExitOk(r, "Write/非reports");
  assertNoStdout(r, "Write/非reports");
});

// ===========================================================================
// 8. 見立ては重いが差分が小さい (境界: 20行ちょうど)
// ===========================================================================

check("rv 入口で、見立ては重いが差分が20行以下 (境界: ちょうど20行) なら「マイルストーン」が出る", async () => {
  const sessionId = "s-heavy-small-diff";
  const scn = await scenarioWithVerdictAndDiff(sessionId, { size: 2.5, risky: 0.1 }, 20);
  const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Skill", { skill: "review" }));
  assertExitOk(r, "重い・境界20行");
  const parsed = parseAdvice(r, "重い・境界20行");
  assert.match(parsed.hookSpecificOutput.additionalContext, /マイルストーン/);
});

// ===========================================================================
// 9. 危険な変更パスに触れているときの助言。rv の入口だけに出て、HTML の入口には出ない
// ===========================================================================

check("rv 入口で危険パス (db/migrations/001.sql) に触れていると「2 本目のレビュアー」とパス名を含む助言が出る", async () => {
  const sessionId = "s-risky-rv";
  const scn = await scenarioWithVerdictAndDiff(sessionId, { size: 2.5, risky: 0.1 }, 25, "db/migrations/001.sql");
  const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Skill", { skill: "review" }));
  assertExitOk(r, "危険パス/rv");
  const parsed = parseAdvice(r, "危険パス/rv");
  assert.match(parsed.hookSpecificOutput.additionalContext, /2 本目のレビュアー/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /db\/migrations\/001\.sql/);
});

check("同じ危険パスでも HTML 入口では「2 本目のレビュアー」は出ない (危険パスの助言は rv 専用)", async () => {
  const sessionId = "s-risky-html";
  // 見立てを軽くしておき、HTML 入口が必ず「マイルストーン」を返す状況を作る。
  // それでも「2 本目のレビュアー」は rv 専用なので出ないはず、という非自明な確認にする。
  const scn = await scenarioWithVerdictAndDiff(sessionId, { size: 0, risky: 0.05 }, 3, "db/migrations/001.sql");
  const filePath = join("project-docs", "p", "reports", "2026-09-23-x", "index.html");
  const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Write", { file_path: filePath, content: "<html></html>" }));
  assertExitOk(r, "危険パス/HTML");
  const parsed = parseAdvice(r, "危険パス/HTML");
  assert.match(parsed.hookSpecificOutput.additionalContext, /マイルストーン/, "危険パス/HTML: 前提として HTML 入口の助言自体は出るはず");
  assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /2 本目のレビュアー/);
});

check("危険パスが4件あっても助言に含まれるパスは3件まで", async () => {
  const sessionId = "s-risky-many";
  const stub = await startStub(() => ok200(jevBody({ size: 2.5, risky: 0.1 })));
  const scn = freshScenario(stub.url);
  initRepo(scn.repoDir, scn.env);
  writeAgents(scn, "Jev: full\n");
  writeFileSync(join(scn.repoDir, "base.txt"), "base\n");
  commitAll(scn.repoDir, scn.env, "init on main");
  git(scn.repoDir, ["checkout", "-q", "-b", "feature"], scn.env);
  const riskyPaths = ["db/migrations/001.sql", "src/auth.ts", "src/secret.ts", "src/token.ts"];
  for (const p of riskyPaths) {
    mkdirSync(join(scn.repoDir, p.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(scn.repoDir, p), "-- risky change --\n");
  }
  commitAll(scn.repoDir, scn.env, "risky changes");
  const pre = await runHook(scn.repoDir, scn.env, userPromptSubmit(sessionId, scn.repoDir));
  assertExitOk(pre, "準備 (危険パス4件)");
  await stub.close();

  const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Skill", { skill: "review" }));
  assertExitOk(r, "危険パス4件");
  const parsed = parseAdvice(r, "危険パス4件");
  const hits = riskyPaths.filter((p) => parsed.hookSpecificOutput.additionalContext.includes(p));
  assert.ok(hits.length <= 3, `危険パスは3件までのはずが ${hits.length} 件出た: ${hits.join(", ")}`);
});

// ===========================================================================
// 10. 対象外のイベント
// ===========================================================================

check("Stop イベントには助言が出ない", async () => {
  const sessionId = "s-stop";
  const scn = await scenarioWithLightVerdict(sessionId);
  const r = await runHook(scn.repoDir, scn.env, hookInput({ hook_event_name: "Stop", session_id: sessionId, cwd: scn.repoDir }));
  assertExitOk(r, "Stop");
  assertNoStdout(r, "Stop");
});

check("SessionStart イベントには助言が出ない", async () => {
  const sessionId = "s-sessionstart";
  const scn = await scenarioWithLightVerdict(sessionId);
  const r = await runHook(scn.repoDir, scn.env, hookInput({ hook_event_name: "SessionStart", session_id: sessionId, cwd: scn.repoDir }));
  assertExitOk(r, "SessionStart");
  assertNoStdout(r, "SessionStart");
});

// ===========================================================================
// 11. shadow モード (決定6, 2026-09-23 追記): 標準出力に何も書かず、判定をログに残す
// ===========================================================================

check(
  "shadow: Jev: full の UserPromptSubmit は標準出力なしでログに1行残る (transcript_path・mode・rules・jev・advice, 依頼文は残らない)",
  async () => {
    const stub = await startStub(() => ok200(jevBody({ size: 0, risky: 0.05 })));
    const scn = freshScenario(stub.url);
    scn.env = withShadow(scn.env);
    initRepo(scn.repoDir, scn.env);
    writeAgents(scn, "Jev: full\n");
    commitAll(scn.repoDir, scn.env, "init");
    const transcriptPath = "/tmp/shadow-transcript-abc.jsonl";
    const r = await runHook(
      scn.repoDir,
      scn.env,
      userPromptSubmit("s-shadow-full", scn.repoDir, PROMPT, { transcriptPath }),
    );
    assertExitOk(r, "shadow/full");
    assertNoStdout(r, "shadow/full: shadow では標準出力に何も書かないはず");
    const raw = readLogRaw(scn);
    assert.doesNotMatch(raw, new RegExp(PROMPT_TOKEN), "shadow/full: ログに依頼文の全文が残っている");
    const entry = readLogLines(scn).find((l) => l.session_id === "s-shadow-full" && !("tool_name" in l));
    assert.ok(entry, "shadow/full: UserPromptSubmit のログ行が無い");
    assert.equal(entry.transcript_path, transcriptPath, "shadow/full: transcript_path が入力値と一致しない");
    assert.equal(entry.mode, "full");
    assert.ok(
      entry.rules && typeof entry.rules.size === "number" && typeof entry.rules.risky === "number",
      "shadow/full: rules (ルール表の見立て) が無いか size/risky が数値でない",
    );
    assert.ok(entry.jev && typeof entry.jev.size === "number", "shadow/full: jev (jev の見立て) が記録されていない");
    assert.ok(
      Array.isArray(entry.advice) && entry.advice.every((s: unknown) => typeof s === "string"),
      "shadow/full: advice が文字列の配列でない",
    );
    // jev の見立てが軽いタスク (size 0, risky 0.05) なので、採用する見立ては通常時と同じはず (決定6・決定3)。
    assert.ok(
      entry.advice.some((s: string) => /軽いタスク/.test(s)),
      "shadow/full: jev が軽いタスクと見立てたのに advice に「軽いタスク」の助言が無い (採用する見立てが通常時と違う)",
    );
    await stub.close();
  },
);

check("shadow: Jev 行が無いリポジトリの UserPromptSubmit はログに mode=facts・jev=null で残り、スタブへの送信は起きない", async () => {
  const stub = await startStub(() => ok200(jevBody({})));
  const scn = freshScenario(stub.url);
  scn.env = withShadow(scn.env);
  initRepo(scn.repoDir, scn.env);
  writeFileSync(join(scn.repoDir, "README.md"), "hello\n");
  commitAll(scn.repoDir, scn.env, "init"); // Jev 行なし
  const r = await runHook(scn.repoDir, scn.env, userPromptSubmit("s-shadow-facts", scn.repoDir));
  assertExitOk(r, "shadow/facts");
  assertNoStdout(r, "shadow/facts: shadow では標準出力に何も書かないはず");
  assert.equal(stub.requests.length, 0, "shadow/facts: Jev 行が無いのにスタブへ送信が起きた");
  const entry = readLogLines(scn).find((l) => l.session_id === "s-shadow-facts");
  assert.ok(entry, "shadow/facts: ログ行が無い");
  assert.equal(entry.mode, "facts");
  assert.equal(entry.jev, null, "shadow/facts: jev は null のはず (Jev: full 以外)");
  await stub.close();
});

check("shadow: PreToolUse rv 入口 (Skill review) は標準出力なしでログに1行残る (tool_name・entry・diffLines・riskyHits・advice に milestone)", async () => {
  const sessionId = "s-shadow-rv-milestone";
  const scn = await shadowScenarioWithLightVerdict(sessionId);
  const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Skill", { skill: "review" }));
  assertExitOk(r, "shadow/rv");
  assertNoStdout(r, "shadow/rv: shadow では標準出力に何も書かないはず");
  const lines = readLogLines(scn).filter((l) => l.session_id === sessionId && l.tool_name === "Skill");
  assert.equal(lines.length, 1, `shadow/rv: 入口に当たったら1行のはず (決定6)。got ${lines.length} 行`);
  const entry = lines[0];
  assert.equal(entry.entry, "rv");
  assert.equal(typeof entry.diffLines, "number", "shadow/rv: diffLines が数値でない");
  assert.equal(typeof entry.riskyHits, "number", "shadow/rv: riskyHits が数値でない");
  assert.ok(Array.isArray(entry.advice) && entry.advice.includes("milestone"), "shadow/rv: advice に milestone が無い");
});

check(
  "shadow: 危険パス (db/migrations/001.sql) に触れた rv 入口はログの advice に risky・riskyHits>=1 が残るが、パス文字列自体は残らない",
  async () => {
    const sessionId = "s-shadow-rv-risky";
    const scn = await shadowScenarioWithVerdictAndDiff(sessionId, { size: 2.5, risky: 0.1 }, 25, "db/migrations/001.sql");
    const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Skill", { skill: "review" }));
    assertExitOk(r, "shadow/rv-risky");
    assertNoStdout(r, "shadow/rv-risky: shadow では標準出力に何も書かないはず");
    const raw = readLogRaw(scn);
    assert.doesNotMatch(raw, /migrations/, "shadow/rv-risky: ログに変更パスの文字列 (migrations) が残っている");
    const lines = readLogLines(scn).filter((l) => l.session_id === sessionId && l.tool_name === "Skill");
    assert.equal(lines.length, 1, `shadow/rv-risky: 入口に当たったら1行のはず (決定6)。got ${lines.length} 行`);
    const entry = lines[0];
    assert.ok(Array.isArray(entry.advice) && entry.advice.includes("risky"), "shadow/rv-risky: advice に risky が無い");
    assert.ok(typeof entry.riskyHits === "number" && entry.riskyHits >= 1, "shadow/rv-risky: riskyHits が1未満");
  },
);

check("shadow: 助言が無い rv 入口 (重い・大差分・非危険パス) でも、助言の有無にかかわらず advice: [] のログ1行が残る", async () => {
  const sessionId = "s-shadow-rv-noadvice";
  const scn = await shadowScenarioWithVerdictAndDiff(sessionId, { size: 2.5, risky: 0.1 }, 21);
  const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Skill", { skill: "review" }));
  assertExitOk(r, "shadow/rv-noadvice");
  assertNoStdout(r, "shadow/rv-noadvice: shadow では標準出力に何も書かないはず");
  const lines = readLogLines(scn).filter((l) => l.session_id === sessionId && l.tool_name === "Skill");
  assert.equal(lines.length, 1, `shadow/rv-noadvice: 助言の有無にかかわらず1行残るはず (決定6)。got ${lines.length} 行`);
  assert.deepEqual(lines[0].advice, [], "shadow/rv-noadvice: advice は空配列のはず");
});

check("shadow: rv/HTML と無関係なツール (Read) はログに行を残さない", async () => {
  const sessionId = "s-shadow-read";
  const scn = await shadowScenarioWithLightVerdict(sessionId);
  const before = readLogLines(scn).length;
  const r = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Read", { file_path: "src/foo.ts" }));
  assertExitOk(r, "shadow/Read");
  assertNoStdout(r, "shadow/Read: shadow では標準出力に何も書かないはず");
  const after = readLogLines(scn);
  assert.equal(after.length, before, "shadow/Read: 対象外ツールなのにログ行が増えた");
  assert.ok(!after.some((l) => l.tool_name === "Read"), "shadow/Read: Read のログ行が残っている");
});

check("shadow でも1セッション1回の制限 (決定3) が働く: 同じセッションで rv 入口を2回踏むと、2回目のログの advice に milestone は含まれない", async () => {
  const sessionId = "s-shadow-once";
  const scn = await shadowScenarioWithLightVerdict(sessionId);
  const first = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Skill", { skill: "review" }));
  assertExitOk(first, "shadow/once 1回目");
  assertNoStdout(first, "shadow/once 1回目: shadow では標準出力に何も書かないはず");
  const second = await runHook(scn.repoDir, scn.env, preToolUse(sessionId, scn.repoDir, "Skill", { skill: "review" }));
  assertExitOk(second, "shadow/once 2回目");
  assertNoStdout(second, "shadow/once 2回目: shadow では標準出力に何も書かないはず");
  const lines = readLogLines(scn).filter((l) => l.session_id === sessionId && l.tool_name === "Skill");
  assert.equal(lines.length, 2, `shadow/once: 入口を2回踏んだら2行のはず (決定6)。got ${lines.length} 行`);
  assert.ok(
    Array.isArray(lines[0].advice) && lines[0].advice.includes("milestone"),
    "shadow/once: 1回目の advice に milestone が無い (前提)",
  );
  assert.ok(
    Array.isArray(lines[1].advice) && !lines[1].advice.includes("milestone"),
    "shadow/once: 2回目の advice に milestone が残っている (1セッション1回の制限が shadow で働いていない)",
  );
});

// ===========================================================================
// 実行
// ===========================================================================

let failed = 0;
for (const c of cases) {
  try {
    await c.fn();
    console.log(`ok   ${c.name}`);
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`FAIL ${c.name}\n     ${msg.split("\n")[0]}`);
  }
}

console.log(failed ? `\n${failed}/${cases.length} failed` : `\n${cases.length}/${cases.length} ok`);
process.exit(failed ? 1 : 0);
