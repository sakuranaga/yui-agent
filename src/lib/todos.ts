/**
 * Todo / Project CRUD.
 *
 * AI 最適化原則:
 *   - identifier ベース ("T-42") で Yui からアクセス
 *   - project / category は名前文字列で受ける (id 解決はサーバ内)
 *   - compact 出力 (パイプ区切り 1 行)
 *   - 単一 intent = 単一 tool
 */
import { db } from "@/db/client";
import { projects, projectLinks, todos, type Project, type Todo } from "@/db/schema";
import { and, asc, desc, eq, inArray, isNull, isNotNull, lte, sql, type SQL } from "drizzle-orm";
import { addXp } from "@/lib/xp";

/**
 * todo の primary project リンクを project_links と同期する小ヘルパー。
 * todos.project_id を真として、project_links の linked_by="primary" 行を
 * 1 件だけ持つよう揃える (古い primary は削除、新 project にリンク作成)。
 */
async function syncPrimaryProjectLink(todoId: number, projectId: number | null): Promise<void> {
  // 既存 primary を全消し
  await db
    .delete(projectLinks)
    .where(
      and(
        eq(projectLinks.artifactType, "todo"),
        eq(projectLinks.artifactId, String(todoId)),
        eq(projectLinks.linkedBy, "primary")
      )
    );
  // 新 project に primary リンク作成
  if (projectId !== null) {
    await db
      .insert(projectLinks)
      .values({
        projectId,
        artifactType: "todo",
        artifactId: String(todoId),
        linkedBy: "primary",
      })
      .onConflictDoNothing();
  }
}

// ---------- Projects ----------

export async function getOrCreateProject(name: string): Promise<Project> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("project name required");
  const [existing] = await db
    .select()
    .from(projects)
    .where(eq(projects.name, trimmed))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(projects)
    .values({ name: trimmed })
    .returning();
  return created;
}

export async function listProjects(opts: { includeArchived?: boolean } = {}): Promise<Project[]> {
  const conds: SQL[] = [];
  if (!opts.includeArchived) conds.push(eq(projects.archived, false));
  return db
    .select()
    .from(projects)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(asc(projects.sortOrder), asc(projects.name));
}

export async function archiveProject(id: number): Promise<Project | null> {
  const [updated] = await db
    .update(projects)
    .set({ archived: true, updatedAt: new Date() })
    .where(eq(projects.id, id))
    .returning();
  return updated ?? null;
}

export async function updateProject(
  id: number,
  patch: Partial<Pick<Project, "name" | "color" | "description" | "startAt" | "dueAt" | "sortOrder" | "archived">>
): Promise<Project | null> {
  const [updated] = await db
    .update(projects)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(projects.id, id))
    .returning();
  return updated ?? null;
}

/**
 * プロジェクトを完全削除。関連 todo の project_id を NULL に流して Inbox 行きに。
 * archived 化と区別する強い操作なので、UI 側で confirm 必須。
 */
export async function deleteProject(id: number): Promise<boolean> {
  await db.update(todos).set({ projectId: null }).where(eq(todos.projectId, id));
  const result = await db.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id });
  return result.length > 0;
}

/** プロジェクト一覧 + 各プロジェクトに紐づく todo 件数 (done を除く active 件数 + 累計件数)。 */
export async function listProjectsWithCounts(opts: { includeArchived?: boolean } = {}): Promise<
  Array<Project & { todoCount: number; activeCount: number }>
> {
  const list = await listProjects(opts);
  if (list.length === 0) return [];
  const rows = await db
    .select({
      projectId: todos.projectId,
      total: sql<number>`count(*)::int`,
      active: sql<number>`sum(case when ${todos.state} <> 'done' then 1 else 0 end)::int`,
    })
    .from(todos)
    .groupBy(todos.projectId);
  const byProject = new Map(rows.map((r) => [r.projectId, r]));
  return list.map((p) => {
    const r = byProject.get(p.id);
    return {
      ...p,
      todoCount: r?.total ?? 0,
      activeCount: r?.active ?? 0,
    };
  });
}

// ---------- Todos ----------

async function nextIdentifier(): Promise<string> {
  const [{ n }] = await db.execute<{ n: number }>(
    sql`SELECT nextval('todos_identifier_seq') AS n`
  ) as unknown as { rows: Array<{ n: number }> }["rows"];
  return `T-${n}`;
}

export type AddTodoInput = {
  sessionId: string;
  title: string;
  projectName?: string;
  tags?: string[];
  note?: string;
  url?: string;
  state?: "backlog" | "in_progress" | "blocked" | "done";
  priority?: 1 | 2 | 3;
  startAt?: Date;
  dueAt?: Date;
  externalRef?: string;
  /** true なら dedup check を skip して必ず新規作成。intent dispatch (Mail→TODO 等
   *  のユーザ明示操作) で使う想定。Yui ターン経由の add_todo は false (default)。 */
  bypassDedup?: boolean;
};

