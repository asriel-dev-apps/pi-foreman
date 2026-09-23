# pi-foreman

コーディングエージェントに、進め方の助言を出す。[pi](https://github.com/earendil-works/pi) の拡張と、Claude Code・Codex のフック。

- 依頼を受けたとき: 規模・危なさ・並列にできるかを見て、軽いタスクなら段取りを足さないよう言う
- rv や HTML レポートを始めようとしたとき（Claude Code・Codex のみ）: 軽いタスクや小さい差分なら、マイルストーンか確かめるよう言う。危ないパスに触れていれば 2 本目のレビュアーを勧める

依頼時の判定は [TypeSafe の jev](https://docs.typesafe.ai) に判定を頼む。jev は文章ではなく確率を返すので、値でそのまま分岐できる。

助言だけで、何も止めない。

## Usage

Node 23.6 以降と [TypeSafe の API キー](https://console.typesafe.ai/keys)が要る。

```bash
security add-generic-password -a "$USER" -s typesafe-api-key -w   # macOS: キーチェーンに保存 (値は対話で入力)
pi -e /path/to/pi-foreman
```

キーは環境変数 `TYPESAFE_API_KEY` からも読む。macOS ではキーチェーンを勧める。環境変数に置くと、
エージェントが走らせる全コマンドにキーが渡る。

- キーがなければ何もしない。エラーも出ないし pi はそのまま動く
- 常時使うなら `~/.pi/agent/extensions/` に 1 行のファイルを置く

```ts
// ~/.pi/agent/extensions/foreman.ts
export { default } from "/path/to/pi-foreman/extensions/foreman.ts";
```

シンボリックリンクは不可。リンクの位置を基準に相対パスが解決され、`../src/` を見失う。

### Claude Code・Codex

`node /path/to/pi-foreman/bin/hook.ts` を `UserPromptSubmit` と `PreToolUse` のフックに登録する（タイムアウトは 5 秒以上）。
入出力の形は両者で同じなので、同じコマンドでよい。Codex は初回にフックの信頼を承認する。

## foreman

依頼文とリポジトリの状態から、こういう段落を差し込む。

```
着手前の見立て (助言であって指示ではない。合わないと思ったら従わなくてよい):
- 見立て: 規模 1.7/3、取り返しのつかなさ 69%。
- フローに乗せる変更。受け入れテストで DoD を決めてから実装し、rv と HTML レポートはマイルストーンで。
- 取り返しがつきにくい。マイルストーンの rv に 2 本目のレビュアーを足す。
- 実装モデルの推奨: opus
```

jev に聞くのは規模・取り返しのつかなさ・画面を変えるか・委譲できるか・並列にできるか・仕事の種類の 6 つだけ。
そこから先の文面は `src/foreman.ts` のルール表が決めるので、自分の進め方に合わせて書き換える。

## Privacy

`api.typesafe.ai` へ送るかどうか・何を送るかは、対象リポジトリの `AGENTS.md` の `Jev:` 行で決まる。

| `Jev:` | 送るもの |
|---|---|
| 無し（既定）、git の外 | 何も送らない。依頼文に当たる語彙（`fix` `ui` `auth` など）を手元のルール表で判定する |
| `full` | 依頼文の全文、リポジトリ名、`Tier:`、未コミットのファイル数と拡張子 |
| `off` | 何も送らない |

- 既定では何も送らない。語彙だけを jev に送る方式も試したが、手元のルール表より当たらなかった（見ていない例で 5/12 対 6/12、全文なら 10/12）
- 差分・パス・ファイルの中身は、どのモードでも送らない。rv や HTML の入口での判断は手元だけで行う
- ログ（`~/.local/state/foreman/log.jsonl`）には判定の数値だけを残す
- API キーは環境変数か macOS のキーチェーンから読む。追跡ファイルには書かない

## 質問文を変えるとき

1 語変えるだけで別の項目のスコアが動く。触ったら必ず回すこと。

```bash
npm run check                          # ルール表（ネットワーク不要）
npm run fixtures  # 質問文を jev に実際に問う
npm run fixtures -- --mode facts --holdout  # 既定の送り方で、語彙を作るときに見ていない例
```

`tests/fixtures.json` には通ってほしい例と引っかかってほしくない例の両方が入っている。
誤りを見つけたら、直す前にまず例として足す。
