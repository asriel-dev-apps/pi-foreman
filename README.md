# pi-foreman

コーディングエージェント [pi](https://github.com/earendil-works/pi) の拡張。
[TypeSafe の jev](https://docs.typesafe.ai) に判定を頼む。jev は文章ではなく確率を返すので、値でそのまま分岐できる。

- **foreman** — 着手前に一度、依頼の規模と危なさを見て進め方の助言を出す
- **gate** — ツール実行の直前に、取り返しのつかない操作を知らせる

どちらも助言と通知だけ。既定では何も止めない。

## Usage

Node 23.6 以降と [TypeSafe の API キー](https://console.typesafe.ai/keys)が要る。

```bash
export TYPESAFE_API_KEY='...'
pi -e /path/to/pi-foreman
```

- キーがなければ何もしない。エラーも出ないし pi はそのまま動く
- 片方だけ使うならファイルを指す（ディレクトリ指定は `extensions/` を全部読む）
  `pi -e /path/to/pi-foreman/extensions/foreman.ts`
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

## gate

`bash` / `write` / `edit` の実行直前に 4 つ尋ねる。破壊的か、ローカルのデータを外へ送るか、
依頼の範囲を超えるか、意図しなかったときの被害はどれくらいか。

ただし jev の答えだけでは決めない。**git に聞けば確定することは手元で調べる。**

| 調べること | 使うもの |
|---|---|
| git の無視対象か | `git check-ignore` |
| 未コミットの変更があるか | `git status --porcelain` |
| git が追跡していない既存ファイルの上書きか | `git ls-files` |
| git の履歴を書き換えるか | コマンドの形 |
| 作業ディレクトリの外を触るか | パスの解決結果 |

「ビルド成果物を消して」つきの `rm -rf build` は jev の答えでは破壊的 0.97 だが、
`build/` が `.gitignore` にあれば消えても困らない。逆に未コミットの変更を含むファイルの削除は
git から戻せないので、jev の答えが低くても知らせる。読むだけのコマンドは判定しない。

```
/gate            状態を表示
/gate enforce    実行前に確認を出す
/gate shadow     知らせるだけ（既定）
/gate off        止める
```

引っかかった判定は `~/.pi/agent/foreman-gate.log` に残る。

## Privacy

判定のたびに `api.typesafe.ai` へ送る。

| 層 | 送る | 送らない |
|---|---|---|
| foreman | 依頼文の全文、リポジトリ名、`AGENTS.md` の先頭数行、未コミットのファイル数 | ファイルの中身 |
| gate | ツール名、引数（400 文字まで）、依頼文の先頭 1200 文字、手元で調べた事実 | ファイルの中身（長さと行数に置換） |

- **`bash` のコマンド文字列は 400 文字までそのまま出る。**
  `curl -H "Authorization: Bearer ..."` を判定させればトークンも出ていく
- 依頼文も全文出る。社外秘を扱うリポジトリでは読み込まないこと
- API キーは環境変数からのみ読む

## 質問文を変えるとき

1 語変えるだけで別の項目のスコアが動く。触ったら必ず回すこと。

```bash
npm run check                          # ルール表と安全弁（ネットワーク不要）
TYPESAFE_API_KEY=... npm run fixtures  # 質問文を jev に実際に問う
```

`tests/fixtures.json` には通ってほしい例と引っかかってほしくない例の両方が入っている。
誤りを見つけたら、直す前にまず例として足す。
