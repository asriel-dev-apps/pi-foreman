# ADR 0003: Claude Code と Codex への展開、判定点、送る内容

- Status: Accepted
- Date: 2026-09-23
- 対象: ADR 0001 が対象外にした claude / codex への展開と、TypeSafe に送る内容

## 背景

使っている開発フローには、進め方を決める判断が 5 か所ある。

1. 依頼を受けたとき: 軽いタスクか、フロー（テスト → 実装 → マイルストーンで rv）に乗せる変更か
2. 実装に入る前: 重いか、独立した部分に分かれて並列にできるか
3. 増分が終わったとき: マイルストーンか（rv と HTML 進捗レポートはマイルストーンだけ）
4. rv を始めるとき: データ消失・秘匿値・移行・並行実行に触れるか（触れるなら 2 本目のレビュアー）
5. rv が矛盾を見つけたとき: ユーザーが決めた要件か、技術的な選択か

困っているのは、rv や HTML レポートが要らない場面で出てくること。入口は 1 と 3。

もう一つの前提として、ADR 0001 の foreman は依頼文を全文 TypeSafe に送る。TypeSafe の
プライバシーポリシーは、入力を収集し学習には使わないと書くが、保持期間は書いていない。
社外秘を扱うリポジトリでは、依頼文そのものを外に出せない。

## 決定

### 1. jev に問うのは判定点 1 と 2 だけ。3・4 は手元の事実とルール、5 は作らない

| 判定点 | 何で決めるか | 理由 |
|---|---|---|
| 1 軽いか | jev（`size` `risky` `visual` `delegable` `kind`） | 入力が自然文。jev が得意なところ |
| 2 重いか・並列か | jev（`size` と新しい `parallel`）。1 と同じ 1 往復 | 入力が 1 と同じ |
| 3 マイルストーンか | 1 で保存した見立て + 差分の大きさ | 入力は差分。差分やパスを送ると、どのリポジトリでもコードが出る |
| 4 危ない変更か | 変更パスのルール（migration・sql・auth・secret・lock など） | 同上。パスのルールで決まることを推測させない（ADR 0002 と同じ考え） |
| 5 要件か選択か | 作らない | フック点が無く、判定対象は repo の中身。review skill がユーザー由来の要件をユーザーに上げる手順を既に持つ |

### 2. Claude Code と Codex は同じスクリプト 1 本で受ける

両者のフックは入力（`hook_event_name` `session_id` `cwd` `prompt` `tool_name` `tool_input`）と、
文脈を足す出力（`hookSpecificOutput.additionalContext`）の形が同じ（2026-09-23 に両者の公式文書で確認）。

`node bin/hook.ts` が標準入力で 1 件受け、必要なら次の JSON を 1 つ標準出力に書く。常に終了コード 0。

```json
{"hookSpecificOutput":{"hookEventName":"<受けたイベント名>","additionalContext":"<助言>"}}
```

- `UserPromptSubmit`: 判定点 1・2。見立てを `$TMPDIR/foreman/<session_id>.json` に保存し、助言を返す
- `PreToolUse`: 判定点 3・4。rv か HTML レポートの入口に当たったときだけ助言を返す
- それ以外のイベント、壊れた入力、判定なし: 何も書かない

pi は拡張（`extensions/foreman.ts`）のまま。判定点 1・2 だけを持つ。

### 3. rv と HTML レポートの入口はすべて拾う

1 か所だけ見ても、別の経路から同じことが起きる。入口を列挙した。

| 何が起きるか | 入口 | 拾い方 |
|---|---|---|
| rv | Claude の `Skill`（skill 名 `review`） | `tool_name` と `tool_input.skill` |
| rv | Bash で別 family のレビュアーを起動（`codex exec` / `claude -p`、herdr の `pane run` 経由も含む） | コマンドが review skill の `rv-brief` を含み、かつ `codex … exec` か `claude -p` を含む |
| HTML | `Write` / `Edit` の `file_path`、Codex の `apply_patch` のパッチ本文 | `reports/….html` を含む |
| HTML | Bash のリダイレクトや `tee` | 書き込み先が `reports/….html` |
| HTML | Claude の `reporter` エージェント | `tool_name` が `Agent`、`subagent_type` が `reporter`（Codex には reporter エージェントが無いので対象外） |

読むだけの操作（`Read`、`cat`、`open`）は拾わない。

助言は 1 セッションにつき 1 回まで。数える単位は「rv 入口での判定点 3」「HTML 入口での判定点 3」「判定点 4」の 3 つ。
同じ助言を繰り返すと読まれなくなる。`UserPromptSubmit` を経ていないセッション（見立てなし）では、差分の大きさと
パスだけで判定する。差分とパスは cwd が属するリポジトリで数え、未追跡ファイルは行数を足す。

