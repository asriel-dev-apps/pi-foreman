# pi-foreman

着手前にタスクを見立てて、進め方の助言を [pi](https://github.com/earendil-works/pi) に注入する。
判定は [TypeSafe の jev](https://docs.typesafe.ai)。散文ではなく確率が返るので、分岐できる。

設計の根拠は [docs/adr/0001-jev-routing-layer.md](docs/adr/0001-jev-routing-layer.md)。

## 構成

| ファイル | 役割 |
|---|---|
| `src/foreman.ts` | 質問文・閾値・ルール表。**ここが成果物本体**。pi に依存しない |
| `extensions/foreman.ts` | pi への配線。state を組んで注入するだけ |
| `scripts/check.ts` | ルール表の検査。ネットワーク不要 |
| `scripts/fixtures-check.ts` | 質問文が意図どおり効くかを jev に実際に問う。質問文を触ったら必ず回す |
| `scripts/backtest.ts` | 過去の Claude Code セッションを正解ラベルに突き合わせる |

```bash
npm run check                      # ルール表
TYPESAFE_API_KEY=... npm run fixtures   # 質問文
TYPESAFE_API_KEY=... npm run backtest   # 過去ログとの一致
```

API キーは環境変数からのみ読む。追跡ファイルには置かない。

## 使う

```bash
pi -e .
```

## いまの状態

質問文はフィクスチャ 11/11 通過。拡張は `before_agent_start` での注入と
`agent_settled` での宣告まで。実際の pi での動作確認が次。

着手前ルーティングが効く冒頭プロンプト (仕事が書かれている冒頭) は、過去ログでは
153 セッション中 6 件だった。残りは継続の合図か、定型コマンドか、起こされただけの通知。
判定材料のない冒頭では黙るのが正しい挙動なので、これは欠陥ではないが、
この層が効く場面は思ったより狭いという前提で見ること。
