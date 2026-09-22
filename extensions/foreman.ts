// pi への配線。判断は src/foreman.ts にあり、ここは state を組んで注入するだけ。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { advise, ask, suggestModel } from "../src/foreman.ts";

/** リポジトリの概要。プロンプト文だけでは規模が読めない依頼があるため (ADR 0001 決定 3)。 */
function repoSummary(cwd: string): string {
  const lines = [`repository: ${basename(cwd)}`];
  try {
    const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    const tier = agents.match(/^Tier:.*$/m);
    if (tier) lines.push(tier[0]);
  } catch {
    // AGENTS.md がないリポジトリもある
  }
  try {
    // git リポジトリでないときの fatal を端末に出さない
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files = status.split("\n").filter(Boolean);
    if (files.length) {
      const exts = [...new Set(files.map((l) => l.slice(3).split(".").pop() ?? ""))].slice(0, 5);
      lines.push(`uncommitted: ${files.length} files (${exts.join(", ")})`);
    }
  } catch {
    // git リポジトリでないこともある
  }
  return lines.join("\n");
}

export default function register(pi: ExtensionAPI): void {
  let outstanding: string[] = [];
  let reportedErrorAt = 0;

  pi.on("before_agent_start", async (event, ctx) => {
    outstanding = [];
    const prompt = event.prompt?.trim();
    if (!prompt) return;

    const state = `${prompt}\n\n---\n${repoSummary(ctx.cwd)}`;
    const verdict = await ask(state);
    if (!verdict) {
      // fail open: 判定が出なくても仕事は止めない (ADR 0001 決定 5)
      const now = Date.now();
      if (now - reportedErrorAt > 60_000) {
        reportedErrorAt = now;
        ctx.ui.setStatus("foreman", "foreman: 判定なし");
      }
      return;
    }

    const lines = advise(verdict);
    if (!lines.length) return;

    // 受け入れ前にやることだけ、終わり際に思い出せるよう覚えておく
    outstanding = lines.filter((l) => /rv|実画面|レポート/.test(l));
    ctx.ui.setStatus("foreman", `foreman: ${verdict.kind} / ${suggestModel(verdict)}`);

    return {
      message: {
        customType: "foreman",
        content: [
          "着手前の見立て (助言であって指示ではない。合わないと思ったら従わなくてよい):",
          ...lines.map((l) => `- ${l}`),
          `- 実装モデルの推奨: ${suggestModel(verdict)}`,
        ].join("\n"),
        display: true,
      },
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!outstanding.length) return;
    const pending = outstanding;
    outstanding = [];
    ctx.ui.notify(`foreman: 受け入れる前に — ${pending.join(" / ")}`, "warning");
  });
}
