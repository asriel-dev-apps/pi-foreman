// node scripts/fixtures-check.ts — 質問文が意図どおりに効いているかを jev に実際に問う。
// TYPESAFE_API_KEY が要る。質問文を触ったら必ず回すこと。
// --mode full (既定・対照) | facts (射影を jev に) | rules (射影をルール表で、キー不要) — ADR 0003 決定 5
import { readFileSync } from "node:fs";
import { ask, type Verdict } from "../src/foreman.ts";
import { buildState, rulesVerdict } from "../src/state.ts";

const at = process.argv.indexOf("--mode");
const mode = at >= 0 ? process.argv[at + 1] : "full";
if (!["full", "facts", "rules"].includes(mode)) throw new Error(`unknown mode: ${mode}`);
const judge = async (s: string) =>
  mode === "rules" ? rulesVerdict(s) : ask(mode === "facts" ? buildState(s, null, "facts")! : s);

type Fixture = {
  state: string;
  note?: string;
  /** ["<", 0.5] / [">", 0.6] は数値、["eq", "ui"] は kind の分類 */
  expect: Record<string, [string, number | string]>;
};

const fixtures: Fixture[] = JSON.parse(
  // --holdout: 語彙を作るときに見ていない例。射影の語彙はこれに合わせて直さないこと
  readFileSync(new URL(process.argv.includes("--holdout") ? "../tests/holdout.json" : "../tests/fixtures.json", import.meta.url), "utf8"),
);

let failed = 0;
for (const f of fixtures) {
  const v = await judge(f.state);
  if (!v) {
    console.error(`SKIP ${f.state} (判定が返らなかった)`);
    failed++;
    continue;
  }
  const bad: string[] = [];
  for (const [key, [op, bound]] of Object.entries(f.expect)) {
    const got = v[key as keyof Verdict];
    if (op === "eq") {
      if (got !== bound) bad.push(`${key}=${got} (expected ${bound})`);
      continue;
    }
    const n = got as number;
    const ok = op === "<" ? n < (bound as number) : n > (bound as number);
    if (!ok) bad.push(`${key}=${n.toFixed(2)} (expected ${op}${bound})`);
  }
  const shown = `size=${v.size.toFixed(2)} risky=${v.risky.toFixed(2)} visual=${v.visual.toFixed(2)} delegable=${v.delegable.toFixed(2)} parallel=${v.parallel.toFixed(2)} kind=${v.kind}`;
  if (bad.length) {
    failed++;
    console.log(`FAIL ${f.state}\n     ${shown}\n     ${bad.join(", ")}`);
  } else {
    console.log(`ok   ${f.state}\n     ${shown}`);
  }
}

console.log(`\n[${mode}] ${fixtures.length - failed}/${fixtures.length} ok`);
process.exit(failed ? 1 : 0);
