import {
  bigserial,
  bigint,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * pgvector の `vector(N)` 型は Drizzle のネイティブサポートがまだなので
 * customType で表現する。実体はテキスト型として扱うが、SQL では
 * `vector(1024)` として CREATE TABLE される。
 */
export const vector = customType<{
  data: number[];
  config: { dimensions: number };
  configRequired: true;
  driverData: string;
}>({
  dataType(config) {
    return `vector(${config.dimensions})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return JSON.parse(value);
  },
});

/**
 * Phase 1: 全ターン素のまま記録するテーブル。検索対象ではない。
 * docs/memory-architecture.md §3.1 参照。
 */
export const rawMessages = pgTable(
  "raw_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id").notNull(),
    role: text("role").notNull().$type<"user" | "assistant">(),
    content: text("content").notNull(),
    emotion: text("emotion"),
    source: text("source")
      .notNull()
      .default("web")
      .$type<"web" | "discord_text" | "discord_voice" | "cron" | "timer">(),
    /**
     * 画像等の添付ファイルメタ。実体は data/chat-images/<sessionId>/<filename>。
     * 古い添付はクリーンナップでファイルだけ削除され、ここの配列は空になる。
     */
    attachments: jsonb("attachments")
      .notNull()
      .default([])
      .$type<Array<{ filename: string; mediaType: string }>>(),
    /**
     * このターンで Yui が実行した tool 呼び出しの要約 (assistant 行のみ意味あり)。
     * 次ターン送信時に "(内部実行ログ: add_todo title=...)" として注入し、
     * Sonnet に過去ターンの実行履歴を可視化させ、重複 dispatch を構造的に防ぐ。
     */
    toolSummary: jsonb("tool_summary")
      .notNull()
      .default([])
      .$type<Array<{ name: string; brief: string }>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_raw_messages_session").on(t.sessionId, t.createdAt),
    index("idx_raw_messages_source").on(t.source, t.createdAt.desc()),
  ]
);

/**
 * Phase 1〜D: 抽出されたメモリ項目、ベクトル検索対象。
 * docs/memory-architecture.md §3.2 / §3.3 参照。
 */
export const memoryChunks = pgTable(
  "memory_chunks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id"),
    chunkType: text("chunk_type")
      .notNull()
      .$type<
        | "fact"
        | "preference"
        | "event"
        | "emotion"
        | "summary"
        | "turn_summary"
        | "procedural"
        | "commitment"
        | "task_result"
        | "external_ref"
      >(),
    /**
     * 記憶の主体 (誰についての情報か):
     *   - "user"      : ご主人様の事実 / 嗜好
     *   - "assistant" : 秘書ペルソナの設定 (persona で名前は可変)
     *   - "shared"    : 両者に関する事実 (共通体験、関係性 等)
     */
    owner: text("owner").notNull().default("user").$type<"user" | "assistant" | "shared">(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }),
    importance: real("importance").notNull().default(0.5),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    actorType: text("actor_type")
      .notNull()
      .default("extraction")
      .$type<
        "extraction" | "subagent" | "mcp_sync" | "user_direct" | "system"
      >(),
    actorId: text("actor_id"),

    sourceSystem: text("source_system"),
    sourceId: text("source_id"),

    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),

    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => [
    index("idx_memory_chunks_type_importance").on(
      t.chunkType,
      t.importance.desc()
    ),
    index("idx_memory_chunks_created").on(t.createdAt.desc()),
    index("idx_memory_chunks_actor").on(t.actorType, t.actorId),
  ]
);

/**
 * Phase C以降: Yui内部のorchestration state。
 * docs/memory-architecture.md §3.4 参照。
 * Phase 1ではテーブル作成のみで利用しない。
 */
export const tasks = pgTable(
  "tasks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id"),
    initiatedBy: text("initiated_by")
      .notNull()
      .$type<"yui" | "user" | "cron" | "webhook">(),
    agentName: text("agent_name").notNull(),
    taskType: text("task_type").notNull(),
    status: text("status")
      .notNull()
      .default("pending")
      .$type<"pending" | "running" | "succeeded" | "failed" | "cancelled">(),
    input: jsonb("input").notNull(),
    output: jsonb("output"),
    error: text("error"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_tasks_status").on(t.status, t.createdAt.desc()),
    index("idx_tasks_agent").on(t.agentName, t.status),
    index("idx_tasks_session").on(t.sessionId, t.createdAt),
  ]
);

/**
 * Phase G以降: cron loop の last-check state 永続化。
 */
export const proactiveState = pgTable("proactive_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Phase 3 (前倒し): rolling extraction の進捗追跡。
 * セッションごとに最後に抽出した raw_messages.id を保持し、
 * rolling と session-end の両方が重複抽出しないようにする。
 */
export const extractionProgress = pgTable("extraction_progress", {
  sessionId: text("session_id").primaryKey(),
  lastExtractedMessageId: bigint("last_extracted_message_id", { mode: "number" })
    .notNull()
    .default(0),
  lastExtractedAt: timestamp("last_extracted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Phase B continuation: Google OAuth tokens (GCal + Gmail 公式 MCP 用)。
 * docs/google-oauth-setup.md 参照。
 */
export const googleOauthTokens = pgTable("google_oauth_tokens", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  accountEmail: text("account_email").notNull().unique(),
  scopes: text("scopes").array().notNull(),
  // plaintext 列は migration 0059 以降「旧データの一時退避」用。
  // 新規書き込みは encrypted_* 側のみで、startup migration が plaintext を NULL に倒す。
  refreshToken: text("refresh_token"),
  accessToken: text("access_token"),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  encryptedAccessToken: text("encrypted_access_token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * 秘書 (Yui) の persona 設定。Single-row (id=1)。
 */
export const personaSettings = pgTable("persona_settings", {
  id: integer("id").primaryKey().default(1),
  secretaryName: text("secretary_name").notNull().default("結衣"),
  secretaryNameReading: text("secretary_name_reading").notNull().default("ゆい"),
  userAddressWork: text("user_address_work").notNull().default("ご主人様"),
  userAddressRelax: text("user_address_relax").notNull().default("ご主人様"),
  currentMode: text("current_mode")
    .notNull()
    .default("auto")
    .$type<"auto" | "work" | "relax">(),
  activePromptPresetId: bigint("active_prompt_preset_id", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * 追加プロンプトのプリセット (設定 > 秘書 で複数登録、1 つだけ有効化 or なし)。
 * persona_settings.active_prompt_preset_id が NULL なら追加なし。
 * yui-prompt が persona に追記する。
 */
export const promptPresets = pgTable("prompt_presets", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  label: text("label").notNull(),
  body: text("body").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type PromptPreset = typeof promptPresets.$inferSelect;
export type NewPromptPreset = typeof promptPresets.$inferInsert;

/**
 * タイマー / アラーム (Phase: timer feature)。
 * kind=timer: 相対時間カウントダウン
 * kind=alarm: 絶対時刻起動 (= 旧 "reminder"。リマインダー機能とは別物)
 */
export const timers = pgTable(
  "timers",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id").notNull(),
    kind: text("kind").notNull().$type<"timer" | "alarm">(),
    label: text("label"),
    targetAt: timestamp("target_at", { withTimezone: true }).notNull(),
    status: text("status")
      .notNull()
      .default("pending")
      .$type<"pending" | "fired" | "cancelled">(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    /** 発火時に Yui に実行させる prompt (null なら通知だけ) */
    onFirePrompt: text("on_fire_prompt"),
  },
  (t) => [
    index("idx_timers_status_target").on(t.status, t.targetAt),
    index("idx_timers_session").on(t.sessionId),
  ]
);

/**
 * リマインダー (予定・習慣の事前通知)。タイマー / アラームとは別物。
 * 設計: docs/reminders-system.md
 */
export type ReminderScheduleOnce = {
  kind: "once";
  baseAt: string;        // ISO8601 (例: "2026-06-05T13:00:00+09:00")
  leadMinutes: number;   // 何分前にリマインドするか (0 = 同時刻)
};
export type ReminderScheduleWeekly = {
  kind: "weekly";
  baseTime: string;      // "HH:MM" (JST)
  weekdays: number[];    // 0=Sun..6=Sat、空配列 = 毎日
  leadMinutes: number;
  tz?: string;           // 将来用、現状は JST 固定
};
export type ReminderSchedule = ReminderScheduleOnce | ReminderScheduleWeekly;

export const reminders = pgTable(
  "reminders",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id").notNull(),
    kind: text("kind").notNull().$type<"habit" | "todo_due" | "event_due" | "custom">(),
    title: text("title").notNull(),
    extraPrompt: text("extra_prompt"),
    schedule: jsonb("schedule").notNull().$type<ReminderSchedule>(),
    refTable: text("ref_table"),
    refId: bigint("ref_id", { mode: "number" }),
    enabled: boolean("enabled").notNull().default(true),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    fireCount: integer("fire_count").notNull().default(0),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_reminders_enabled_next").on(t.enabled, t.nextDueAt),
    index("idx_reminders_ref").on(t.refTable, t.refId),
    index("idx_reminders_session").on(t.sessionId),
  ]
);

export type Reminder = typeof reminders.$inferSelect;
export type NewReminder = typeof reminders.$inferInsert;

/**
 * 上位作業コンテナ。「本」「Yui アプリ」「確定申告」のような自由命名。
 */
export const projects = pgTable("projects", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: text("name").notNull().unique(),
  color: text("color"),
  description: text("description"),
  startAt: timestamp("start_at", { withTimezone: true }),
  dueAt: timestamp("due_at", { withTimezone: true }),
  archived: boolean("archived").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  externalRef: text("external_ref"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * ポリモーフィック M:N: project と各種アーティファクト (todo / mail / event /
 * contact / 将来 memo) を 1 テーブルで紐付け。
 * artifact_type に文字列を増やすだけで新ツールへ拡張可能 (intent endpoint
 * と同じ哲学)。FK 整合性は犠牲、orphan は cleanup job で掃除する想定。
 */
/**
 * Artifact links (source → target、ポリモーフィック M:N)。
 * intent dispatch (Mail → TODO 等) で target を作る時に書き込まれて、
 * 後から target 側で「出典」を辿るための back-link 用テーブル。
 * 設計: docs/roadmap.md §6.9 (intent endpoint Phase B)
 */
export const artifactLinks = pgTable(
  "artifact_links",
  {
    sourceType: text("source_type").notNull().$type<"mail" | "event" | "todo" | "contact" | "diary">(),
    sourceId: text("source_id").notNull(),
    targetType: text("target_type").notNull().$type<"todo" | "event" | "contact" | "memo">(),
    targetId: text("target_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull().default("intent").$type<"intent" | "manual">(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceType, t.sourceId, t.targetType, t.targetId] }),
    index("idx_artifact_links_target").on(t.targetType, t.targetId),
    index("idx_artifact_links_source").on(t.sourceType, t.sourceId),
  ]
);

export type ArtifactLink = typeof artifactLinks.$inferSelect;
export type NewArtifactLink = typeof artifactLinks.$inferInsert;

export const projectLinks = pgTable(
  "project_links",
  {
    projectId: bigint("project_id", { mode: "number" }).notNull(),
    artifactType: text("artifact_type").notNull().$type<"todo" | "mail" | "event" | "contact" | "memo">(),
    artifactId: text("artifact_id").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
    linkedBy: text("linked_by").notNull().default("manual").$type<"manual" | "ai" | "intent" | "primary">(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.artifactType, t.artifactId] }),
    index("idx_project_links_artifact").on(t.artifactType, t.artifactId),
    index("idx_project_links_project_type").on(t.projectId, t.artifactType),
  ]
);

export type ProjectLink = typeof projectLinks.$inferSelect;
export type NewProjectLink = typeof projectLinks.$inferInsert;

/**
 * 統一 todo テーブル (project 配下 + 自由 tag 配列)。
 * AI 最適化: identifier "T-N" ベースで Yui が直接操作、UUID 解決不要。
 * Plane work item + 旧 wishes の両方を吸収。
 */
export const todos = pgTable("todos", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  identifier: text("identifier").notNull().unique(),
  sessionId: text("session_id").notNull(),
  projectId: bigint("project_id", { mode: "number" }),
  tags: text("tags").array().notNull().default([]),
  title: text("title").notNull(),
  note: text("note"),
  url: text("url"),
  state: text("state").notNull().default("backlog"),
  priority: integer("priority").notNull().default(2),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startAt: timestamp("start_at", { withTimezone: true }),
  dueAt: timestamp("due_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  externalRef: text("external_ref"),
});

/**
 * 連絡先 / 人物録 (Yui 専用内部 CRM)。notes は markdown 自由テキスト。
 */
export const contacts = pgTable("contacts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  identifier: text("identifier").notNull().unique(),
  sessionId: text("session_id").notNull(),
  name: text("name").notNull(),
  kana: text("kana"),
  nickname: text("nickname"),
  company: text("company"),
  department: text("department"),
  role: text("role"),
  // 連絡先は常に配列。type は "cell"/"work"/"home" 等 (VCF 由来)、値だけで type 不明なら省略。
  emails: jsonb("emails").$type<Array<{ type?: string; value: string }>>().notNull().default([]),
  phones: jsonb("phones").$type<Array<{ type?: string; value: string }>>().notNull().default([]),
  addresses: jsonb("addresses").$type<Array<{ type?: string; value: string }>>().notNull().default([]),
  urls: text("urls").array().notNull().default([]),
  birthday: timestamp("birthday", { withTimezone: true, mode: "date" }),
  tags: text("tags").array().notNull().default([]),
  notes: text("notes"),
  externalRef: text("external_ref"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/**
 * 実際に再生された曲の永続履歴 (Spotify now-playing poller → setNowPlaying 経由で append)。
 * Apple Music 時代の MusicBridge POST フローは Spotify 移行で廃止、サーバ側 30s polling に統合。
 * container_* は specialist の play_* 起動時の出処 (playlist/album)。
 */
export const musicTrackHistory = pgTable("music_track_history", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  trackId: text("track_id"),
  title: text("title").notNull(),
  artist: text("artist"),
  album: text("album"),
  durationMs: integer("duration_ms"),
  containerKind: text("container_kind"),
  containerId: text("container_id"),
  containerName: text("container_name"),
  playedAt: timestamp("played_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Periodic Module の前回 run 結果。1 module = 1 行。
 * snapshot: モジュールが自由に格納する diff 判定用 state (JSON)
 */
export const periodicState = pgTable("periodic_state", {
  moduleId: text("module_id").primaryKey(),
  snapshot: jsonb("snapshot").$type<unknown>(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
});

export type RawMessage = typeof rawMessages.$inferSelect;
export type NewRawMessage = typeof rawMessages.$inferInsert;
export type MemoryChunk = typeof memoryChunks.$inferSelect;
export type NewMemoryChunk = typeof memoryChunks.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type GoogleOauthToken = typeof googleOauthTokens.$inferSelect;
export type NewGoogleOauthToken = typeof googleOauthTokens.$inferInsert;
export type Timer = typeof timers.$inferSelect;
export type NewTimer = typeof timers.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Todo = typeof todos.$inferSelect;
export type NewTodo = typeof todos.$inferInsert;
export type MusicTrackHistory = typeof musicTrackHistory.$inferSelect;
export type NewMusicTrackHistory = typeof musicTrackHistory.$inferInsert;

/**
 * 結衣の日記 (人間が読んで楽しむ用 + Yui からの on-demand 参照)。
 * memory_chunks の retrieval には含めない (factual と主観を混ぜない)。
 */
export const diaryEntries = pgTable("diary_entries", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  entryDate: timestamp("entry_date", { withTimezone: true, mode: "date" }).notNull().unique(),
  body: text("body").notNull(),
  /** TTS 正規化済み本文 (§7.8)。未実装の間は NULL、読み上げ時は body にフォールバック。 */
  bodyTts: text("body_tts"),
  mood: text("mood"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  modelUsed: text("model_used"),
  sourceMeta: jsonb("source_meta").$type<Record<string, unknown>>(),
});
export type DiaryEntry = typeof diaryEntries.$inferSelect;
export type NewDiaryEntry = typeof diaryEntries.$inferInsert;

/**
 * Yui ノート空間 (docs/yui-notes.md)。markdown ノート + chunk 分割 embedding。
 * memory_chunks (= 会話記憶) とは別系統。HNSW / FTS index は migration 0068 の生 SQL。
 */
export const notes = pgTable("notes", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  title: text("title").notNull().default(""),
  bodyMd: text("body_md").notNull(),
  // 'human'|'doc_agent'|'deep_research'|'mcp'|'tool_report'|'project_note'
  source: text("source").notNull().default("human"),
  // project 紐付けは project_links (M:N, artifact_type='memo') を使う (docs/yui-notes.md §14.2)。
  pinned: boolean("pinned").notNull().default(false),
  archived: boolean("archived").notNull().default(false),
  sourceMeta: jsonb("source_meta").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;

/**
 * ノート本文の chunk 分割 embedding (= 意味検索の本体)。
 * UNIQUE(note_id, chunk_index) と HNSW index は migration 0068 の生 SQL 側で定義
 * (= 既存 memory_chunks と同じく drizzle schema には index/constraint を載せない方針)。
 */
export const noteChunks = pgTable("note_chunks", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  noteId: bigint("note_id", { mode: "number" })
    .notNull()
    .references(() => notes.id, { onDelete: "cascade" }),
  chunkIndex: integer("chunk_index").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 1024 }).notNull(),
});
export type NoteChunk = typeof noteChunks.$inferSelect;
export type NewNoteChunk = typeof noteChunks.$inferInsert;

/**
 * ご主人様プロファイル スナップショット (docs/user-profile-snapshot.md)。
 * 日記 (= 結衣の主観・内面) とは完全に別レコード。
 * 1 日 1 件、データ駆動の客観アセスメント。
 */
export const userProfileSnapshots = pgTable(
  "user_profile_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    snapshotDate: timestamp("snapshot_date", { withTimezone: true, mode: "date" }).notNull().unique(),
    personality: text("personality").notNull(),
    communicationStyle: text("communication_style").notNull(),
    currentFocus: text("current_focus").notNull(),
    moodTrend: text("mood_trend").notNull(),
    inferredTraits: text("inferred_traits").notNull(),
    evidenceNotes: text("evidence_notes"),
    inferredImagePrompt: text("inferred_image_prompt"),
    sourceMeta: jsonb("source_meta").$type<Record<string, unknown>>(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    generatedBy: text("generated_by").notNull().default("cron"),
  },
  (t) => [index("idx_user_profile_snapshots_date").on(t.snapshotDate.desc())]
);
export type UserProfileSnapshot = typeof userProfileSnapshots.$inferSelect;
export type NewUserProfileSnapshot = typeof userProfileSnapshots.$inferInsert;

/**
 * ヘルス目標 (docs/health-goals.md)。
 * 3 kind: one_time_by_date / daily_min / daily_max
 */
export const healthGoals = pgTable(
  "health_goals",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    metricKey: text("metric_key").notNull(),
    kind: text("kind").notNull().$type<"one_time_by_date" | "daily_min" | "daily_max">(),
    targetValue: real("target_value").notNull(),
    baselineValue: real("baseline_value"),
    deadline: timestamp("deadline", { withTimezone: true, mode: "date" }),
    startDate: timestamp("start_date", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    label: text("label"),
    enabled: boolean("enabled").notNull().default(true),
    notes: text("notes"),
    achievedAt: timestamp("achieved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_health_goals_metric").on(t.metricKey, t.enabled),
    index("idx_health_goals_kind").on(t.kind, t.enabled),
  ]
);
export type HealthGoal = typeof healthGoals.$inferSelect;
export type NewHealthGoal = typeof healthGoals.$inferInsert;

/**
 * 外部連携用の key/value (ai_settings の AI 以外版)。
 * Google Maps API key 等、API key を DB に保管したい用途。
 */
export const integrationSettings = pgTable("integration_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type IntegrationSetting = typeof integrationSettings.$inferSelect;

/**
 * Spotify OAuth tokens (Apple Music からの完全移行用)。
 *
 * 単一 user 前提なので row は 1 行のみ (常に id=1)。
 * refresh_token は Spotify 側で revoke しない限り永続。access_token は 1h。
 */
export const spotifyOauthTokens = pgTable("spotify_oauth_tokens", {
  id: integer("id").primaryKey().default(1),
  // plaintext 列は migration 0059 以降「旧データの一時退避」用 (google_oauth_tokens と同じ)。
  refreshToken: text("refresh_token"),
  accessToken: text("access_token"),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  encryptedAccessToken: text("encrypted_access_token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  scope: text("scope"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export type SpotifyOauthToken = typeof spotifyOauthTokens.$inferSelect;
export type NewSpotifyOauthToken = typeof spotifyOauthTokens.$inferInsert;

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type PeriodicState = typeof periodicState.$inferSelect;
export type NewPeriodicState = typeof periodicState.$inferInsert;

/**
 * ニュース機能 (Level 3 個人秘書 brief 用)。
 * 1 時間毎 periodic で全 enabled source から RSS を取得し、重複を弾いて溜める。
 * published_at > 3 日前 かつ pinned=false の row は tickMaintenance で自動削除。
 */
export const newsSources = pgTable("news_sources", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull().unique(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const newsArticles = pgTable("news_articles", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sourceId: bigint("source_id", { mode: "number" }).notNull(),
  guid: text("guid").notNull(),
  title: text("title").notNull(),
  link: text("link"),
  summary: text("summary"),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  pinned: boolean("pinned").notNull().default(false),
  pinnedAt: timestamp("pinned_at", { withTimezone: true }),
  // キュレーション結果 (docs/news-curation.md)。null = 未 curate
  score: real("score"),
  scoreReason: text("score_reason"),
  curatedAt: timestamp("curated_at", { withTimezone: true }),
});

/**
 * ニュースキュレーション設定 (singleton)。
 * CHECK (id = 1) で常に 1 行のみ。設計: docs/news-curation.md §8.2
 */
export const newsCurationSettings = pgTable("news_curation_settings", {
  id: integer("id").primaryKey().default(1),
  interestProfile: text("interest_profile").notNull().default(""),
  scoreThreshold: real("score_threshold").notNull().default(0.6),
  minSpeakIntervalHours: integer("min_speak_interval_hours").notNull().default(1),
  lastSpokenAt: timestamp("last_spoken_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type NewsSource = typeof newsSources.$inferSelect;
export type NewNewsSource = typeof newsSources.$inferInsert;
export type NewsArticle = typeof newsArticles.$inferSelect;
export type NewNewsArticle = typeof newsArticles.$inferInsert;
export type NewsCurationSettings = typeof newsCurationSettings.$inferSelect;
export type NewNewsCurationSettings = typeof newsCurationSettings.$inferInsert;

/**
 * ご主人様の位置情報 (singleton)。in-memory cache の永続化レイヤ。
 * 設計: src/lib/location.ts のコメント参照。
 */
export const userLocation = pgTable("user_location", {
  id: integer("id").primaryKey().default(1),
  lat: doublePrecision("lat").notNull(),
  lon: doublePrecision("lon").notNull(),
  accuracy: doublePrecision("accuracy"),
  placeLabel: text("place_label"),
  placeLabelAt: timestamp("place_label_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserLocation = typeof userLocation.$inferSelect;
export type NewUserLocation = typeof userLocation.$inferInsert;

/**
 * AI 関連設定 (key-value)。.env からの段階移行用。設計: docs/ai-settings.md
 * caller は getAiSetting(key) 経由で読み、DB → env → ハードコードデフォルトの順。
 */
export const aiSettings = pgTable("ai_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  isSecret: boolean("is_secret").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AiSetting = typeof aiSettings.$inferSelect;
export type NewAiSetting = typeof aiSettings.$inferInsert;

/**
 * モデルレジストリ (docs/model-config-overhaul.md #206)。
 * hosted / ローカルの LLM を複数登録。provider 明示。3 tier 割当は ai_settings KV。
 */
export type ModelCapabilities = {
  reachable?: boolean;
  supportsTools?: boolean;
  testedAt?: string; // ISO
  lastError?: string | null;
  /** tool を thinking ON でしか返せないモデル (#206 §8.8.3)。thinking-off probe で
   *  tool 不成立 → thinking-on 再 probe で成立、の時に true。thinkingMode='off' との
   *  矛盾 (off にすると main/heavy で tool が壊れる) 検出に使う。 */
  toolUseRequiresThinking?: boolean;
};
/** ローカルモデルの thinking 制御 (#206 §8.9)。local_openai のみ有効。 */
export type ThinkingMode = "auto" | "on" | "off";
export const modelRegistry = pgTable(
  "model_registry",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    provider: text("provider").notNull(), // anthropic|openai|gemini|grok|local_openai
    modelId: text("model_id").notNull(),
    baseUrl: text("base_url"),
    apiKeyRef: text("api_key_ref"),
    capabilities: jsonb("capabilities").$type<ModelCapabilities>().notNull().default({}),
    thinkingMode: text("thinking_mode").$type<ThinkingMode>().notNull().default("auto"),
    maxTokens: integer("max_tokens").notNull().default(8192),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("model_registry_provider_idx").on(t.provider)]
);
export type ModelRegistryRow = typeof modelRegistry.$inferSelect;
export type NewModelRegistryRow = typeof modelRegistry.$inferInsert;

/**
 * メール統合システム (Phase A)。設計: docs/mail-system.md §4
 *
 * - gmail_accounts: メール機能で使う Gmail アカウントの registry
 * - mail_messages: header + curation 結果 + lazy body
 * - mail_attachments: metadata only (実体は持たない)
 * - mail_curation_settings: singleton
 */
export const gmailAccounts = pgTable("gmail_accounts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
  enabled: boolean("enabled").notNull().default(true),
  isPrimary: boolean("is_primary").notNull().default(false),
  initialSyncDays: integer("initial_sync_days").notNull().default(3),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
});

export const mailMessages = pgTable("mail_messages", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  gmailMessageId: text("gmail_message_id").notNull(),
  gmailThreadId: text("gmail_thread_id").notNull(),
  accountId: bigint("account_id", { mode: "number" }).notNull(),

  fromAddress: text("from_address").notNull(),
  fromName: text("from_name"),
  fromEmail: text("from_email").notNull(),
  toAddresses: text("to_addresses").array(),
  subject: text("subject"),
  snippet: text("snippet"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  labels: text("labels").array(),

  score: real("score"),
  scoreReason: text("score_reason"),
  curatedAt: timestamp("curated_at", { withTimezone: true }),

  // メール仕分け学習 (docs/mail-classification.md)。Phase 1 から導入。
  // 旧 score とは並行運用、Phase 3 完了後に score を drop 予定。
  bucket: text("bucket").$type<"important" | "needed" | "unneeded">(),
  bucketConfidence: real("bucket_confidence"),
  bucketReason: text("bucket_reason"),
  classifiedAt: timestamp("classified_at", { withTimezone: true }),

  bodyText: text("body_text"),
  bodyHtml: text("body_html"),
  bodyFetchedAt: timestamp("body_fetched_at", { withTimezone: true }),

  readAt: timestamp("read_at", { withTimezone: true }),
  starredAt: timestamp("starred_at", { withTimezone: true }),
  // archived_at: 受信箱から外す (アーカイブ view に残る)。Gmail には書き戻さない。
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  // trashed_at: ゴミ箱 (物理削除予備軍)。「ゴミ箱を空にする」で本物の DELETE。
  trashedAt: timestamp("trashed_at", { withTimezone: true }),

  insertedAt: timestamp("inserted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mailAttachments = pgTable("mail_attachments", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  messageId: bigint("message_id", { mode: "number" }).notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  gmailPartId: text("gmail_part_id"),
  insertedAt: timestamp("inserted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mailCurationSettings = pgTable("mail_curation_settings", {
  id: integer("id").primaryKey().default(1),
  interestProfile: text("interest_profile").notNull().default(""),
  scoreThreshold: real("score_threshold").notNull().default(0.5),
  vipAddresses: text("vip_addresses").array().notNull().default([]),
  blockedAddresses: text("blocked_addresses").array().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * メール仕分け学習例の蓄積 (RAG ソース)。設計: docs/mail-classification.md
 * user の手動ラベル付け 1 件 = 1 行。新着メールはここを top-K cosine 検索して
 * few-shot プロンプトを組む。
 */
export const mailTrainingExamples = pgTable("mail_training_examples", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sourceMailId: bigint("source_mail_id", { mode: "number" }),
  embedding: vector("embedding", { dimensions: 1024 }).notNull(),
  embeddedText: text("embedded_text").notNull(),
  bucket: text("bucket")
    .notNull()
    .$type<"important" | "needed" | "unneeded">(),
  hintText: text("hint_text").notNull(),
  // 自動アクション consent (Phase 2 UI、Phase 3 で発動)
  autoTodo: boolean("auto_todo").notNull().default(false),
  autoEvent: boolean("auto_event").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GmailAccount = typeof gmailAccounts.$inferSelect;
export type NewGmailAccount = typeof gmailAccounts.$inferInsert;
export type MailMessage = typeof mailMessages.$inferSelect;
export type NewMailMessage = typeof mailMessages.$inferInsert;
export type MailAttachment = typeof mailAttachments.$inferSelect;
export type NewMailAttachment = typeof mailAttachments.$inferInsert;
export type MailCurationSettings = typeof mailCurationSettings.$inferSelect;
export type NewMailCurationSettings = typeof mailCurationSettings.$inferInsert;
export type MailTrainingExample = typeof mailTrainingExamples.$inferSelect;
export type NewMailTrainingExample = typeof mailTrainingExamples.$inferInsert;

/**
 * 日次天気キャッシュ + 凍結アーカイブ (docs/weatherkit-setup.md 関連)。
 * 緯度経度は 0.01° に丸めて key にする (≈ 1km 単位、同地点扱い)。
 * 未来日は fetch のたびに UPSERT、過去日は凍結。
 */
export const weatherDaily = pgTable("weather_daily", {
  latRound: real("lat_round").notNull(),
  lonRound: real("lon_round").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD (JST)
  conditionCode: text("condition_code").notNull(),
  conditionJa: text("condition_ja"),
  tempMax: real("temp_max").notNull(),
  tempMin: real("temp_min").notNull(),
  precipChance: real("precip_chance"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.latRound, t.lonRound, t.date] }),
  index("idx_weather_daily_date").on(t.date),
]);
export type WeatherDaily = typeof weatherDaily.$inferSelect;
export type NewWeatherDaily = typeof weatherDaily.$inferInsert;

/**
 * 食事ログ (docs/food-tracking.md §4.1)。
 * Yui との会話から post-turn extractor が自動抽出して INSERT。
 */
export const foodLogs = pgTable("food_logs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  eatenAt: timestamp("eaten_at", { withTimezone: true }).notNull(),
  rawText: text("raw_text").notNull(),
  items: jsonb("items").notNull(),
  totalKcal: real("total_kcal"),
  totalProtein: real("total_protein"),
  totalCarbs: real("total_carbs"),
  totalFat: real("total_fat"),
  totalFiber: real("total_fiber"),
  // 食塩相当量 (g)。日本の栄養成分表示の必須 5 項目の 1 つ。
  totalSalt: real("total_salt"),
  sourceMessageId: bigint("source_message_id", { mode: "number" }),
  notes: text("notes"),
  confidence: real("confidence").notNull(),
  // 'pending' | 'done' | 'manual_user' | 'failed' — Haiku 並列 worker が pending を fill。
  // 旧 extractor 経路の既存ロウは default 'done' で migration される。
  nutritionStatus: text("nutrition_status").notNull().default("done"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type FoodLog = typeof foodLogs.$inferSelect;
export type NewFoodLog = typeof foodLogs.$inferInsert;

/**
 * 栄養 cache (docs/food-tracking.md §4.2)。
 * 食材名 (正規化済) → 1 単位あたり kcal + PFC + 出典。
 */
export const foodReference = pgTable("food_reference", {
  normalizedName: text("normalized_name").primaryKey(),
  unit: text("unit").notNull(),
  kcalPerUnit: real("kcal_per_unit").notNull(),
  protein: real("protein"),
  carbs: real("carbs"),
  fat: real("fat"),
  fiber: real("fiber"),
  // 食塩相当量 (g) per unit
  salt: real("salt"),
  sourceUrl: text("source_url"),
  confidence: text("confidence").notNull().$type<"high" | "medium" | "low">(),
  lookedUpAt: timestamp("looked_up_at", { withTimezone: true }).notNull().defaultNow(),
});
export type FoodReference = typeof foodReference.$inferSelect;
export type NewFoodReference = typeof foodReference.$inferInsert;

/**
 * 体メトリクス (docs/food-tracking.md §4.3)。
 * Phase 1 では food_logs と共存だけ、Phase 2 以降で UI/抽出を実装。
 */
export const bodyMetrics = pgTable(
  "body_metrics",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    metricType: text("metric_type").notNull(),
    value: real("value").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    notes: text("notes"),
    source: text("source").notNull().default("manual"),
    sourceMessageId: bigint("source_message_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_body_metrics_type_time").on(t.metricType, t.recordedAt.desc())]
);
export type BodyMetric = typeof bodyMetrics.$inferSelect;
export type NewBodyMetric = typeof bodyMetrics.$inferInsert;

/**
 * 筋トレ / ジム記録 (docs/health-tracking.md §11 Phase 3)。
 * body_parts は標準語: chest / back / shoulders / legs / arms / core / cardio / full
 * exercises は { name, sets?, reps?, weight_kg?, distance_km?, duration_min? } の配列。
 */
export const workoutLogs = pgTable(
  "workout_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    performedAt: timestamp("performed_at", { withTimezone: true }).notNull(),
    bodyParts: jsonb("body_parts").notNull(),
    exercises: jsonb("exercises").notNull(),
    durationMin: integer("duration_min"),
    intensity: text("intensity"),
    notes: text("notes"),
    rawText: text("raw_text").notNull(),
    sourceMessageId: bigint("source_message_id", { mode: "number" }),
    confidence: real("confidence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_workout_logs_performed_at").on(t.performedAt.desc())]
);
export type WorkoutLog = typeof workoutLogs.$inferSelect;
export type NewWorkoutLog = typeof workoutLogs.$inferInsert;

/**
 * 睡眠サポート (cognitive shuffling)。設計: docs/sleep-support.md
 */
export const sleepCategories = pgTable("sleep_categories", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: text("name").notNull().unique(),
  displayOrder: integer("display_order").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
});

export const sleepWords = pgTable("sleep_words", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  categoryId: bigint("category_id", { mode: "number" }).notNull(),
  word: text("word").notNull(),
  difficulty: integer("difficulty").notNull().default(2),
  enabled: boolean("enabled").notNull().default(true),
});

export const sleepAffirmations = pgTable("sleep_affirmations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  text: text("text").notNull(),
  category: text("category"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sleepBgm = pgTable("sleep_bgm", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  title: text("title").notNull(),
  filename: text("filename").notNull().unique(),
  durationSec: integer("duration_sec"),
  enabled: boolean("enabled").notNull().default(true),
  // false (= legacy preset) → public/sleep-bgm/{filename} (静的配信)
  // true  (= user upload)   → data/sleep-bgm/{id}.mp3 を /api/sleep/bgm/{id}/file で stream
  isUploaded: boolean("is_uploaded").notNull().default(false),
  // CC BY 等の attribution-required ライセンスのクレジット文。preset は必須、
  // user upload は任意 (= NULL)。SleepModal の BGM 行 hover で tooltip 表示する。
  credit: text("credit"),
});

export const sleepSettings = pgTable("sleep_settings", {
  id: integer("id").primaryKey().default(1),
  ttsDurationScale: real("tts_duration_scale").notNull().default(1.4),
  ttsCfgScaleSpeaker: real("tts_cfg_scale_speaker").notNull().default(3.0),
  intervalMinSec: integer("interval_min_sec").notNull().default(10),
  intervalMaxSec: integer("interval_max_sec").notNull().default(20),
  defaultTimerMin: integer("default_timer_min").notNull().default(60),
  difficultyMax: integer("difficulty_max").notNull().default(2),
  affirmationProbability: real("affirmation_probability").notNull().default(0.1),
  bgmVolume: real("bgm_volume").notNull().default(0.5),
  ttsVolume: real("tts_volume").notNull().default(0.7),
  bgmDuckDb: real("bgm_duck_db").notNull().default(3.0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sleepSessions = pgTable("sleep_sessions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  stoppedBy: text("stopped_by"),
  categories: text("categories").array(),
  bgmId: bigint("bgm_id", { mode: "number" }),
  timerMin: integer("timer_min"),
  wordsSpoken: integer("words_spoken").notNull().default(0),
  affirmationsSpoken: integer("affirmations_spoken").notNull().default(0),
});

export type SleepCategory = typeof sleepCategories.$inferSelect;
export type NewSleepCategory = typeof sleepCategories.$inferInsert;
export type SleepWord = typeof sleepWords.$inferSelect;
export type NewSleepWord = typeof sleepWords.$inferInsert;
export type SleepAffirmation = typeof sleepAffirmations.$inferSelect;
export type NewSleepAffirmation = typeof sleepAffirmations.$inferInsert;
export type SleepBgm = typeof sleepBgm.$inferSelect;
export type NewSleepBgm = typeof sleepBgm.$inferInsert;
export type SleepSettings = typeof sleepSettings.$inferSelect;
export type NewSleepSettings = typeof sleepSettings.$inferInsert;
export type SleepSession = typeof sleepSessions.$inferSelect;
export type NewSleepSession = typeof sleepSessions.$inferInsert;

/**
 * いいね機能: VRM ダブルクリックでご主人様がハート反応を発火した記録。
 * message_id は nullable (Yui 自体への撫で = null、応答評価 = 直前 assistant 行)。
 * 将来的に chat bubble 内ハートボタンを足したら同じテーブルに積む。
 */
export const likeEvents = pgTable(
  "like_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id").notNull(),
    messageId: bigint("message_id", { mode: "number" }),
    clickX: real("click_x"),
    clickY: real("click_y"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_like_events_session_created").on(t.sessionId, t.createdAt.desc()),
  ]
);

export type LikeEvent = typeof likeEvents.$inferSelect;
export type NewLikeEvent = typeof likeEvents.$inferInsert;

/**
 * LLM 呼び出しイベント。
 * event_type='call' は個別 API 呼び出し、'trace' は 1 ユーザターン集計。
 * お給料 (= cost_usd 合算 × USD-JPY rate) の計算ソース。
 */
export const llmEvents = pgTable(
  "llm_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventType: text("event_type").notNull().$type<"call" | "trace">(),
    ts: bigint("ts", { mode: "number" }).notNull(),
    role: text("role"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    costUsd: real("cost_usd"),
    durationMs: integer("duration_ms"),
    retries: integer("retries"),
    traceId: text("trace_id"),
    calls: integer("calls"),
    llmMs: integer("llm_ms"),
    wallMs: integer("wall_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_llm_events_ts").on(t.ts.desc()),
    index("idx_llm_events_type_ts").on(t.eventType, t.ts.desc()),
  ]
);

export type LlmEventRow = typeof llmEvents.$inferSelect;
export type NewLlmEventRow = typeof llmEvents.$inferInsert;

/**
 * 秘書 Lv の経験値加算ログ。
 * (event_type, ref_table, ref_id) 部分 unique で重複加算を構造的に防ぐ。
 * 累計 SUM(xp) を levelFromTotalXp で Lv に変換する。
 */
export const xpEvents = pgTable(
  "xp_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventType: text("event_type").notNull().$type<
      | "chat_turn"
      | "heart_received"
      | "todo_completed"
      | "diary_generated"
      | "specialist_run"
      | "morning_brief"
      | "music_played"
    >(),
    xp: real("xp").notNull(),
    refTable: text("ref_table"),
    refId: bigint("ref_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("idx_xp_events_created").on(t.createdAt.desc())]
);

export type XpEventRow = typeof xpEvents.$inferSelect;
export type NewXpEventRow = typeof xpEvents.$inferInsert;

/**
 * 朝のブリーフィングを日別に保存。
 * Yui の get_morning_brief / list_morning_briefs tool で振り返り参照する。
 */
export const morningBriefs = pgTable(
  "morning_briefs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    entryDate: timestamp("entry_date", { withTimezone: true, mode: "date" })
      .notNull()
      .unique(),
    markdown: text("markdown").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sourceMeta: jsonb("source_meta").$type<Record<string, unknown>>(),
  },
  (t) => [index("idx_morning_briefs_date_desc").on(t.entryDate.desc())]
);

export type MorningBrief = typeof morningBriefs.$inferSelect;
export type NewMorningBrief = typeof morningBriefs.$inferInsert;

/**
 * TTS 用語辞書。/api/tts route の前段で longest-first に文字列置換する。
 * Settings の「読み方」タブで CRUD 可。
 */
export const ttsDictionary = pgTable("tts_dictionary", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  word: text("word").notNull().unique(),
  reading: text("reading").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  // エントリの出所。'user' (= 手動 / ツール、最優先で保護) | 'preset' (= 初期 seed) |
  // 'cmudict' (= e2k 一括生成、13 万件規模、一括管理対象)。migration 0067 参照。
  source: text("source").notNull().default("user"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TtsDictionaryEntry = typeof ttsDictionary.$inferSelect;
export type NewTtsDictionaryEntry = typeof ttsDictionary.$inferInsert;

/**
 * 通知 (お便り)。設計: docs/notification-system.md
 * - 朝のブリーフ / ニュース / 日記 / メール / タイマー / 体調 等の自発呼びかけを保存
 * - トースト UI + LogModal「お便り」タブ + replay で参照
 */
export const notifications = pgTable(
  "notifications",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id").notNull(),
    kind: text("kind").notNull(), // morning_brief / news / diary / mail / health / timer / custom
    importance: text("importance").notNull(), // high / normal / low / silent
    title: text("title").notNull(),
    preview: text("preview"),
    bodyMd: text("body_md"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    refTable: text("ref_table"),
    refId: bigint("ref_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    seenAt: timestamp("seen_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  }
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

/**
 * retrieval_log: 「いつどの chunk が retrieval で使われたか」を append-only で記録。
 * decay 判定 (最終参照時刻) + 利用統計 + 監査トレイル用。
 * 設計: docs/memory-architecture.md §16.7 Phase 5
 */
export const retrievalLog = pgTable(
  "retrieval_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    chunkId: bigint("chunk_id", { mode: "number" }).notNull(),
    sessionId: text("session_id"),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    layer: text("layer").notNull().$type<
      "l2_facts" | "l3_summary" | "l4_semantic" | "reconcile" | "extract_dedup"
    >(),
    rank: integer("rank"),
    score: real("score"),
  }
);

export type RetrievalLogEntry = typeof retrievalLog.$inferSelect;
export type NewRetrievalLogEntry = typeof retrievalLog.$inferInsert;

/**
 * decay_runs: 日次 decay ジョブの監視ログ。
 * 設計: docs/memory-architecture.md §16.7 Phase 5
 */
export const decayRuns = pgTable("decay_runs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  processed: integer("processed").notNull(),
  decayed: integer("decayed").notNull(),
  invalidated: integer("invalidated").notNull(),
  errors: integer("errors").notNull().default(0),
  durationMs: integer("duration_ms"),
  details: jsonb("details").$type<Record<string, unknown>>(),
});

export type DecayRun = typeof decayRuns.$inferSelect;

/**
 * job_claims: 「今日 1 回だけ実行」系ジョブの atomic claim 用テーブル。
 * setInterval overlap で二重実行されないよう、INSERT ON CONFLICT DO NOTHING で取り合う。
 * 戻り行があれば claim 成功、空なら他 tick が先に取った = skip。
 * 設計: migrations/0058_atomic_job_claims.sql
 */
export const jobClaims = pgTable("job_claims", {
  claimKey: text("claim_key").primaryKey(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  moduleId: text("module_id").notNull(),
  meta: jsonb("meta").$type<Record<string, unknown>>(),
});
export type JobClaim = typeof jobClaims.$inferSelect;
export type NewJobClaim = typeof jobClaims.$inferInsert;
export type NewDecayRun = typeof decayRuns.$inferInsert;

/**
 * 通知マトリックス設定 (per-event ユーザー上書き可)。
 * デフォルト値は seed で投入、ユーザーが SettingsModal「通知」タブで UPDATE する。
 */
export const notificationSettings = pgTable("notification_settings", {
  eventKind: text("event_kind").primaryKey(),
  // 旧 3 値 enum (= "speak"|"notify"|"silent")。Phase F5 で drop 予定、それまで rollback 用に保持。
  modeOnline: text("mode_online").notNull(),
  modeAway: text("mode_away").notNull(),
  modeFocus: text("mode_focus").notNull(),
  // v2: toast / speak の 2 軸独立 boolean (= 4 通り表現可)
  toastOnline: boolean("toast_online").notNull(),
  speakOnline: boolean("speak_online").notNull(),
  toastAway: boolean("toast_away").notNull(),
  speakAway: boolean("speak_away").notNull(),
  toastFocus: boolean("toast_focus").notNull(),
  speakFocus: boolean("speak_focus").notNull(),
  discordPolicy: text("discord_policy").notNull(),
  importance: text("importance").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type NotificationSetting = typeof notificationSettings.$inferSelect;
export type NewNotificationSetting = typeof notificationSettings.$inferInsert;

/**
 * サイレント時間帯 (= 指定時間帯を自動的に "away" 扱いにする) の singleton 設定。
 * 旧 v1 の「夜間 22-7 JST ハードコード」を UI 設定に置換。
 * デフォルト OFF。
 *
 * 設計: docs/notification-system.md §8.2
 */
export const quietHoursSettings = pgTable("quiet_hours_settings", {
  id: smallint("id").primaryKey().default(1),
  enabled: boolean("enabled").notNull().default(false),
  startHour: smallint("start_hour").notNull().default(22),
  endHour: smallint("end_hour").notNull().default(7),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type QuietHoursSetting = typeof quietHoursSettings.$inferSelect;
export type NewQuietHoursSetting = typeof quietHoursSettings.$inferInsert;

/**
 * VRM モデル (秘書のお着替え) — Phase 1: 複数登録 + 手動切替
 * 物理ファイル: data/vrm-models/<filename> + data/vrm-models/<thumbnail_filename>
 */
export const vrmModels = pgTable("vrm_models", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: text("name").notNull(),
  filename: text("filename").notNull().unique(),
  thumbnailFilename: text("thumbnail_filename"),
  fileSizeBytes: bigint("file_size_bytes", { mode: "number" }).notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
});

export const vrmSettings = pgTable("vrm_settings", {
  id: integer("id").primaryKey().default(1),
  currentModelId: bigint("current_model_id", { mode: "number" }),
  manualOverrideModelId: bigint("manual_override_model_id", { mode: "number" }),
  autoSwitchEnabled: boolean("auto_switch_enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type VrmModel = typeof vrmModels.$inferSelect;
export type NewVrmModel = typeof vrmModels.$inferInsert;
export type VrmSettings = typeof vrmSettings.$inferSelect;
export type NewVrmSettings = typeof vrmSettings.$inferInsert;

/**
 * ツール検索 (Executor #2 の候補絞り込み) 用インデックス。
 * 設計: docs/tool-dispatch-redesign.md §12.2 / §12.4。
 *
 * 各ツールに「例文 (example) N 件 + description 1 件」を行として持ち、dense
 * (pgvector cosine) + lexical (PGroonga) のハイブリッド検索で候補を絞る。
 * **元テキスト (text) も保持**し、embed モデル変更時は再インデックスで対応する
 * (= ベクトルは text の導出物)。`embedding_model`/`embedding_dimensions` で stale /
 * 次元不一致を検知、`index_version` で atomic 再構築 (active は tool_index_meta)。
 *
 * UNIQUE(tool_name, kind, md5(text), index_version) / HNSW / PGroonga index は
 * migration 0072 の生 SQL 側で定義 (既存 note_chunks/memory_chunks と同方針)。
 */
export const toolIndex = pgTable("tool_index", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  toolName: text("tool_name").notNull(),
  // 'example' = 発話例 (symmetric retrieval の本体) / 'description' = 説明 (保険)
  kind: text("kind").notNull().$type<"example" | "description">(),
  text: text("text").notNull(), // 元テキスト (再 embed の正本)
  embedding: vector("embedding", { dimensions: 1024 }).notNull(),
  embeddingModel: text("embedding_model").notNull(),
  embeddingDimensions: integer("embedding_dimensions").notNull(),
  indexVersion: text("index_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * tool_index のメタ (key-value)。`active_tool_index_version` を保持し、検索クエリは
 * active version の行だけを見る (再構築は新 version を作り切ってから active を切替)。
 */
export const toolIndexMeta = pgTable("tool_index_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ToolIndexRow = typeof toolIndex.$inferSelect;
export type NewToolIndexRow = typeof toolIndex.$inferInsert;
export type ToolIndexMeta = typeof toolIndexMeta.$inferSelect;
export type NewToolIndexMeta = typeof toolIndexMeta.$inferInsert;
