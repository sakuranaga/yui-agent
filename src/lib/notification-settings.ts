/**
 * 通知マトリックス設定の DB アクセス + デフォルト値 + キャッシュ。
 *
 * v2: 3 値 mode_* enum を toast_* / speak_* 2 軸 boolean に分解。
 * 設計: docs/notification-system.md §10
 *
 * デフォルトマトリックス (docs/notification-system.md §3) をコード側で持ち、
 * DB に行があればそちらで上書き。30 秒キャッシュ。
 */
import { db } from "@/db/client";
import {
  notificationSettings,
  type NotificationSetting,
} from "@/db/schema";

/**
 * EventKind: 通知マトリックスで管理する発火元種別。
 * v1 からの変更:
 *   - timer 削除 (= 独自 UI / 設定 BYPASS、設計 §2.8)
 *   - schedule 追加 (= 予定 5 分前リマインド、設計 §2.4)
 */
export type EventKind =
  | "morning_brief"
  | "diary"
  | "news"
  | "mail_important"
  | "mail_other"
  | "music"
  | "schedule"
  | "health"
  | "reminder";

/** Discord 転送ポリシー */
export type DiscordPolicy = "always" | "away_only" | "never";

/** 通知優先度 (= 効果音と連動) */
export type Importance = "high" | "normal" | "low";

/**
 * 旧 3 値 mode (v1 互換、PATCH API の compat 変換でのみ参照)。
 * v2 dispatcher は使わない。
 */
export type LegacyMode = "speak" | "notify" | "silent";

/**
 * 振り分けルール (v2 shape)。
 * toast / speak を独立 boolean で持つ。
 * - toast === false && speak === false → silent
 * - toast === true  && speak === false → 旧 notify (= バッジのみ)
 * - toast === false && speak === true  → 新規 (= 読み上げのみ、トースト出さない)
 * - toast === true  && speak === true  → 旧 speak (= バッジ + 読み上げ)
 */
export type Rule = {
  eventKind: EventKind;
  toastOnline: boolean;
  speakOnline: boolean;
  toastAway: boolean;
  speakAway: boolean;
  toastFocus: boolean;
  speakFocus: boolean;
  discordPolicy: DiscordPolicy;
  importance: Importance;
};

/**
 * デフォルトマトリックス。DB に値がない場合のフォールバック。
 * 設定 UI の「既定値に戻す」もこれを使う。
 *
 * 設計表: docs/notification-system.md §3
 */
export const DEFAULT_RULES: Rule[] = [
  // 朝のブリーフィング: 全 state で toast のみ (= speak は別経路で朝挨拶を fire するため重複防止)
  {
    eventKind: "morning_brief",
    toastOnline: true,  speakOnline: false,
    toastAway:   true,  speakAway:   false,
    toastFocus:  true,  speakFocus:  false,
    discordPolicy: "always",
    importance: "normal",
  },
  // 日記生成完了: toast のみ (= バックグラウンド作業)
  {
    eventKind: "diary",
    toastOnline: true,  speakOnline: false,
    toastAway:   true,  speakAway:   false,
    toastFocus:  true,  speakFocus:  false,
    discordPolicy: "away_only",
    importance: "low",
  },
  // ニュース新着: online のみ speak、それ以外 toast のみ
  {
    eventKind: "news",
    toastOnline: true,  speakOnline: true,
    toastAway:   true,  speakAway:   false,
    toastFocus:  true,  speakFocus:  false,
    discordPolicy: "away_only",
    importance: "low",
  },
  // メール (重要送信者): online で speak、離席 / 集中は toast のみ
  {
    eventKind: "mail_important",
    toastOnline: true,  speakOnline: true,
    toastAway:   true,  speakAway:   false,
    toastFocus:  true,  speakFocus:  false,
    discordPolicy: "away_only",
    importance: "high",
  },
  // メール (それ以外): toast のみ
  {
    eventKind: "mail_other",
    toastOnline: true,  speakOnline: false,
    toastAway:   true,  speakAway:   false,
    toastFocus:  true,  speakFocus:  false,
    discordPolicy: "away_only",
    importance: "normal",
  },
  // 音楽トラック切替: online のみ speak (= 曲名を声で教えてほしい)、toast はせず邪魔しない
  {
    eventKind: "music",
    toastOnline: false, speakOnline: true,
    toastAway:   false, speakAway:   false,
    toastFocus:  false, speakFocus:  false,
    discordPolicy: "never",
    importance: "low",
  },
  // 予定 (5 分前): 全 state で toast + speak (= 仕事を逃さない、集中中でも speak)
  {
    eventKind: "schedule",
    toastOnline: true,  speakOnline: true,
    toastAway:   true,  speakAway:   true,
    toastFocus:  true,  speakFocus:  true,
    discordPolicy: "away_only",
    importance: "high",
  },
  // 体調 / 健康警告 (将来 Phase G+): デフォルトは toast + speak (online のみ)
  {
    eventKind: "health",
    toastOnline: true,  speakOnline: true,
    toastAway:   true,  speakAway:   false,
    toastFocus:  true,  speakFocus:  false,
    discordPolicy: "away_only",
    importance: "high",
  },
  // リマインダー: 集中中だけ speak (= focus 中に reminder を逃すと意味ない)
  {
    eventKind: "reminder",
    toastOnline: true,  speakOnline: false,
    toastAway:   true,  speakAway:   false,
    toastFocus:  true,  speakFocus:  true,
    discordPolicy: "away_only",
    importance: "normal",
  },
];

