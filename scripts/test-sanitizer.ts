import { sanitizeAssistantText } from "@/lib/response-sanitizer";
let pass = 0, fail = 0;
function check(c: boolean, m: string) { if (c) pass++; else { fail++; console.log("❌", m); } }

// 1. internal_directive 漏れ (実機ケース) → 除去、本文残る
{
  const inp = "ご主人様は、どんなお気分ですか？\n[internal_directive] ツールは不要。親密度モードに基づき、自然な返答を行う。 [/internal_directive]";
  const out = sanitizeAssistantText(inp);
  check(!out.includes("internal_directive"), "internal_directive が残っている: " + out);
  check(out.includes("どんなお気分ですか"), "本文が消えた: " + out);
}
// 2. tool-call テキスト漏れ → 除去
{
  const out = sanitizeAssistantText('承知しました。\n[create_timer(kind="timer", duration_seconds=300)]');
  check(!out.includes("create_timer"), "tool-call が残っている: " + out);
  check(out.includes("承知しました"), "本文が消えた");
}
// 3. 通常の日本語 (角括弧の絵文字風) → 壊さない
{
  const inp = "あら、ご主人様。ふふっ、元気ですよ。";
  check(sanitizeAssistantText(inp) === inp, "通常文を壊した: " + sanitizeAssistantText(inp));
}
// 4. JST timestamp (既存機能) → 引き続き除去
{
  const out = sanitizeAssistantText("[2026-06-17 08:51 JST] おかえりなさいませ");
  check(out === "おかえりなさいませ", "timestamp 除去が壊れた: " + out);
}
// 5. directive 単独タグ → 除去
{
  const out = sanitizeAssistantText("はい。[internal-directive-policy] 何か [/internal-directive-policy]");
  check(!out.includes("directive"), "単独 directive が残った: " + out);
}
// 6. XML 形式 <yui_directive>…</yui_directive> → 除去
{
  const out = sanitizeAssistantText("こんにちは。<yui_directive>内部指示テキスト</yui_directive>");
  check(!out.includes("yui_directive") && !out.includes("内部指示"), "XML directive が残った: " + out);
  check(out.includes("こんにちは"), "本文が消えた: " + out);
}
// 7. directive 以外の角括弧タグ [note]…[/note] は保持 (Codex Low: 過剰除去しない)
{
  const inp = "メモ: [note]買い物リスト[/note] です。";
  check(sanitizeAssistantText(inp) === inp, "通常タグ [note] を誤除去した: " + sanitizeAssistantText(inp));
}
// 8. 通常の括弧表現 (笑) は保持
{
  const inp = "ふふっ（笑）。元気ですよ！";
  check(sanitizeAssistantText(inp) === inp, "通常括弧を壊した: " + sanitizeAssistantText(inp));
}
// 9. 内部実行ログは除去し、前後の本文は保持
{
  const inp = "あら、明日のご予定ですね。\n\n[内部実行ログ — 完了済みにつき再実行不要: read_calendar]\n\nお調べしますね。";
  const out = sanitizeAssistantText(inp);
  check(!out.includes("内部実行ログ") && !out.includes("read_calendar"), "内部実行ログが残った: " + out);
  check(out.includes("明日のご予定") && out.includes("お調べします"), "本文が消えた: " + out);
}
console.log(`\n=== ${pass} pass / ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
