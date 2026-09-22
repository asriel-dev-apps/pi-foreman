// 質問文・閾値・ルール表。ここがこのプロジェクトの成果物本体で、拡張は配線にすぎない。
// pi に依存しないこと: バックテストがこのモジュールを直接読む (ADR 0001 決定 4)。

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export const QUESTIONS = {
  size: {
    type: "score",
    instructions: "How large is this coding task?",
    criteria: [
      "a typo, a one-line edit, or a question that needs no code change",
      "a small self-contained change in one file",
      "a feature touching several files",
      "an architectural change, a migration, or multi-day work",
    ],
  },
  risky: {
    type: "noul",
    instructions:
      "Could the change this task makes lose data, leak secrets, break production, or otherwise be hard to undo? A task that only reads, explains, or investigates, and changes nothing, is not risky.",
  },
  // 「README の typo を直して」に 0.84 が出た実測を受けて、走らせて初めて見えるものに限定した。
  visual: {
    type: "noul",
    instructions:
      "Does this task change a graphical or terminal user interface that has to be run to be seen? Editing documentation, README files, comments, or data files is not a user interface.",
  },
  delegable: {
    type: "noul",
    // 「何かCLIツールを作りたい」のような漠然とした依頼が、文脈依存と同じ低スコアに潰れて
    // いたので、問いを「前の話に戻って参照しているか」だけに絞った。漠然としていることは
    // 委譲できないことではない。
    instructions:
      "Could someone who has not seen this conversation start working on this request? Answer no only if the request points back to something said earlier, such as a previous result, a running task, or a correction to prior work. A request that is vague but self-contained is still a yes.",
  },
  kind: {
    type: "choice",
    instructions: "What kind of work is this?",
    criteria: {
      docs: "writing or editing documentation, comments, reports, or explanations",
      security: "authentication, secrets, permissions, or anything an attacker would target",
      ui: "user-facing screens, layout, styling, or terminal interfaces",
      refactor: "restructuring existing code without changing what it does",
      infra: "build, deploy, CI, dependencies, or configuration",
      research: "investigating, comparing, or answering a question",
      other: "anything else, including ordinary bug fixes and new logic",
    },
  },
} as const;

export type Verdict = {
  size: number; // 0..3
  risky: number; // 0..1
  visual: number;
  delegable: number;
  kind: string;
  kindConfidence: number;
};

/** jev に一度だけ問う。異常系はすべて null (fail open) — ADR 0001 決定 5。 */
export async function ask(state: string, opts: { apiKey?: string; timeoutMs?: number } = {}): Promise<Verdict | null> {
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state, model: "jev-latest", questions: QUESTIONS }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (!res.ok) return null;
    const a = (await res.json())?.answers;
    if (!a?.size || !a?.kind) return null;
    return {
      size: a.size.score,
      risky: a.risky.noul,
      visual: a.visual.noul,
      delegable: a.delegable.noul,
      kind: a.kind.choice,
      kindConfidence: a.kind.confidence ?? 0,
    };
  } catch {
    return null;
  }
}

const SKILL_BY_KIND: Record<string, string> = {
  docs: "html-doc",
  security: "sec-scan",
  ui: "screen-proof",
  infra: "deploy-gating",
  research: "researcher に委譲して結論だけ受け取る",
};

/** 判定 → 助言の文面。純粋関数なのでネットワークなしで検査できる。 */
export function advise(v: Verdict): string[] {
  const lines: string[] = [];

  if (v.size < 0.5 && v.risky < 0.3) {
    lines.push("見立て: 些細なタスク。段取りを足さずそのまま直す。");
  } else {
    lines.push(
      `見立て: 規模 ${v.size.toFixed(1)}/3、取り返しのつかなさ ${(v.risky * 100) | 0}%。`,
    );
  }

  if (v.delegable >= 0.6 && v.size >= 1.0) {
    lines.push("委譲できる形をしている。ブリーフを書いてサブエージェントに渡すことを検討する。");
  }
  if (v.risky >= 0.5 || v.size >= 2.0) {
    lines.push("受け入れる前に独立したレビュー (rv) を回すこと。");
  }
  if (v.visual >= 0.6) {
    lines.push("画面を変える。実装直後に実画面を撮って目で確かめること。");
  }
  if (v.size >= 2.0) {
    lines.push("完了時に HTML 進捗レポートを残す規模。");
  }
  const skill = v.kindConfidence >= 0.5 ? SKILL_BY_KIND[v.kind] : undefined;
  if (skill) lines.push(`${v.kind} の仕事。${skill} が使えるか見ること。`);

  return lines;
}

/** 実装モデルの推奨。バックテストの対象外 (ADR 0001 検証方法)。 */
export function suggestModel(v: Verdict): "opus" | "sonnet" | "haiku" {
  if (v.size >= 2.0 || v.risky >= 0.5) return "opus";
  if (v.size < 0.5 && v.risky < 0.2) return "haiku";
  return "sonnet";
}
