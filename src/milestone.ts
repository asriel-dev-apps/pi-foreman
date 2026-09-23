// 判定点 3 (マイルストーンか) と 4 (危ない変更か)。jev は呼ばない。差分やパスを外に出さないため (ADR 0003 決定 1)。
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isLight, type Verdict } from "./foreman.ts";

export type Entry = "rv" | "html";

const REPORT_HTML = /reports\/[^\s"'\\]*\.html/;

/** rv と HTML レポートの入口 (ADR 0003 決定 3 の表)。読むだけの操作は拾わない。 */
export function entryOf(toolName: string, toolInput: unknown): Entry | null {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  if (toolName === "Skill") return /(^|:)review$/.test(String(input.skill ?? "")) ? "rv" : null;
  if (toolName === "Agent") return input.subagent_type === "reporter" ? "html" : null;
  if (toolName === "Write" || toolName === "Edit") return REPORT_HTML.test(String(input.file_path ?? "")) ? "html" : null;
  if (toolName === "apply_patch") return REPORT_HTML.test(String(input.command ?? input.patch ?? "")) ? "html" : null;
  if (toolName === "Bash") {
    const cmd = String(input.command ?? "");
    // レビュアーの起動: review skill の依頼文を、codex exec か claude -p に渡している
    if (cmd.includes("rv-brief") && /\bcodex\b[^\n]*\bexec\b|\bclaude\s+-p\b/.test(cmd)) return "rv";
    // 書き込み: リダイレクトか tee の行き先がレポートの HTML
    if (/(>|\btee\s+(-a\s+)?)\s*["']?[^\s"'|;&]*reports\/[^\s"'|;&]*\.html/.test(cmd)) return "html";
  }
  return null;
}

export const RISKY_PATH = /migrat|\.sql$|schema|auth|secret|credential|token|crypt|lock|mutex|concurren|queue|worker/i;

// 空の木。コミットが 1 つも無いリポジトリの基点にする
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// フックは 5 秒で切られる。git 1 回あたり 1.5 秒で打ち切る
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim();

/** 基点。今いるブランチ自身を基点にしないよう、HEAD と同じになる候補は飛ばす。 */
function baseOf(top: string): string {
  let head: string;
  try {
    head = git(top, ["rev-parse", "HEAD"]);
  } catch {
    return EMPTY_TREE;
  }
  for (const ref of ["@{upstream}", "origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    try {
      const mb = git(top, ["merge-base", "HEAD", ref]);
      if (mb && mb !== head) return mb;
    } catch {
      // 次の候補へ
    }
  }
  return head;
}

/** 基点からの差分 (未コミットと未追跡を含む) の行数と変更パス。git の外なら null。 */
export function diffFacts(cwd: string): { lines: number; paths: string[] } | null {
  let top: string;
  try {
    top = git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
  const base = baseOf(top);
  let lines = 0;
  const paths = new Set<string>();
  for (const row of git(top, ["diff", "--numstat", "-z", base]).split("\0").filter(Boolean)) {
    const [a, d, p] = row.split("\t");
    // バイナリは "-"。大きさがわからないので小さい差分とはみなさない
    lines += a === "-" ? 1000 : (Number(a) || 0) + (Number(d) || 0);
    if (p) paths.add(p);
  }
  for (const p of git(top, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)) {
    paths.add(p);
    try {
      const st = statSync(join(top, p));
      // FIFO などで止まらないよう、普通のファイルで 1MB 未満だけ読む
      lines += st.isFile() && st.size < 1_000_000 ? readFileSync(join(top, p), "utf8").split("\n").filter(Boolean).length : 1000;
    } catch {
      // 読めない未追跡ファイルは行数に数えない
    }
  }
  return { lines, paths: [...paths] };
}

/**
 * 入口に当たったときの助言。claim(key) が true を返したときだけ出す (1 セッション 1 回)。
 * key は "milestone:rv" "milestone:html" "risky" の 3 つ。
 */
export function adviseAtEntry(
  entry: Entry,
  verdict: Verdict | undefined,
  diff: { lines: number; paths: string[] } | null,
  claim: (key: string) => boolean,
): string[] {
  const lines: string[] = [];
  const what = entry === "rv" ? "rv" : "HTML レポート";
  if (verdict && isLight(verdict)) {
    if (claim(`milestone:${entry}`)) {
      lines.push(`依頼時の見立ては軽いタスクだった。${what}はマイルストーンでだけ行う。この依頼で本当に要るか確かめる。`);
    }
  } else if (diff && diff.lines <= 20) {
    if (claim(`milestone:${entry}`)) {
      lines.push(`差分が小さい (${diff.lines} 行)。${what}はマイルストーンでだけ行う。いまがマイルストーンか確かめる。`);
    }
  }
  if (entry === "rv" && diff) {
    const hits = diff.paths.filter((p) => RISKY_PATH.test(p)).slice(0, 3);
    if (hits.length && claim("risky")) {
      lines.push(`データ消失・秘匿値・移行・並行実行に触れうるパスがある (${hits.join(", ")})。2 本目のレビュアーを足す。`);
    }
  }
  return lines;
}