export type AddTodoResult = {
  todo: Todo;
  /** dedup でヒットした既存 row (bypass 時のみセット。caller は UI で
   *  「同じタイトルの TODO が既にあります」と知らせる) */
  duplicatedExisting?: { id: number; identifier: string; title: string };
};

/**
 * dedup 用にタイトルを正規化 (空白潰し + lowercase)。
 * 完全一致のみ拾うため、表記揺れまでは見ない (副作用が少ない方を選ぶ)。
 */
function normalizeTitleForDedup(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function addTodo(input: AddTodoInput): Promise<AddTodoResult> {
  let projectId: number | null = null;
  if (input.projectName) {
    const p = await getOrCreateProject(input.projectName);
    projectId = p.id;
  }

  // 同一 session に同じ (projectId, normalized title) で active な todo が既にあれば
  // 重複と判定。
  //   - bypassDedup=false (default): 既存を返す (Yui ターン経由で前ターン依頼の
  //     再 dispatch 事故を防ぐ物理的ガード)
  //   - bypassDedup=true: 新規作成するが、duplicatedExisting に既存情報を載せて
  //     caller (UI) に「既に同タイトルあり」を伝える。intent dispatch のような
  //     ユーザ明示操作で使う。
  // done / cancelled は再追加意図とみなして dedup 対象外。
  const normalized = normalizeTitleForDedup(input.title);
  const projectCond = projectId === null
    ? isNull(todos.projectId)
    : eq(todos.projectId, projectId);
  const existing = await db
    .select()
    .from(todos)
    .where(
      and(
        eq(todos.sessionId, input.sessionId),
        projectCond,
        sql`lower(regexp_replace(trim(${todos.title}), '\\s+', ' ', 'g')) = ${normalized}`,
        inArray(todos.state, ["backlog", "in_progress", "blocked"])
      )
    )
    .limit(1);

  let duplicatedExisting: AddTodoResult["duplicatedExisting"];
  if (existing.length > 0) {
    duplicatedExisting = {
      id: Number(existing[0].id),
      identifier: existing[0].identifier,
      title: existing[0].title,
    };
    if (!input.bypassDedup) {
      // 互換挙動: 既存をそのまま返す
      return { todo: existing[0], duplicatedExisting };
    }
    // bypass のときは新規作成へ流す (duplicatedExisting は持ち越して caller に伝える)
  }

  const identifier = await nextIdentifier();
  const [row] = await db
    .insert(todos)
    .values({
      identifier,
      sessionId: input.sessionId,
      projectId,
      tags: input.tags ?? [],
      title: input.title,
      note: input.note ?? null,
      url: input.url ?? null,
      state: input.state ?? "backlog",
      priority: input.priority ?? 2,
      startAt: input.startAt ?? null,
      dueAt: input.dueAt ?? null,
      externalRef: input.externalRef ?? null,
    })
    .returning();
  // primary project リンクを project_links にも反映 (Hub aggregate のため)
  if (projectId !== null) {
    await syncPrimaryProjectLink(Number(row.id), projectId);
  }
  return { todo: row, duplicatedExisting };
}

export type UpdateTodoInput = {
  identifier: string;
  title?: string;
  projectName?: string | null;        // null で project 解除
  tags?: string[];
  note?: string;
  url?: string;
  state?: "backlog" | "in_progress" | "blocked" | "done";
  priority?: 1 | 2 | 3;
  startAt?: Date | null;
  dueAt?: Date | null;
};

export async function updateTodo(input: UpdateTodoInput): Promise<Todo | null> {
  const patch: Partial<Todo> & { updatedAt: Date } = { updatedAt: new Date() };
  if (input.title !== undefined) patch.title = input.title;
  if (input.tags !== undefined) patch.tags = input.tags;
  if (input.note !== undefined) patch.note = input.note;
  if (input.url !== undefined) patch.url = input.url;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.startAt !== undefined) patch.startAt = input.startAt;
  if (input.dueAt !== undefined) patch.dueAt = input.dueAt;
  if (input.projectName !== undefined) {
    if (input.projectName === null || input.projectName === "") {
      patch.projectId = null;
    } else {
      const p = await getOrCreateProject(input.projectName);
      patch.projectId = p.id;
    }
  }
  if (input.state !== undefined) {
    patch.state = input.state;
    // state=done に遷移したら completed_at 自動セット (まだ未設定なら)
    if (input.state === "done") {
      patch.completedAt = new Date();
    } else {
      // done から戻った場合は completed_at クリア
      patch.completedAt = null;
    }
  }

  const [row] = await db
    .update(todos)
    .set(patch)
    .where(eq(todos.identifier, input.identifier))
    .returning();
  // project が変わった場合 (= projectName が patch に含まれていた場合) は
  // project_links の primary 行を再同期する。
  if (row && input.projectName !== undefined) {
    await syncPrimaryProjectLink(Number(row.id), patch.projectId ?? null);
  }
  // state=done に遷移したら todo_completed +3 XP。同一 todo.id の再 done は
  // UNIQUE 制約 (event_type, ref_table, ref_id) で自動的に弾かれる。
  if (row && input.state === "done") {
    void addXp({
      eventType: "todo_completed",
      refTable: "todos",
      refId: row.id,
    });
  }
  return row ?? null;
}

