// node scripts/backtest.ts [件数] — 過去の Claude Code セッションを正解ラベルにして
// ルール表の判定と突き合わせる。pi にはこの規模のログがまだないので claude 側を使う。
// 検証しているのは「質問文 × 閾値」であって、pi 側の文面の妥当性ではない (ADR 0001)。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ask, advise } from "../src/foreman.ts";

const ROOT = join(homedir(), ".claude", "projects");

// 「進捗レポートを書いた」とみなすパス。置き場所は人によるので、自分の慣習に合わせる。
const REPORT_PATH = /\/reports\/[^/]+\.html$/;
const LIMIT = Number(process.argv[2] ?? 40);

// ログには API キーが平文で残り得る。長い英数字列は落としてから表示する。
const redact = (s: string) => s.replace(/[A-Za-z0-9_-]{24,}/g, "***");

// /clear などのスラッシュコマンドは、注意書きとコマンド名を人間の発話と同じ user メッセージに
// 混ぜて記録される。剥がした残りが空なら、それは人間のプロンプトではない。
const humanPart = (c: string) =>
  c
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();

// 着手前ルーティングの対象外。仕事が書かれていない冒頭は、判定材料がないのだから
// 判定してはいけない。標本に残すと「見逃し」として数えられて数字が濁る。
// 部分一致にすると本物の依頼を巻き込む。「<Button> の表示崩れを直して」は `^<` に、
// 「/src/auth.ts のバグを直して」は `^/` に、「続きです。今回は別の関数を直して」は
// 部分一致の「続きです」に食われる。だからメッセージ全体の形で判定する。
const OUT_OF_SCOPE = [
  /^<(task-notification|system-reminder|local-command)/, // 起こされただけ・コマンドの残骸
  /^Review this change for security vulnerabilities\.?$/m, // /security-review の定型文
  /^\/[a-z-]+(\s|$)/i, //              スラッシュコマンドそのもの (/resume など)
  /^[^。\n]{0,20}続き(です|をやって)[^。\n]{0,40}$/, // 「…の続きです」だけで終わる依頼
  /^再開(して)?[。\s]*$/,
  /^say OK$/i,
  /^Reply with only your exact model ID/,
];

type Session = { file: string; prompt: string; agent: boolean; skills: string[]; report: boolean };

function readSession(file: string): Session | null {
  let prompt: string | undefined;
  // 最初の人間の発話だけを見る。対象外ならそのセッションごと落とす。途中の発話を拾うと
  // 「セッションの冒頭」ではなくなり、ラベル (そのセッション全体の挙動) と対応しなくなる。
  let decided = false;
  const skills: string[] = [];
  let agent = false;
  let report = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = d.message ?? {};
    if (d.type === "user" && !decided) {
      const c = msg.content;
      if (typeof c === "string") {
        const human = humanPart(c);
        if (human) {
          decided = true;
          if (!OUT_OF_SCOPE.some((re) => re.test(human))) prompt = human;
        }
      }
    }
    if (d.type === "assistant") {
      for (const b of msg.content ?? []) {
        if (b?.type !== "tool_use") continue;
        if (b.name === "Agent") agent = true;
        if (b.name === "Skill" && b.input?.skill) skills.push(String(b.input.skill));
        if (b.name === "Write" && REPORT_PATH.test(String(b.input?.file_path ?? ""))) {
          report = true;
        }
      }
    }
  }
  return prompt ? { file, prompt, agent, skills, report } : null;
}

if (!existsSync(ROOT)) {
  console.error(`${ROOT} がない。Claude Code のセッションログが要る。`);
  process.exit(1);
}

const files = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .flatMap((e) =>
    readdirSync(join(ROOT, e.name))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(ROOT, e.name, f)),
  )
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  .slice(0, LIMIT);

const counts = { delegate: [0, 0, 0, 0], report: [0, 0, 0, 0] }; // [TP, FP, FN, TN]
let scored = 0;
let outOfScope = 0;

for (const file of files) {
  const s = readSession(file);
  if (!s) {
    outOfScope++;
    continue;
  }
  const v = await ask(s.prompt.slice(0, 4000));
  if (!v) {
    console.error("SKIP 判定が返らなかった:", file);
    continue;
  }
  scored++;
  const lines = advise(v);
  const pred = {
    delegate: lines.some((l) => l.includes("委譲")),
    report: lines.some((l) => l.includes("レポート")),
  };
  for (const k of ["delegate", "report"] as const) {
    const actual = k === "delegate" ? s.agent : s.report;
    const i = pred[k] ? (actual ? 0 : 1) : actual ? 2 : 3;
    counts[k][i]++;
  }
  const flag = pred.delegate === s.agent && pred.report === s.report ? "  " : "!!";
  console.log(
    `${flag} size=${v.size.toFixed(1)} risky=${v.risky.toFixed(2)} kind=${v.kind.padEnd(8)}` +
      ` pred[委譲=${+pred.delegate} 報告=${+pred.report}] actual[委譲=${+s.agent} 報告=${+s.report}]` +
      ` skills=${s.skills.slice(0, 3).join(",") || "-"}  ${redact(s.prompt.slice(0, 50)).replace(/\n/g, " ")}`,
  );
}

console.log(`\n${scored} セッション (対象外として除外: ${outOfScope})`);
if (!scored) {
  console.log("突き合わせる対象がなかった");
} else {
  // 割合は出さない。ラベルは「セッション中に一度でも起きたか」であって、冒頭プロンプトが
  // 予測すべき対象ではないため、率として読める数字を出すこと自体が誤解を招く。
  for (const k of ["delegate", "report"] as const) {
    const [tp, fp, fn, tn] = counts[k];
    console.log(`${k.padEnd(9)} 的中 ${tp}  空振り ${fp}  見逃し ${fn}  正しく静か ${tn}`);
  }
  console.log("この数は率ではない。!! 行を1件ずつ読んで、質問文の欠陥を探すための道具。");
}
