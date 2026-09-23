// jev に何を送るか (ADR 0003 決定 4)。既定は閉じた側: 依頼文を固定の語彙に写した「射影」だけを送る。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Verdict } from "./foreman.ts";

export type Mode = "full" | "facts" | "off";

// 射影の語彙。ここに書いた名前だけが外に出る。依頼文の文字列は一切出ない。
const VOCAB: Record<string, RegExp> = {
  question: /説明|とは|教えて|なぜ|どう(やって|なって)|[?？]|\b(explain|what|why|how)\b/i,
  investigate: /調べ|調査|原因|\b(investigate|debug)/i,
  fix: /直し|直す|直せ|修正|バグ|\b(fix|bug)/i,
  add: /追加|足し|足す|作り|作る|作成|実装|書い|書く|\b(add|implement|create|build|write)\b/i,
  change: /変え|変更|差し替え|\b(change|replace|update)\b/i,
  remove: /削除|消し|消す|\b(delete|remove|drop)\b/i,
  refactor: /リファクタ|整理|\brefactor/i,
  design: /設計|見直|計画|\b(architecture|design|plan)\b/i,
  migrate: /マイグレーション|移行|\bmigrat/i,
  docs: /README|CHANGELOG|ドキュメント|文書|コメント|\bdocs?\b/i,
  tiny: /typo|誤字|1行|一行|\bone.line\b/i,
  ui: /画面|\bT?UI\b|レイアウト|ボタン|色|表示|スタイル|文言|\b(screen|layout|style)\b/i,
  auth: /認証|トークン|OAuth|権限|秘密|パスワード|\b(secret|token|auth|password)/i,
  data: /\bDB\b|データベース|テーブル|本番|\b(database|table|production)\b/i,
  money: /決済|課金|\b(payment|billing)\b/i,
  infra: /デプロイ|\bCI\b|ビルド|依存|\b(deploy|dependenc)/i,
  tests: /テスト|\btest/i,
  refers_back: /前に|前の|さっき|先ほど|再開|続き|よくはなった|\b(again|previous|resume)\b/i,
  broad: /全体|ゼロから|全部|全面|それぞれ|\b(entire|whole|from scratch)\b/i,
};

export function tokens(prompt: string): string[] {
  return Object.keys(VOCAB).filter((k) => VOCAB[k].test(prompt));
}

const KNOWN_EXTS = new Set(
  "ts tsx js jsx mjs cjs json md mdx html css scss py rb go rs java kt swift dart c h cc cpp cs php sh zsh toml yaml yml sql lock txt svg png".split(" "),
);

type RepoFacts = { name?: string; tier?: string; jev?: string; uncommitted: number; exts: string[] };

/** cwd のリポジトリから、送信の判断と state に使う事実を集める。git の外なら null。 */
export function repoFacts(cwd: string): RepoFacts | null {
  let top: string;
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
  const facts: RepoFacts = { name: basename(top), uncommitted: 0, exts: [] };
  try {
    const agents = readFileSync(join(top, "AGENTS.md"), "utf8");
    facts.tier = agents.match(/^Tier:\s*(\S+)/m)?.[1];
    facts.jev = agents.match(/^Jev:\s*(\S+)/m)?.[1];
  } catch {
    // AGENTS.md がないリポジトリもある
  }
  try {
    const files = execFileSync("git", ["status", "--porcelain"], {
      cwd: top,
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter(Boolean);
    facts.uncommitted = files.length;
    // 拡張子は既知のものだけ。拡張子の無いファイル名がそのまま出るのを防ぐ
    facts.exts = [...new Set(files.map((l) => extname(l.slice(3).trim()).slice(1).toLowerCase()))]
      .filter((e) => KNOWN_EXTS.has(e))
      .slice(0, 5);
  } catch {
    // 読めなければ 0 件のまま
  }
  return facts;
}

/** `Jev:` 行で送る範囲を決める。無い・不明・git の外は射影 (fail closed)。 */
export function modeOf(facts: RepoFacts | null): Mode {
  if (facts?.jev === "full") return "full";
  if (facts?.jev === "off") return "off";
  return "facts";
}

/** 送る state を組む。off なら null。 */
export function buildState(prompt: string, facts: RepoFacts | null, mode: Mode): string | null {
  if (mode === "off") return null;
  const lines: string[] = [];
  if (mode === "full") {
    lines.push(prompt, "---");
    if (facts?.name) lines.push(`repository: ${facts.name}`);
    if (facts?.tier) lines.push(`Tier: ${facts.tier}`);
    if (facts?.uncommitted) lines.push(`uncommitted: ${facts.uncommitted} files (${facts.exts.join(", ")})`);
    return lines.join("\n");
  }
  // 射影: 語彙の名前・区分・数字・許可した値だけ
  const len = prompt.length < 20 ? "short" : prompt.length < 80 ? "medium" : "long";
  lines.push(`request (keywords only, original text withheld): ${tokens(prompt).join(", ") || "none"}`);
  lines.push(`request length: ${len}`);
  if (facts) {
    if (facts.tier && /^(poc|product|none)$/.test(facts.tier)) lines.push(`Tier: ${facts.tier}`);
    const exts = facts.exts.filter((e) => KNOWN_EXTS.has(e));
    if (facts.uncommitted) lines.push(`uncommitted: ${facts.uncommitted} files (${exts.join(", ")})`);
  }
  return lines.join("\n");
}

/** 射影の語彙だけで決めるルール表。jev を呼ばない対照 (ADR 0003 決定 5)。 */
export function rulesVerdict(prompt: string): Verdict {
  const t = new Set(tokens(prompt));
  const has = (...ks: string[]) => ks.some((k) => t.has(k));
  const onlyAsks = has("question", "investigate") && !has("fix", "add", "change", "remove", "refactor", "migrate");

  let size = 0.5;
  if (has("design", "broad", "migrate")) size = 2.2;
  else if (has("add") && !has("tiny", "docs")) size = 1.3;
  else if (has("fix", "change", "refactor", "remove")) size = 0.9;
  if (has("tiny") || (has("docs") && !has("ui")) || onlyAsks) size = 0.2;

  const risky = onlyAsks ? 0.1 : has("auth", "money", "data", "migrate", "remove") ? 0.8 : 0.1;
  const visual = has("ui") && !has("docs") ? 0.8 : 0.1;
  const kind = has("auth") ? "security" : has("ui") ? "ui" : has("docs") ? "docs" : has("refactor") ? "refactor"
    : has("infra") ? "infra" : onlyAsks ? "research" : "other";
  return {
    size,
    risky,
    visual,
    delegable: has("refers_back") ? 0.2 : 0.8,
    parallel: has("broad") && has("add") ? 0.7 : 0.2,
    kind,
    kindConfidence: 1,
  };
}
