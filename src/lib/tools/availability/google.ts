/**
 * Google OAuth 関連の capability 可用性判定。
 *
 * v3: service 単位 (`google`) 粗 grouping は撤回し、capability (= scope) 単位で判定。
 * これで「Gmail だけ連携 + GCal 未連携」状態を正しく扱える。
 *
 * 設計: docs/tool-architecture.md §4.4 (v3)
 */
import { loadCurrentToken } from "@/lib/google-oauth";
import type { ToolContext } from "../types";

/** 現 token が指定 scope (完全一致 or 末尾一致) を持つか */
async function hasGoogleScope(scope: string): Promise<boolean> {
  const tok = await loadCurrentToken().catch(() => null);
  if (!tok) return false;
  return tok.scopes.some((s) => s === scope || s.endsWith(`/${scope}`));
}

export const isGmailReadonly = async (
  _: Pick<ToolContext, "sessionId" | "availabilityCache">
): Promise<boolean> => hasGoogleScope("https://www.googleapis.com/auth/gmail.readonly");

export const isGmailModify = async (
  _: Pick<ToolContext, "sessionId" | "availabilityCache">
): Promise<boolean> => hasGoogleScope("https://www.googleapis.com/auth/gmail.modify");

export const isCalendarReadonly = async (
  _: Pick<ToolContext, "sessionId" | "availabilityCache">
): Promise<boolean> => hasGoogleScope("https://www.googleapis.com/auth/calendar.readonly");

export const isCalendarEvents = async (
  _: Pick<ToolContext, "sessionId" | "availabilityCache">
): Promise<boolean> => hasGoogleScope("https://www.googleapis.com/auth/calendar.events");
