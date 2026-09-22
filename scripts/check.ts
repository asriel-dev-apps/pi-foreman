// node scripts/check.ts — ネットワークなしでルール表を検査する。
import assert from "node:assert";
import { advise, suggestModel, type Verdict } from "../src/foreman.ts";

const v = (o: Partial<Verdict> = {}): Verdict => ({
  size: 0,
  risky: 0,
  visual: 0,
  delegable: 0,
  kind: "other",
  kindConfidence: 1,
  ...o,
});

const joined = (o: Partial<Verdict>) => advise(v(o)).join("\n");

// 些細なタスクには段取りを足さない
const trivial = joined({ size: 0.0, risky: 0.04, visual: 0.05, delegable: 0.75 });
assert.match(trivial, /些細/);
assert.doesNotMatch(trivial, /rv|レポート|実画面/);

// 危ないタスクは規模が小さくても rv を要求する
assert.match(joined({ size: 1.31, risky: 0.87 }), /rv/);

// 画面を変えるタスクは実画面の確認を要求する
assert.match(joined({ size: 1.7, visual: 0.97 }), /実画面/);
assert.doesNotMatch(joined({ size: 1.7, visual: 0.2 }), /実画面/);

// 大きいタスクは rv とレポートの両方
const big = joined({ size: 2.4, delegable: 0.8 });
assert.match(big, /rv/);
assert.match(big, /レポート/);
assert.match(big, /委譲/);

// kind の確信が低いときは skill を勧めない
assert.doesNotMatch(joined({ kind: "security", kindConfidence: 0.3 }), /sec-scan/);
assert.match(joined({ kind: "security", kindConfidence: 0.9 }), /sec-scan/);

assert.equal(suggestModel(v({ size: 0.0, risky: 0.04 })), "haiku");
assert.equal(suggestModel(v({ size: 1.3, risky: 0.87 })), "opus");
assert.equal(suggestModel(v({ size: 1.3, risky: 0.1 })), "sonnet");

console.log("ok");
