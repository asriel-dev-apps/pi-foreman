# pi-foreman

[pi](https://github.com/earendil-works/pi) に 2 つの層を足す。判定は
[TypeSafe の jev](https://docs.typesafe.ai)。散文ではなく確率が返るので、分岐できる。

- **foreman** — 着手前に 1 回、タスクを見立てて進め方の助言を注入する
- **gate** — ツール実行の直前に、危ない操作を知らせる

```bash
pi -e .
```

## 構成

| ファイル | 役割 |
|---|---|
| `src/foreman.ts` | 見立ての質問文・閾値・ルール表。**成果物本体**。pi に依存しない |
| `src/gate.ts` | 安全弁の質問文と、jev に聞かずに確定させる事実 |
| `extensions/foreman.ts` | `before_agent_start` で注入、`agent_settled` で宣告 |
| `extensions/gate.ts` | `tool_call` で判定。既定は shadow、`/gate enforce` で確認を出す |

```bash
npm run check                          # ルール表と安全弁 (ネットワーク不要)
TYPESAFE_API_KEY=... npm run fixtures  # 質問文を jev に実際に問う
TYPESAFE_API_KEY=... npm run gate:live # jev 単独の評決と、事実を併せた評決を比べる
TYPESAFE_API_KEY=... npm run backtest  # 過去の Claude Code セッションと突き合わせる
```

## 何が外に出るか

判定のたびに `api.typesafe.ai` へ送るもの:

| 層 | 送るもの | 送らないもの |
|---|---|---|
| foreman | ユーザーのプロンプト全文、リポジトリ名、`AGENTS.md` の先頭数行、未コミットのファイル数 | ファイルの中身 |
| gate | ツール名、引数 (400 文字まで)、依頼文の先頭 1200 文字、手元で調べた事実 | ファイルの中身（長さと行数に置き換える）。読むだけのコマンドは判定そのものを送らない |

**`bash` のコマンド文字列は 400 文字までそのまま送られる。** `curl -H "Authorization: Bearer …"`
のようなコマンドを判定させると、そのトークンが外に出る。

**プロンプト本文もそのまま送られる。** 秘密や社外秘を含む依頼をする環境では、この層を
切るか、送る前に落とす仕組みが要る。API キーは環境変数 `TYPESAFE_API_KEY` からのみ読み、
追跡ファイルには置かない。

## いまの状態

- 質問文のフィクスチャ 15/15 通過。`pi -e .` で実際に注入されることを確認済み
- 安全弁は pi の `tool_call` 経由で `bash` と `write` の両方で発火することを実機で確認済み。
  引っかかった判定は `~/.pi/agent/foreman-gate.log` に 1 行ずつ残る（shadow の通知は
  headless では画面に出ないため）
- 着手前ルーティングが効く冒頭プロンプト（仕事が書かれている冒頭）は、過去ログでは
  153 セッション中 6 件だった。判定材料のない冒頭で黙るのは正しい挙動だが、
  この層が効く場面は狭い
