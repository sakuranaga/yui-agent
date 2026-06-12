/**
 * 全 ToolDef 集約。
 *
 * 設計: docs/tool-architecture.md §4.3
 *
 * domain 別 1 file 1 ToolDef で構成。新 tool を追加する時は ToolDef を新規 1 file 作成 →
 * このファイルに import + ALL_TOOLS に追記、だけで完了する (= route.ts 触らない)。
 */
import type { ToolDef } from "./types";

// web
import { webSearch } from "./web/web_search";
import { webFetch } from "./web/web_fetch";

// mail
import { gmailSearch } from "./mail/gmail_search";
import { gmailListLabels } from "./mail/gmail_list_labels";

// schedule
import { gcalListEvents } from "./schedule/gcal_list_events";
import { gcalGetEvent } from "./schedule/gcal_get_event";
import { gcalCreateEvent } from "./schedule/gcal_create_event";
import { gcalUpdateEvent } from "./schedule/gcal_update_event";
import { gcalDeleteEvent } from "./schedule/gcal_delete_event";

// timer
import { createTimerTool } from "./timer/create_timer";
import { cancelTimerTool } from "./timer/cancel_timer";
import { listTimersTool } from "./timer/list_timers";

// reminder
import { addReminderTool } from "./reminder/add_reminder";
import { listRemindersTool } from "./reminder/list_reminders";
import { disableReminderTool } from "./reminder/disable_reminder";
import { enableReminderTool } from "./reminder/enable_reminder";
import { deleteReminderTool } from "./reminder/delete_reminder";

// todo
import { addTodoTool } from "./todo/add_todo";
import { updateTodoTool } from "./todo/update_todo";
import { completeTodoTool } from "./todo/complete_todo";
import { deleteTodoTool } from "./todo/delete_todo";
import { listTodosTool } from "./todo/list_todos";
import { getTodoTool } from "./todo/get_todo";
import { searchTodosTool } from "./todo/search_todos";

// project
import { listProjectsTool } from "./project/list_projects";
import { addProjectTool } from "./project/add_project";
import { archiveProjectTool } from "./project/archive_project";

// contact
import { addContactTool } from "./contact/add_contact";
import { updateContactTool } from "./contact/update_contact";
import { appendContactValueTool } from "./contact/append_contact_value";
import { appendContactNoteTool } from "./contact/append_contact_note";
import { findContactTool } from "./contact/find_contact";
import { searchContactsTool } from "./contact/search_contacts";
import { listContactsTool } from "./contact/list_contacts";
import { deleteContactTool } from "./contact/delete_contact";
import { restoreContactTool } from "./contact/restore_contact";

// diary
import { readDiary } from "./diary/read_diary";
import { searchDiaryTool } from "./diary/search_diary";
import { listDiaryTool } from "./diary/list_diary";
import { writeDiaryToday } from "./diary/write_diary_today";

// news
import { listNews } from "./news/list_news";
import { pinNews } from "./news/pin_news";
import { unpinNews } from "./news/unpin_news";
import { searchNews } from "./news/search_news";

// health
import { getFoodSummary } from "./health/get_food_summary";
import { getWorkoutHistory } from "./health/get_workout_history";
import { setHealthGoal } from "./health/set_health_goal";
import { listHealthGoals } from "./health/list_health_goals";
import { disableHealthGoal } from "./health/disable_health_goal";
import { deleteHealthGoal } from "./health/delete_health_goal";
import { getRouteTool } from "./health/get_route";

// status
import { getMyStatus } from "./status/get_my_status";

// brief
import { getMorningBrief } from "./brief/get_morning_brief";
import { listMorningBriefs } from "./brief/list_morning_briefs";

// dict (= TTS 読み方辞書、自律学習)
import { addPronunciation } from "./dict/add_pronunciation";
import { saveNote } from "./note/save_note";
import { searchNotes } from "./note/search_notes";

// music — main 直接 transport (= ask_music_specialist 経由しない)
import { musicPause } from "./music/music_pause";
import { musicResume } from "./music/music_resume";
import { musicNext } from "./music/music_next";
import { musicPrev } from "./music/music_prev";
import { musicVolume } from "./music/music_volume";
import { musicNowPlaying } from "./music/music_now_playing";

// music specialist 内部 tool (= 検索 + 再生 + デバイス制御 + trivia)
import { spotifySearchPlay } from "./music/spotify_search_play";
import { spotifyNowPlaying } from "./music/spotify_now_playing";
import { spotifyVolume } from "./music/spotify_volume";
import { spotifyDevices } from "./music/spotify_devices";
import { spotifyTransferDevice } from "./music/spotify_transfer_device";

export const ALL_TOOLS: ToolDef[] = [
  // web
  webSearch, webFetch,
  // mail (specialist 内部)
  gmailSearch, gmailListLabels,
  // schedule (specialist 内部)
  gcalListEvents, gcalGetEvent, gcalCreateEvent, gcalUpdateEvent, gcalDeleteEvent,
  // timer
  createTimerTool, cancelTimerTool, listTimersTool,
  // reminder
  addReminderTool, listRemindersTool, disableReminderTool, enableReminderTool, deleteReminderTool,
  // todo
  addTodoTool, updateTodoTool, completeTodoTool, deleteTodoTool, listTodosTool, getTodoTool, searchTodosTool,
  // project
  listProjectsTool, addProjectTool, archiveProjectTool,
  // contact
  addContactTool, updateContactTool, appendContactValueTool, appendContactNoteTool,
  findContactTool, searchContactsTool, listContactsTool, deleteContactTool, restoreContactTool,
  // diary
  readDiary, searchDiaryTool, listDiaryTool, writeDiaryToday,
  // news
  listNews, pinNews, unpinNews, searchNews,
  // health
  getFoodSummary, getWorkoutHistory, setHealthGoal, listHealthGoals,
  disableHealthGoal, deleteHealthGoal, getRouteTool,
  // status
  getMyStatus,
  // brief
  getMorningBrief, listMorningBriefs,
  // dict (= TTS 読み方辞書、自律学習)
  addPronunciation,
  // note (ノート空間)
  saveNote, searchNotes,
  // music (direct transport, main)
  musicPause, musicResume, musicNext, musicPrev, musicVolume, musicNowPlaying,
  // music (specialist 内部)
  spotifySearchPlay, spotifyNowPlaying, spotifyVolume, spotifyDevices, spotifyTransferDevice,
];
