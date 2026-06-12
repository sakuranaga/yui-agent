/**
 * Notes N1 のテスト (= tsx ベース、test runner 未導入のため)。
 * lib/notes.ts の CRUD / chunk 分割 / browse / search / delete cascade を検証。
 *
 * Usage (container 内): npx tsx scripts/test-notes.ts
 * 成功で exit 0、失敗で exit 1。embedding service が無い場合は semantic 検証のみ skip。
 *
 * 注: scripts/** は eslint.config.mjs で lint 対象外 (= 全 dev スクリプト共通)。
 *     tsconfig include 対象なので `npm run typecheck` では型検査される。
 */
import { sql } from "@/db/client";
import {
  chunkText,
  createNote,
  deleteNote,
  getNote,
  queryNotes,
  updateNote,
} from "@/lib/notes";
import { saveNote } from "@/lib/tools/note/save_note";
import { subscribeSession, type ServerEvent } from "@/lib/jobs/events";
import type { ToolContext } from "@/lib/tools/types";

let passed = 0;
const failures: string[] = [];
function check(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

async function chunkCount(noteId: number): Promise<number> {
  const r = (await sql`SELECT count(*)::int AS c FROM note_chunks WHERE note_id = ${noteId}`) as unknown as Array<{ c: number }>;
  return r[0]?.c ?? 0;
}

async function main() {
  const created: number[] = [];
  try {
    // --- 1. chunkText (純粋関数) ---
    console.log("[1] chunkText");
    check(chunkText("").length === 0, "空文字 → 0 chunk");
    check(chunkText("短いメモ").length === 1, "短文 → 1 chunk");
    const long = "あ".repeat(2500);
    const longChunks = chunkText(long);
    check(longChunks.length >= 3, `2500 字 → ${longChunks.length} chunk (3 以上)`);
    check(longChunks.every((c) => c.length <= 1000), "各 chunk は 1000 字以下");

    // --- 2. createNote + chunk 生成 ---
    console.log("[2] createNote");
    const uniq = `ノートテスト用語_${passed}_xyzzy`;
    const note = await createNote({
      bodyMd: `# 打ち合わせメモ\n\n${uniq} について議論した。引っ越しの段取りを決める。`,
    });
    created.push(note.id);
    check(note.id > 0, "id 採番");
    check(note.title === "打ち合わせメモ", `title 自動生成 (= 先頭見出し): "${note.title}"`);
    const cc = await chunkCount(note.id);
    const embedOk = cc > 0;
    if (embedOk) check(cc >= 1, `note_chunks 生成 (${cc} 件)`);
    else console.log("  ⚠ embedding service 未稼働 → semantic 検証は skip");

    // --- 3. browse モード ---
    console.log("[3] browse モード (q なし)");
    const browse = await queryNotes({ limit: 50 });
    check(browse.mode === "browse", "mode=browse");
    check(browse.notes.some((n) => n.id === note.id), "作成ノートが一覧に出る");
    check(typeof browse.total === "number" && browse.total >= 1, `total=${browse.total}`);

    // --- 4. search モード (lexical は embed 不要) ---
    console.log("[4] search モード (q あり)");
    const search = await queryNotes({ query: uniq });
    check(search.mode === "search", "mode=search");
    check(search.notes.some((n) => n.id === note.id), "lexical FTS で作成ノートがヒット");
    check("searchTruncated" in search, "search 結果に searchTruncated フィールド");

    // --- 5. updateNote (再 embed) ---
    console.log("[5] updateNote");
    const updated = await updateNote(note.id, { bodyMd: `${uniq} 更新後の本文。`, pinned: true });
    check(updated?.pinned === true, "pinned 更新");
    check(updated?.bodyMd.includes("更新後") === true, "body 更新");

    // --- 6. getNote ---
    console.log("[6] getNote");
    const full = await getNote(note.id);
    check(full?.bodyMd.includes("更新後") === true, "本文取得");

    // --- 7. archived フィルタ ---
    console.log("[7] archived");
    await updateNote(note.id, { archived: true });
    const afterArchive = await queryNotes({ limit: 50 });
    check(!afterArchive.notes.some((n) => n.id === note.id), "archived は browse に出ない");
    const withArchived = await queryNotes({ limit: 50, includeArchived: true });
    check(
      withArchived.notes.some((n) => n.id === note.id),
      "includeArchived=true なら archived も出る"
    );

    // --- 8. delete + cascade ---
    console.log("[8] delete + cascade");
    const delOk = await deleteNote(note.id);
    check(delOk, "削除成功");
    check((await getNote(note.id)) === null, "削除後は取得不可");
    check((await chunkCount(note.id)) === 0, "note_chunks も CASCADE 削除");
    created.pop();

    // --- 9. delete 時の project_links (memo) orphan cleanup (§14.2) ---
    console.log("[9] delete → project_links cleanup");
    const proj = (await sql`SELECT id FROM projects LIMIT 1`) as unknown as Array<{ id: number }>;
    if (proj.length) {
      const note2 = await createNote({ bodyMd: "削除→link cleanup テスト用" });
      created.push(note2.id);
      await sql`
        INSERT INTO project_links (project_id, artifact_type, artifact_id, linked_by)
        VALUES (${proj[0].id}, 'memo', ${String(note2.id)}, 'manual')
        ON CONFLICT DO NOTHING`;
      const before = (await sql`SELECT count(*)::int AS c FROM project_links WHERE artifact_type='memo' AND artifact_id=${String(note2.id)}`) as unknown as Array<{ c: number }>;
      check(before[0]?.c === 1, "削除前: memo link 1 件");
      await deleteNote(note2.id);
      created.pop();
      const after = (await sql`SELECT count(*)::int AS c FROM project_links WHERE artifact_type='memo' AND artifact_id=${String(note2.id)}`) as unknown as Array<{ c: number }>;
      check(after[0]?.c === 0, "削除後: memo link も消える (= orphan 防止)");
    } else {
      console.log("  ⚠ projects 無し → orphan cleanup テスト skip");
    }

    // --- 10. save_note tool → report_update event (§6, N2) ---
    console.log("[10] save_note → report_update push");
    const sessionId = `test-notes-${passed}`;
    const events: ServerEvent[] = [];
    const unsub = subscribeSession(sessionId, (e) => events.push(e));
    try {
      const ctx = {
        sessionId,
        caller: { kind: "main" },
        mode: "normal",
        userUtterance: null,
        availabilityCache: new Map(),
      } as ToolContext;
      const body = "# N2 テスト\n\nレポートパネル live 表示の確認。";
      const out = (await saveNote.handler({ body_md: body }, ctx)) as {
        ok: boolean;
        id: number;
        title: string;
      };
      check(out.ok === true && out.id > 0, "save_note 成功");
      created.push(out.id);
      const ru = events.find((e) => e.type === "report_update");
      check(ru !== undefined, "report_update イベントが push される");
      if (ru && ru.type === "report_update") {
        check(ru.noteId === out.id, `report_update.noteId = 保存ノート id (${ru.noteId})`);
        check(ru.markdown === body, "report_update.markdown = 保存本文そのまま");
        check(ru.title === out.title, `report_update.title = ノート title ("${ru.title}")`);
      }
    } finally {
      unsub();
    }

    // --- 11. save_note は購読者ゼロでも tool 自体は成功する (push 失敗耐性) ---
    console.log("[11] save_note は購読者ゼロでも成功");
    {
      const ctx = {
        sessionId: "test-notes-no-subscriber",
        caller: { kind: "main" },
        mode: "normal",
        userUtterance: null,
        availabilityCache: new Map(),
      } as ToolContext;
      const out = (await saveNote.handler({ body_md: "購読者なし live 表示テスト" }, ctx)) as {
        ok: boolean;
        id: number;
      };
      check(out.ok === true && out.id > 0, "購読者ゼロでも save_note 成功");
      created.push(out.id);
    }
  } finally {
    // cleanup (= テスト失敗時に残ったノートを掃除)
    for (const id of created) {
      await deleteNote(id).catch(() => {});
    }
  }

  console.log(`\n=== ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) {
    console.log("FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("✅ all green");
  process.exit(0);
}

main().catch((e) => {
  console.error("[test-notes] threw:", e);
  process.exit(1);
});