判定点 3 の助言は、rv か HTML の入口で、次のどちらかのときに出す。文面に「マイルストーン」を含む。

- 保存した見立てが軽いタスク（`size < 0.5` かつ `risky < 0.3`）
- 差分が小さい: 基点からの追加行と削除行の合計（未コミット・未追跡を含む）が 20 行以下。バイナリと
  1MB 以上の未追跡ファイルは大きさ不明として 1000 行に数える。基点は `@{upstream}`、`origin/HEAD`、
  `origin/main`、`origin/master`、`main`、`master` の順に merge-base を取り、HEAD と異なる最初のもの
  （今いるブランチ自身を基点にすると、コミット済みの作業が消える）。どれも HEAD と同じなら HEAD、
  コミットが無ければ空の木

判定点 4 の助言は rv の入口でだけ、変更パス（基点からの差分と未コミット）のどれかが次に当たったときに出す。
文面に「2 本目のレビュアー」と、当たったパスを 3 件まで含む（パスは手元に出すだけで、送らない）。

```
/migrat|\.sql$|schema|auth|secret|credential|token|crypt|lock|mutex|concurren|queue|worker/i
```

判定点 1・2 の助言は、軽いタスクなら「軽いタスク」を含み、rv・HTML・サブエージェントが要らないことを言う。

jev の応答は `{"answers": {"size": {"score"}, "risky": {"noul"}, "visual": {"noul"}, "delegable": {"noul"},
"parallel": {"noul"}, "kind": {"choice", "confidence"}}}`。欠けたり範囲外なら判定なしとして扱う。
送り先は環境変数 `FOREMAN_ENDPOINT` で差し替えられる（テスト用）。

### 4. 送る内容は、閉じた側を既定にする

対象リポジトリの `AGENTS.md` にある `Jev:` 行で決める。

| `Jev:` | 送るもの |
|---|---|
| `full` | 依頼文の全文と、リポジトリの事実（名前・`Tier:`・未コミットのファイル数と拡張子） |
| `off` | 何も送らない。判定点 1・2 の助言は出ない |
| 無い・それ以外・git リポジトリの外 | **射影**だけ（下記） |

**射影**は、依頼文を固定の語彙に写したもの。依頼文に当たった語彙の名前（`fix` `ui` `auth` など）、
文字数の区分、未コミットのファイル数、拡張子（既知の拡張子の一覧に載るものだけ。拡張子の無いファイル名が
そのまま出る穴がレビューで見つかった）、`Tier:` の値
（`poc` `product` `none` のどれかのときだけ）を並べる。リポジトリ名もパスも入れない。

**射影に出るのは、このリポジトリに書いた語彙と数字だけなので、依頼文の中身は構造上出ない。**
伏せ字（固有名詞を消す）や LLM による要約は漏れを減らすが、漏れないことは示せないので採らない。

`Visibility: private` は社外秘を意味しないので、送る範囲の判断には使わない。

### 5. 射影は、ルール表に勝つときだけ残す

射影にすると jev の材料は語彙の集まりになり、同じ語彙を読む素朴なルール表で足りるかもしれない。
`npm run fixtures -- --mode full|facts|rules` で 3 通りを同じフィクスチャに掛ける。

- `full`: 全文を jev に（対照）
- `facts`: 射影を jev に
- `rules`: 射影をルール表で（jev を呼ばない）

`facts` が `rules` より通る件数が多くなければ、射影モードでは jev を呼ばずルール表を使う。
語彙はフィクスチャを見て作ったので、件数には過学習が含まれる。個々の食い違いを読む。

## 検証方法 (DoD)

- `npm run check` がネットワーク無しで緑（ルール表、射影、フックの入出力）
- フックの受け入れテスト: スタブのエンドポイント（`FOREMAN_ENDPOINT`）で、射影モードの送信本文に依頼文が含まれないこと、
  `Jev: off` で送信が起きないこと、入口ごとに助言が出ること・出ないことを確かめる
- `npm run fixtures -- --mode ...` の 3 通りの結果（キーが要る）
- 登録後、実際のセッションで助言が文脈に届くこと（Claude はトランスクリプトの system reminder、Codex は developer context）。
  フックが 0 で終わったことは、届いたことの証拠にならない

## 運用上の前提

- フックの登録は各ハーネスの設定ファイルで行う。Codex は初回に hook の信頼を承認する
- API 呼び出しのタイムアウトは 3 秒、git 1 回あたり 1.5 秒。フック自体のタイムアウトは 5 秒以上にする（`UserPromptSubmit` はタイムアウトすると出力が捨てられる）
- ログには見立ての数値だけを残し、依頼文も射影も `kind` も残さない（`~/.local/state/foreman/log.jsonl`）