export async function completeTodo(identifier: string): Promise<Todo | null> {
  const row = await updateTodo({ identifier, state: "done" });
  if (row) {
    // 完了した TODO に紐づくリマインダーを片付け
    await cleanupTodoReminders(row.id);
  }
  return row;
}

export async function deleteTodo(identifier: string): Promise<Todo | null> {
  const [row] = await db
    .delete(todos)
    .where(eq(todos.identifier, identifier))
    .returning();
  if (row) {
    await cleanupTodoReminders(row.id);
  }
  return row ?? null;
}

async function cleanupTodoReminders(todoId: number): Promise<void> {
  try {
    const { deleteRemindersByRef } = await import("@/lib/reminders");
    await deleteRemindersByRef("todos", todoId);
  } catch (e) {
    console.warn(`[todos] cleanup reminders failed for todo ${todoId}:`, e);
  }
}

export async function getTodoByIdentifier(identifier: string): Promise<Todo | null> {
  // "T-42" or "WORK-42" (external_ref) どちらでも引けるように両対応
  const [row] = await db
    .select()
    .from(todos)
    .where(
      sql`(${todos.identifier} = ${identifier} OR ${todos.externalRef} = ${identifier})`
    )
    .limit(1);
  return row ?? null;
}

export type ListTodosOpts = {
  projectName?: string;
  tag?: string;
  states?: Array<"backlog" | "in_progress" | "blocked" | "done">;
  /** これより前に期限が来るもの (ISO or Date)。期限なし todo は対象外 */
  dueBefore?: Date;
  /** 完了済みも含むか (デフォルト false) */
  includeCompleted?: boolean;
  limit?: number;
};

export async function listTodos(opts: ListTodosOpts = {}): Promise<{ todo: Todo; projectName: string | null }[]> {
  const conds: SQL[] = [];
  if (opts.projectName) {
    const [p] = await db
      .select()
      .from(projects)
      .where(eq(projects.name, opts.projectName))
      .limit(1);
    if (!p) return []; // project 未存在 → 空
    conds.push(eq(todos.projectId, p.id));
  }
  if (opts.tag) {
    // tags @> ARRAY[tag] (postgres array contains)
    conds.push(sql`${todos.tags} @> ARRAY[${opts.tag}]::text[]`);
  }
  if (opts.states && opts.states.length > 0) {
    conds.push(inArray(todos.state, opts.states));
  } else if (!opts.includeCompleted) {
    // デフォルトは done を除外
    conds.push(sql`${todos.state} != 'done'`);
  }
  if (opts.dueBefore) {
    conds.push(and(isNotNull(todos.dueAt), lte(todos.dueAt, opts.dueBefore))!);
  }

  const rows = await db
    .select({
      todo: todos,
      projectName: projects.name,
    })
    .from(todos)
    .leftJoin(projects, eq(todos.projectId, projects.id))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(
      asc(todos.completedAt), // 未完了優先 (null が先)
      asc(todos.dueAt),       // 期限近い順
      desc(todos.priority),   // priority 高い順
      desc(todos.createdAt)
    )
    .limit(opts.limit ?? 50);

  return rows;
}

