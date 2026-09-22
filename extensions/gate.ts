// 実行前の安全弁の配線。判断は src/gate.ts にある。
// 既定は shadow (知らせるだけで止めない)。enforce にすると実行前に確認を出す。
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { judge, type GateVerdict } from "../src/gate.ts";

const JUDGED_TOOLS = ["bash", "write", "edit"];
const CACHE_MS = 120_000;

export default function register(pi: ExtensionAPI): void {
  let mode: "shadow" | "enforce" = "shadow";
  let enabled = true;
  let userRequest: string | undefined;
  let reportedErrorAt = 0;
  const cache = new Map<string, { at: number } & GateVerdict>();

  pi.on("before_agent_start", async (event) => {
    userRequest = event.prompt?.trim();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled || !JUDGED_TOOLS.includes(event.toolName)) return;

    const key = `${event.toolName}:${JSON.stringify(event.input ?? {})}`;
    const hit = cache.get(key);
    const fresh = hit && Date.now() - hit.at < CACHE_MS;
    const verdict = fresh
      ? hit
      : await judge({
          cwd: ctx.cwd,
          toolName: event.toolName,
          input: (event.input ?? {}) as Record<string, unknown>,
          userRequest,
        });

    if (!verdict) {
      // fail open: 判定が出なくても呼び出しは進む。報告は毎分 1 回まで
      const now = Date.now();
      if (now - reportedErrorAt > 60_000) {
        reportedErrorAt = now;
        ctx.ui.setStatus("gate", "gate: 判定なし");
      }
      return;
    }
    if (!fresh) cache.set(key, { at: Date.now(), ...verdict });
    if (!verdict.flagged) return;

    const reason = verdict.reasons.join(" / ");

    // shadow の通知は headless では画面に出ない。出ないものは検証できないので、
    // 引っかかった判定は必ずファイルにも残す。
    try {
      appendFileSync(
        join(getAgentDir(), "foreman-gate.log"),
        `${JSON.stringify({ at: new Date().toISOString(), mode, tool: event.toolName, reason, scores: verdict.scores })}\n`,
      );
    } catch {
      // 書けなくても判定は続ける
    }

    if (mode === "shadow") {
      ctx.ui.notify(`gate: ${reason}`, "warning");
      ctx.ui.setStatus("gate", `gate: ${reason}`);
      return;
    }

    // enforce。確認が出せない headless では止めずに警告に落とす
    if (!ctx.hasUI) {
      ctx.ui.notify(`gate: ${reason} (確認できないため実行します)`, "warning");
      return;
    }
    const allow = await ctx.ui.confirm("gate", `${reason}\n実行しますか?`);
    if (!allow) return { block: true, reason };
  });

  pi.registerCommand("gate", {
    description: "安全弁の状態表示と切り替え (shadow / enforce / on / off)",
    handler: async (args, ctx) => {
      const sub = args.trim();
      if (sub === "on" || sub === "off") enabled = sub === "on";
      else if (sub === "shadow" || sub === "enforce") mode = sub;
      else if (sub) {
        ctx.ui.notify("使い方: /gate [on|off|shadow|enforce]", "warning");
        return;
      }
      ctx.ui.notify(
        `gate: ${enabled ? mode : "off"} / 判定対象 ${JUDGED_TOOLS.join(", ")} / キャッシュ ${cache.size}`,
        "info",
      );
    },
  });
}
