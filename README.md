# pi-foreman

コーディングエージェント [pi](https://github.com/earendil-works/pi) の拡張。着手前に一度、依頼の規模と危なさを見て進め方の助言を出す。
[TypeSafe の jev](https://docs.typesafe.ai) に判定を頼む。jev は文章ではなく確率を返すので、値でそのまま分岐できる。

助言だけで、何も止めない。

## Usage

Node 23.6 以降と [TypeSafe の API キー](https://console.typesafe.ai/keys)が要る。

```bash
export TYPESAFE_API_KEY='...'
pi -e /path/to/pi-foreman
```

- キーがなければ何もしない。エラーも出ないし pi はそのまま動く
- 常時使うなら `~/.pi/agent/extensions/` に 1 行のファイルを置く

```ts
// ~/.pi/agent/extensions/foreman.ts
export { default } from "/path/to/pi-foreman/extensions/foreman.ts";
```

シンボリックリンクは不可。リンクの位置を基準に相対パスが解決され、`../src/` を見失う。

## foreman

依頼文とリポジトリの状態から、こういう段落を差し込む。

```
着手前の見立て (助言であって指示ではない。合わないと思ったら従わなくてよい):
- 見立て: 規模 1.7/3、取り返しのつかなさ 69%。
- 受け入れる前に独立したレビュー (rv) を回すこと。
- 実装モデルの推奨: opus
```

jev に聞くのは規模・取り返しのつかなさ・画面を変えるか・委譲できるか・仕事の種類の 5 つだけ。
そこから先の文面は `src/foreman.ts` のルール表が決めるので、自分の進め方に合わせて書き換える。

## Privacy

判定のたびに `api.typesafe.ai` へ送る。

| 送る | 送らない |
|---|---|
| 依頼文の全文、リポジトリ名、`AGENTS.md` の先頭数行、未コミットのファイル数 | ファイルの中身 |

- 依頼文は全文出る。社外秘を扱うリポジトリでは読み込まないこと
- API キーは環境変数からのみ読む

## 質問文を変えるとき

1 語変えるだけで別の項目のスコアが動く。触ったら必ず回すこと。

```bash
npm run check                          # ルール表（ネットワーク不要）
TYPESAFE_API_KEY=... npm run fixtures  # 質問文を jev に実際に問う
```

`tests/fixtures.json` には通ってほしい例と引っかかってほしくない例の両方が入っている。
誤りを見つけたら、直す前にまず例として足す。
