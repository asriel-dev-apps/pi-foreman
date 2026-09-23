// node scripts/check.ts — ネットワークなしでルール表・射影・入口の判定を検査する。
import assert from "node:assert";
import { advise, suggestModel, type Verdict } from "../src/foreman.ts";
import { adviseAtEntry, entryOf } from "../src/milestone.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildState, modeOf, repoFacts, tokens } from "../src/state.ts";

const v = (o: Partial<Verdict> = {}): Verdict => ({
  size: 0,
  risky: 0,
  visual: 0,
  delegable: 0,
  parallel: 0,
  kind: "other",
  kindConfidence: 1,
  ...o,
});

const joined = (o: Partial<Verdict>) => advise(v(o)).join("\n");

// 軽いタスクには段取りを足さず、rv・HTML・サブエージェントが要らないと言う (判定点 1)
const trivial = joined({ size: 0.0, risky: 0.04, visual: 0.05, delegable: 0.75 });
assert.match(trivial, /軽いタスク/);
assert.match(trivial, /要らない/);
assert.doesNotMatch(trivial, /フローに乗せる|実画面|検討する/);

// 危ないタスクは規模が小さくても 2 本目のレビュアーを求める
assert.match(joined({ size: 0.4, risky: 0.87 }), /2 本目のレビュアー/);
assert.doesNotMatch(joined({ size: 0.4, risky: 0.87 }), /軽いタスク/);

// 中規模以上はフローに乗せ、rv と HTML はマイルストーンで
assert.match(joined({ size: 1.3 }), /マイルストーン/);

// 画面を変えるタスクは実画面の確認を要求する
assert.match(joined({ size: 1.7, visual: 0.97 }), /実画面/);
assert.doesNotMatch(joined({ size: 1.7, visual: 0.2 }), /実画面/);

// 判定点 2: 並列にできるなら並列、重くて委譲できるなら委譲
assert.match(joined({ size: 1.5, parallel: 0.8 }), /並列/);
assert.doesNotMatch(joined({ size: 0.3, parallel: 0.8 }), /並列/);
assert.match(joined({ size: 2.4, delegable: 0.8 }), /委譲/);
assert.doesNotMatch(joined({ size: 1.2, delegable: 0.8 }), /委譲/);

// kind の確信が低いときは種類ごとの助言を出さない
assert.doesNotMatch(joined({ kind: "security", kindConfidence: 0.3 }), /security の仕事/);
assert.match(joined({ kind: "security", kindConfidence: 0.9 }), /security の仕事/);

assert.equal(suggestModel(v({ size: 0.0, risky: 0.04 })), "haiku");
assert.equal(suggestModel(v({ size: 1.3, risky: 0.87 })), "opus");
assert.equal(suggestModel(v({ size: 1.3, risky: 0.1 })), "sonnet");

// 送る範囲: 無い・不明・git の外は射影 (fail closed)
assert.equal(modeOf(null), "facts");
assert.equal(modeOf({ uncommitted: 0, exts: [] }), "facts");
assert.equal(modeOf({ jev: "yes", uncommitted: 0, exts: [] }), "facts");
assert.equal(modeOf({ jev: "full", uncommitted: 0, exts: [] }), "full");
assert.equal(modeOf({ jev: "off", uncommitted: 0, exts: [] }), "off");

// 射影には語彙の名前と許可した値しか出ない。依頼文・リポジトリ名・変な拡張子・未知の Tier は出ない
const secret = "株式会社ミズホラ の 見積シート 12345 の認証画面を直して";
const facts = { name: "client-x", tier: "gold<script>", uncommitted: 2, exts: ["ts", "../../etc"] };
const projected = buildState(secret, facts, "facts")!;
for (const leak of ["ミズホラ", "見積", "12345", "client-x", "gold", "etc"]) {
  assert.ok(!projected.includes(leak), `射影に ${leak} が出ている`);
}
const allowed = new Set([...tokens(secret), "none"]);
const kw = projected.match(/original text withheld\): (.*)/)![1].split(", ");
assert.ok(kw.every((k) => allowed.has(k)));
assert.deepEqual(new Set(kw), new Set(["fix", "ui", "auth"]));
assert.ok(buildState(secret, facts, "full")!.includes("ミズホラ"));
assert.equal(buildState(secret, facts, "off"), null);