export async function searchTodos(query: string, limit = 10): Promise<{ todo: Todo; projectName: string | null }[]> {
  // 半角・全角スペース区切りで token 分割し、各 token が title / note / tags の
  // いずれかに含まれることを **AND** で要求する。
  // 例: "Blender 本" → "Blender" と "本" 両方が含まれる行を返す。
  // 旧実装は ILIKE '%Blender 本%' で連続マッチを要求しており、語順や離れた配置に
  // 弱く「Blender 関連の本」のような行を見落としていた。
  const tokens = query.trim().split(/[\s　]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return [];

  const tokenConds: SQL[] = tokens.map((t) => {
    const like = `%${t}%`;
    return sql`(${todos.title} ILIKE ${like} OR ${todos.note} ILIKE ${like} OR ${t} = ANY(${todos.tags}))`;
  });
  const tokensAnd =
    tokenConds.length === 1
      ? tokenConds[0]
      : sql.join(tokenConds, sql` AND `);

  const rows = await db
    .select({
      todo: todos,
      projectName: projects.name,
    })
    .from(todos)
    .leftJoin(projects, eq(todos.projectId, projects.id))
    .where(
      sql`(${todos.identifier} = ${query} OR ${todos.externalRef} = ${query} OR (${tokensAnd}))`
    )
    .orderBy(desc(todos.createdAt))
    .limit(limit);
  return rows;
}

/**
 * Yui に返す compact 1 行表記。token 節約。
 * 例: "T-42|in_progress|2026-05-30|3|本|タイトル本体"
 */
export function formatTodoCompact(t: Todo, projectName: string | null): string {
  const due = t.dueAt ? t.dueAt.toISOString().slice(0, 10) : "-";
  const proj = projectName ?? "-";
  const tagsStr = t.tags.length > 0 ? t.tags.join(",") : "-";
  return `${t.identifier}|${t.state}|${due}|p${t.priority}|${proj}|${tagsStr}|${t.title}`;
}

/**
 * ノートパネル (ReportPanel) 用 markdown。
 * 期限超過 / 今月末まで / 期限なし のセクション分け + 表で表示。
 */
export function formatTodoListMarkdown(
  list: { todo: Todo; projectName: string | null }[],
  opts: { titleHint?: string } = {}
): { title: string; markdown: string } {
  if (list.length === 0) {
    return {
      title: opts.titleHint ?? "TODO 一覧",
      markdown: "(該当なし)",
    };
  }

  const now = new Date();
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  const overdue: typeof list = [];
  const thisMonth: typeof list = [];
  const future: typeof list = [];
  const noDue: typeof list = [];

  for (const r of list) {
    const d = r.todo.dueAt;
    if (!d) noDue.push(r);
    else if (d < now) overdue.push(r);
    else if (d <= monthEnd) thisMonth.push(r);
    else future.push(r);
  }

  const priLabel = (p: number) => (p === 3 ? "🔴" : p === 1 ? "🔵" : "🟡");
  const stateLabel = (s: string) => {
    if (s === "done") return "✅ 完了";
    if (s === "in_progress") return "▶ 進行中";
    if (s === "blocked") return "🛑 ブロック";
    return "⚪ backlog";
  };

  const rowMd = (r: { todo: Todo; projectName: string | null }) => {
    const t = r.todo;
    const due = t.dueAt ? t.dueAt.toISOString().slice(0, 10) : "-";
    const tags = t.tags.length > 0 ? t.tags.join(", ") : "-";
    const proj = r.projectName ?? "(Inbox)";
    return `| ${priLabel(t.priority)} | **${t.identifier}** | ${t.title} | ${due} | ${proj} | ${tags} | ${stateLabel(t.state)} |`;
  };

  const tableHeader =
    "| 優先 | ID | タイトル | 期限 | プロジェクト | タグ | 状態 |\n" +
    "|---|---|---|---|---|---|---|";

  const sections: string[] = [];
  if (overdue.length > 0) {
    sections.push(`## ⚠ 期限超過 (${overdue.length}件)\n\n${tableHeader}\n${overdue.map(rowMd).join("\n")}`);
  }
  if (thisMonth.length > 0) {
    sections.push(`## 📅 今月末まで (${thisMonth.length}件)\n\n${tableHeader}\n${thisMonth.map(rowMd).join("\n")}`);
  }
  if (future.length > 0) {
    sections.push(`## 🔜 来月以降 (${future.length}件)\n\n${tableHeader}\n${future.map(rowMd).join("\n")}`);
  }
  if (noDue.length > 0) {
    sections.push(`## ⏳ 期限なし (${noDue.length}件)\n\n${tableHeader}\n${noDue.map(rowMd).join("\n")}`);
  }

  const header = `_全 ${list.length} 件_`;
  return {
    title: opts.titleHint ?? "TODO 一覧",
    markdown: [header, ...sections].join("\n\n"),
  };
}

/** プロジェクト一覧 markdown */
export function formatProjectListMarkdown(projects: Project[]): { title: string; markdown: string } {
  if (projects.length === 0) {
    return { title: "プロジェクト一覧", markdown: "(プロジェクトが登録されていません)" };
  }
  const rows = projects.map((p) => {
    const due = p.dueAt ? p.dueAt.toISOString().slice(0, 10) : "-";
    const start = p.startAt ? p.startAt.toISOString().slice(0, 10) : "-";
    const status = p.archived ? "📦 archived" : "● active";
    return `| **P-${p.id}** | ${p.name} | ${start} | ${due} | ${status} | ${p.description ?? "-"} |`;
  });
  return {
    title: "プロジェクト一覧",
    markdown: [
      `_全 ${projects.length} 件_`,
      "",
      "| ID | 名前 | 開始 | 期限 | 状態 | 説明 |",
      "|---|---|---|---|---|---|",
      ...rows,
    ].join("\n"),
  };
}