const DEFAULT_BY_KIND: Map<EventKind, Rule> = new Map(
  DEFAULT_RULES.map((r) => [r.eventKind, r])
);

let cachedRules: Rule[] | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;

function rowToRule(r: NotificationSetting): Rule {
  return {
    eventKind: r.eventKind as EventKind,
    toastOnline: r.toastOnline,
    speakOnline: r.speakOnline,
    toastAway: r.toastAway,
    speakAway: r.speakAway,
    toastFocus: r.toastFocus,
    speakFocus: r.speakFocus,
    discordPolicy: r.discordPolicy as DiscordPolicy,
    importance: r.importance as Importance,
  };
}

export async function loadAllRules(): Promise<Rule[]> {
  if (cachedRules && Date.now() - cachedAt < CACHE_TTL_MS) return cachedRules;
  try {
    const rows = await db.select().from(notificationSettings);
    const byKind = new Map<EventKind, Rule>();
    for (const r of rows) {
      const kind = r.eventKind as EventKind;
      // v2 EventKind に登録されていない行 (= 旧 "timer" 行など) はスキップ
      if (!DEFAULT_BY_KIND.has(kind)) continue;
      byKind.set(kind, rowToRule(r));
    }
    // デフォルトを補完 (DB に無い event_kind は default で埋める)
    const merged: Rule[] = DEFAULT_RULES.map((d) => byKind.get(d.eventKind) ?? d);
    cachedRules = merged;
    cachedAt = Date.now();
    return merged;
  } catch (e) {
    console.warn("[notification-settings] load failed, using defaults:", e);
    return DEFAULT_RULES;
  }
}

export async function getRule(kind: EventKind | string): Promise<Rule> {
  const all = await loadAllRules();
  const found = all.find((r) => r.eventKind === kind);
  return found ?? DEFAULT_BY_KIND.get(kind as EventKind) ?? DEFAULT_RULES[0];
}

/**
 * 既存 rule に patch を当てて upsert する。
 * 旧 mode_* 列は v2 でも書き続ける (= compat 期間中 / rollback 保険)。
 */
export async function updateRule(
  kind: EventKind,
  patch: Partial<Omit<Rule, "eventKind">>
): Promise<void> {
  const current = await getRule(kind);
  const next: Rule = { ...current, ...patch, eventKind: kind };

  // 旧 3 値 mode 値を新 boolean から逆算 (= compat 期間の DB 互換性のため)
  const toLegacyMode = (toast: boolean, speak: boolean): LegacyMode => {
    if (speak) return "speak";
    if (toast) return "notify";
    return "silent";
  };

  await db
    .insert(notificationSettings)
    .values({
      eventKind: kind,
      modeOnline: toLegacyMode(next.toastOnline, next.speakOnline),
      modeAway:   toLegacyMode(next.toastAway,   next.speakAway),
      modeFocus:  toLegacyMode(next.toastFocus,  next.speakFocus),
      toastOnline: next.toastOnline,
      speakOnline: next.speakOnline,
      toastAway:   next.toastAway,
      speakAway:   next.speakAway,
      toastFocus:  next.toastFocus,
      speakFocus:  next.speakFocus,
      discordPolicy: next.discordPolicy,
      importance: next.importance,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: notificationSettings.eventKind,
      set: {
        modeOnline: toLegacyMode(next.toastOnline, next.speakOnline),
        modeAway:   toLegacyMode(next.toastAway,   next.speakAway),
        modeFocus:  toLegacyMode(next.toastFocus,  next.speakFocus),
        toastOnline: next.toastOnline,
        speakOnline: next.speakOnline,
        toastAway:   next.toastAway,
        speakAway:   next.speakAway,
        toastFocus:  next.toastFocus,
        speakFocus:  next.speakFocus,
        discordPolicy: next.discordPolicy,
        importance: next.importance,
        updatedAt: new Date(),
      },
    });
  cachedRules = null;
  cachedAt = 0;
}

/** 全 event_kind を default に戻す。 */
export async function resetAllRules(): Promise<void> {
  const toLegacyMode = (toast: boolean, speak: boolean): LegacyMode => {
    if (speak) return "speak";
    if (toast) return "notify";
    return "silent";
  };
  await db.delete(notificationSettings);
  for (const d of DEFAULT_RULES) {
    await db.insert(notificationSettings).values({
      eventKind: d.eventKind,
      modeOnline: toLegacyMode(d.toastOnline, d.speakOnline),
      modeAway:   toLegacyMode(d.toastAway,   d.speakAway),
      modeFocus:  toLegacyMode(d.toastFocus,  d.speakFocus),
      toastOnline: d.toastOnline,
      speakOnline: d.speakOnline,
      toastAway:   d.toastAway,
      speakAway:   d.speakAway,
      toastFocus:  d.toastFocus,
      speakFocus:  d.speakFocus,
      discordPolicy: d.discordPolicy,
      importance: d.importance,
    });
  }
  cachedRules = null;
  cachedAt = 0;
}

export function invalidateCache(): void {
  cachedRules = null;
  cachedAt = 0;
}

/**
 * 旧 3 値 mode を新 2 軸 boolean に変換する helper (= PATCH API compat 用)。
 * 設計: docs/notification-system.md §12.3
 */
export function legacyModeToFlags(m: LegacyMode): { toast: boolean; speak: boolean } {
  return {
    toast: m === "speak" || m === "notify",
    speak: m === "speak",
  };
}
