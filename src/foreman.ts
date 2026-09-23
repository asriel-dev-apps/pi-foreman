import { execFileSync } from "node:child_process";

// 質問文・閾値・ルール表。ここがこのプロジェクトの成果物本体で、拡張は配線にすぎない。
// pi に依存しないこと: バックテストがこのモジュールを直接読む (ADR 0001 決定 4)。

// FOREMAN_ENDPOINT はテストのスタブ用 (ADR 0003)。
const ENDPOINT = () => process.env.FOREMAN_ENDPOINT || "https://api.typesafe.ai/v1/systemone";

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
    // 第1案は「data files は UI ではない」と書いていた。すると「ロケール JSON を変えて
    // 画面の文言を直して」が 0.50 に沈む。編集するファイルの種類ではなく、終わったあとに
    // 人が画面で見るものが変わるかを問うのが正しい。
    instructions:
      "Will a person see a different screen when the program runs after this task? Say yes only if the layout, wording, colours, or components of a graphical or terminal interface change. Say no for work on data, storage, server behaviour, or documentation that leaves the displayed screens as they are.",
  },
  delegable: {
    type: "noul",
    // 「何かCLIツールを作りたい」のような漠然とした依頼が、文脈依存と同じ低スコアに潰れて
    // いたので、問いを「前の話に戻って参照しているか」だけに絞った。漠然としていることは
    // 委譲できないことではない。
    instructions:
      "Could someone who has not seen this conversation start working on this request? Answer no only if the request points back to something said earlier, such as a previous result, a running task, or a correction to prior work. A request that is vague but self-contained is still a yes.",
  },
  // 判定点 2 (ADR 0003)。サブエージェントを並べる価値があるかだけを問う。
  parallel: {
    type: "noul",
    instructions:
      "Does this task split into two or more independent pieces of work that different people could do at the same time without waiting on each other? Say no for a single change, a question, or steps that must happen in order.",
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
  parallel: number;
  kind: string;
  kindConfidence: number;
};

/**
 * API キー。環境変数が無ければ macOS のキーチェーン (サービス名 typesafe-api-key) から読む。
 * 環境変数に置くとエージェントが走らせる全コマンドに渡るので、キーチェーンを勧める。
 */
export function readApiKey(): string | undefined {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  if (process.platform !== "darwin") return undefined;
  try {
    return execFileSync("security", ["find-generic-password", "-s", "typesafe-api-key", "-w"], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** jev に一度だけ問う。異常系はすべて null (fail open) — ADR 0001 決定 5。 */
export async function ask(state: string, opts: { apiKey?: string; timeoutMs?: number } = {}): Promise<Verdict | null> {
  const apiKey = opts.apiKey ?? readApiKey();
  if (!apiKey) return null;
  try {
    const res = await fetch(ENDPOINT(), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state, model: "jev-latest", questions: QUESTIONS }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
    });
    if (!res.ok) return null;
    const a = (await res.json())?.answers;
    // HTTP 200 でも欠けたり型が違ったりし得る。組み立てる前に全部確かめる。
    // ここで通してしまうと advise() の toFixed が before_agent_start の中で例外になり、
    // fail open のはずの層がターンを落とす。
    const num = (v: unknown, max: number) =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined;
    const size = num(a?.size?.score, 3);
    const risky = num(a?.risky?.noul, 1);
    const visual = num(a?.visual?.noul, 1);
    const delegable = num(a?.delegable?.noul, 1);
    const parallel = num(a?.parallel?.noul, 1);
    const kind = typeof a?.kind?.choice === "string" ? a.kind.choice : undefined;
    if (size === undefined || risky === undefined || visual === undefined || delegable === undefined || parallel === undefined || !kind) {
      return null;
    }
    return { size, risky, visual, delegable, parallel, kind, kindConfidence: num(a.kind.confidence, 1) ?? 0 };
  } catch {
    return null;
  }
}

/**
 * 仕事の種類ごとの一言。ここは各自の道具立てに置き換えて使うところで、
 * 手元の skill 名やコマンド名を入れると助言が具体的になる。
 */
const ADVICE_BY_KIND: Record<string, string> = {
  docs: "読み手が誰かを先に決めてから書く。",
  security: "公開・送信する値に、出してはいけないものが混ざらないか確かめる。",
  ui: "実装したら実画面を見る。テストもレビューも画面は見ていない。",
  infra: "壊れたときに戻す手順を先に用意する。",
  research: "調べる量が多いなら、別のエージェントに任せて結論だけ受け取る。",
};

/** 軽いタスク: サブエージェントも rv も HTML も要らない (判定点 1)。 */
export const isLight = (v: Pick<Verdict, "size" | "risky">) => v.size < 0.5 && v.risky < 0.3;

/** 判定 → 助言の文面。純粋関数なのでネットワークなしで検査できる。 */
export function advise(v: Verdict): string[] {
  const lines: string[] = [];

  if (isLight(v)) {
    lines.push("見立て: 軽いタスク。自分でそのまま直してチャットで報告する。サブエージェント・rv・HTML レポートは要らない。");
  } else {
    lines.push(
      `見立て: 規模 ${v.size.toFixed(1)}/3、取り返しのつかなさ ${(v.risky * 100) | 0}%。`,
    );
    if (v.size >= 1.0) {
      lines.push("フローに乗せる変更。受け入れテストで DoD を決めてから実装し、rv と HTML レポートはマイルストーンで。");
    }
  }

  if (v.parallel >= 0.6 && v.size >= 1.0) {
    lines.push("独立した部分に分かれる。並列にサブエージェントへ渡すことを検討する。");
  } else if (v.delegable >= 0.6 && v.size >= 2.0) {
    lines.push("重く、委譲できる形をしている。ブリーフを書いてサブエージェントに渡すことを検討する。");
  }
  if (v.risky >= 0.5) {
    lines.push("取り返しがつきにくい。マイルストーンの rv に 2 本目のレビュアーを足す。");
  }
  if (v.visual >= 0.6) {
    lines.push("画面を変える。実装直後に実画面を撮って目で確かめること。");
  }
  const kindAdvice = v.kindConfidence >= 0.5 ? ADVICE_BY_KIND[v.kind] : undefined;
  if (kindAdvice) lines.push(`${v.kind} の仕事。${kindAdvice}`);

  return lines;
}

/** 実装モデルの推奨。バックテストの対象外 (ADR 0001 検証方法)。 */
export function suggestModel(v: Verdict): "opus" | "sonnet" | "haiku" {
  if (v.size >= 2.0 || v.risky >= 0.5) return "opus";
  if (v.size < 0.5 && v.risky < 0.2) return "haiku";
  return "sonnet";
}
