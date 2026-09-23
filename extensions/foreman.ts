// pi への配線。判断は src/foreman.ts にあり、ここは state を組んで注入するだけ。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { advise, suggestModel } from "../src/foreman.ts";
import { judge, repoFacts } from "../src/state.ts";

export default function register(pi: ExtensionAPI): void {
  let outstanding: string[] = [];
  let reportedErrorAt = 0;

  pi.on("before_agent_start", async (event, ctx) => {
    outstanding = [];
    const prompt = event.prompt?.trim();
    if (!prompt) return;

    // 対象リポジトリの `Jev: full` だけ jev に全文を送る。既定は手元のルール表 (ADR 0003 決定 4・5)
    const verdict = await judge(prompt, repoFacts(ctx.cwd));
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
    outstanding = lines.filter((l) => /2 本目|実画面/.test(l));
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
