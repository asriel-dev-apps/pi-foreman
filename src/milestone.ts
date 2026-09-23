// 判定点 3 (マイルストーンか) と 4 (危ない変更か)。jev は呼ばない。差分やパスを外に出さないため (ADR 0003 決定 1)。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isLight, type Verdict } from "./foreman.ts";

export type Entry = "rv" | "html";

/** rv と HTML レポートの入口 (ADR 0003 決定 3 の表)。 */
export function entryOf(toolName: string, toolInput: unknown): Entry | null {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  if (toolName === "Skill" && /(^|:)review$/.test(String(input.skill ?? ""))) return "rv";
  if (toolName === "Agent" && input.subagent_type === "reporter") return "html";
  const text = JSON.stringify(input);
  if (toolName === "Bash" && text.includes("rv-brief")) return "rv";
  if (/reports\/[^\s"'\\]*\.html/.test(text)) return "html";
  return null;
}

export const RISKY_PATH = /migrat|\.sql$|schema|auth|secret|credential|token|crypt|lock|mutex|concurren|queue|worker/i;

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** 基点からの差分 (未コミットを含む) の行数と変更パス。git の外なら null。 */
export function diffFacts(cwd: string): { lines: number; paths: string[] } | null {
  let base = "HEAD";
  try {
    git(cwd, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    return null;
  }
  for (const ref of ["origin/HEAD", "main", "master"]) {
    try {
      base = git(cwd, ["merge-base", "HEAD", ref]);
      break;
    } catch {
      // 次の候補へ
    }
  }
  let lines = 0;
  const paths = new Set<string>();
  // 作業ツリーと基点の差 = 基点以降のコミット + 未コミット
  for (const row of git(cwd, ["diff", "--numstat", base]).split("\n").filter(Boolean)) {
    const [a, d, p] = row.split("\t");
    lines += (Number(a) || 0) + (Number(d) || 0);
    paths.add(p);
  }
  for (const p of git(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)) {
    paths.add(p);
    try {
      lines += readFileSync(join(cwd, p), "utf8").split("\n").filter(Boolean).length;
    } catch {
      // 読めない未追跡ファイルは行数に数えない
    }
  }
  return { lines, paths: [...paths] };
}

/** 入口に当たったときの助言。seen に出した種類を足していく (1 セッション 1 回)。 */
export function adviseAtEntry(
  entry: Entry,
  verdict: Verdict | undefined,
  diff: { lines: number; paths: string[] } | null,
  seen: Set<string>,
): string[] {
  const lines: string[] = [];
  const what = entry === "rv" ? "rv" : "HTML レポート";
  if (!seen.has(`milestone:${entry}`)) {
    if (verdict && isLight(verdict)) {
      lines.push(`依頼時の見立ては軽いタスクだった。${what}はマイルストーンでだけ行う。この依頼で本当に要るか確かめる。`);
    } else if (diff && diff.lines <= 20) {
      lines.push(`差分が小さい (${diff.lines} 行)。${what}はマイルストーンでだけ行う。いまがマイルストーンか確かめる。`);
    }
    if (lines.length) seen.add(`milestone:${entry}`);
  }
  if (entry === "rv" && diff && !seen.has("risky")) {
    const hits = diff.paths.filter((p) => RISKY_PATH.test(p)).slice(0, 3);
    if (hits.length) {
      lines.push(`データ消失・秘匿値・移行・並行実行に触れうるパスがある (${hits.join(", ")})。2 本目のレビュアーを足す。`);
      seen.add("risky");
    }
  }
  return lines;
}
