// node scripts/fixtures-check.ts — 質問文が意図どおりに効いているかを jev に実際に問う。
// TYPESAFE_API_KEY が要る。質問文を触ったら必ず回すこと。
import { readFileSync } from "node:fs";
import { ask, type Verdict } from "../src/foreman.ts";

type Fixture = {
  state: string;
  note?: string;
  expect: Record<string, [string, number]>;
};

const fixtures: Fixture[] = JSON.parse(
  readFileSync(new URL("../tests/fixtures.json", import.meta.url), "utf8"),
);

let failed = 0;
for (const f of fixtures) {
  const v = await ask(f.state);
  if (!v) {
    console.error(`SKIP ${f.state} (判定が返らなかった)`);
    failed++;
    continue;
  }
  const bad: string[] = [];
  for (const [key, [op, bound]] of Object.entries(f.expect)) {
    const got = v[key as keyof Verdict] as number;
    const ok = op === "<" ? got < bound : got > bound;
    if (!ok) bad.push(`${key}=${got.toFixed(2)} (expected ${op}${bound})`);
  }
  const shown = `size=${v.size.toFixed(2)} risky=${v.risky.toFixed(2)} visual=${v.visual.toFixed(2)} delegable=${v.delegable.toFixed(2)} kind=${v.kind}`;
  if (bad.length) {
    failed++;
    console.log(`FAIL ${f.state}\n     ${shown}\n     ${bad.join(", ")}`);
  } else {
    console.log(`ok   ${f.state}\n     ${shown}`);
  }
}

console.log(failed ? `\n${failed}/${fixtures.length} failed` : `\n${fixtures.length}/${fixtures.length} ok`);
process.exit(failed ? 1 : 0);