// 拡張子の無いファイル名や、単語の拡張子が射影に出ない (レビュー指摘: ACME がそのまま送られた)
const repo = mkdtempSync(join(tmpdir(), "foreman-check-"));
execFileSync("git", ["init", "-q"], { cwd: repo });
for (const f of ["ACME", "plan.ACMECORP", "a.ts"]) writeFileSync(join(repo, f), "x\n");
const rf = repoFacts(repo)!;
assert.deepEqual(rf.exts, ["ts"]);
const p2 = buildState("直して", rf, "facts")!;
assert.ok(!/ACME/i.test(p2) && !p2.includes(rf.name!), p2);

// 入口の判定 (ADR 0003 決定 3 の表)
assert.equal(entryOf("Skill", { skill: "review" }), "rv");
assert.equal(entryOf("Skill", { skill: "diff-review" }), null);
assert.equal(entryOf("Bash", { command: 'codex --search exec -o x "$(cat ~/dev-docs/p/rv-brief.md)"' }), "rv");
assert.equal(entryOf("Bash", { command: "herdr pane run w1:p2 'claude -p \"$(cat rv-brief.md)\"'" }), "rv");
assert.equal(entryOf("Write", { file_path: "/x/project-docs/p/reports/2026-09-23-a/index.html" }), "html");
assert.equal(entryOf("apply_patch", { command: "*** Add File: project-docs/p/reports/a/index.html\n+<p>" }), "html");
assert.equal(entryOf("Bash", { command: "cat > reports/a.html <<EOF" }), "html");
assert.equal(entryOf("Agent", { subagent_type: "reporter" }), "html");
assert.equal(entryOf("Read", { file_path: "a.ts" }), null);
assert.equal(entryOf("Bash", { command: "ls" }), null);
// 読むだけ・レビュアーを起動しない操作は拾わない
assert.equal(entryOf("Read", { file_path: "/repo/reports/status.html" }), null);
assert.equal(entryOf("Bash", { command: "cat reports/status.html" }), null);
assert.equal(entryOf("Bash", { command: "open project-docs/p/reports/a/index.html" }), null);
assert.equal(entryOf("Bash", { command: "cat rv-brief.md" }), null);
assert.equal(entryOf("Bash", { command: "node build.js | tee reports/a.html" }), "html");

// 入口での助言: 軽い見立て → マイルストーン。1 セッション 1 回
const once = () => {
  const s = new Set<string>();
  return (k: string) => (s.has(k) ? false : (s.add(k), true));
};
const seen = once();
assert.match(adviseAtEntry("rv", v({ size: 0.2 }), { lines: 500, paths: [] }, seen).join(), /マイルストーン/);
assert.equal(adviseAtEntry("rv", v({ size: 0.2 }), { lines: 500, paths: [] }, seen).length, 0);
// 重い見立て・大きい差分・危なくない → 何も言わない
assert.equal(adviseAtEntry("rv", v({ size: 2.5 }), { lines: 500, paths: ["src/a.ts"] }, once()).length, 0);
// 小さい差分 → マイルストーン
assert.match(adviseAtEntry("html", v({ size: 2.5 }), { lines: 12, paths: [] }, once()).join(), /マイルストーン/);
// 危ないパスは rv でだけ
const risky = { lines: 500, paths: ["db/migrations/001.sql", "src/a.ts"] };
const atRv = adviseAtEntry("rv", v({ size: 2.5 }), risky, once()).join();
assert.match(atRv, /2 本目のレビュアー/);
assert.match(atRv, /db\/migrations\/001\.sql/);
assert.doesNotMatch(atRv, /src\/a\.ts/);
assert.doesNotMatch(adviseAtEntry("html", v({ size: 2.5 }), risky, once()).join(), /2 本目/);

console.log("ok");
