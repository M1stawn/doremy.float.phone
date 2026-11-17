// lib/chat-db.ts
// IndexedDB persistence layer for chat data using Dexie.js.
// Provides async persistence behind the synchronous in-memory cache in chat-storage.ts.

import Dexie from "dexie";
import type { ChatMessage, ChatSession, ChatContact } from "./chat-storage";

// ── Database Schema ──────────────────────────────

class ChatDatabase extends Dexie {
    messages!: Dexie.Table<ChatMessage, string>;
    sessions!: Dexie.Table<ChatSession, string>;
    contacts!: Dexie.Table<ChatContact, string>;

    constructor() {
        super("AiPhoneChatDB");
        this.version(1).stores({
            messages: "id, sessionId, createdAt",
            sessions: "id, contactId",
            contacts: "id, characterId",
        });
    }
}

export const chatDb = new ChatDatabase();

// ── Initialization + Migration from localStorage ──

const LS_MESSAGES_KEY = "ai_phone_chat_messages_v1";
const LS_SESSIONS_KEY = "ai_phone_chat_sessions_v1";
const LS_CONTACTS_KEY = "ai_phone_chat_contacts_v1";
const LS_MIGRATED_FLAG = "ai_phone_idb_migrated_v1";

// ── Android 原生 filesDir 永久磁盘镜像（防止删聊天退后台时 clear+bulkPut 中断丢失会话与联系人）──
type NativeVaultBridge = {
    saveLocalDiskData?: (key: string, content: string) => boolean;
    loadLocalDiskData?: (key: string) => string;
};
function getNativeVaultBridge(): NativeVaultBridge | null {
    if (typeof window === "undefined") return null;
    const w = window as unknown as { AndroidShell?: NativeVaultBridge };
    return w.AndroidShell ?? null;
}
function writeChatDiskMirror<T>(key: string, items: T[]): void {
    if (typeof window === "undefined") return;
    try {
        const bridge = getNativeVaultBridge();
        if (bridge && typeof bridge.saveLocalDiskData === "function") {
            const raw = JSON.stringify(items);
            if (raw.length <= 6_000_000) bridge.saveLocalDiskData(key, raw);
        }
    } catch {}
}
function readChatDiskMirror<T>(key: string): T[] {
    if (typeof window === "undefined") return [];
    try {
        const bridge = getNativeVaultBridge();
        if (bridge && typeof bridge.loadLocalDiskData === "function") {
            const raw = bridge.loadLocalDiskData(key);
            if (raw && raw.trim().length > 2) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) return parsed as T[];
            }
        }
    } catch {}
    return [];
}


/**
 * Initialize IndexedDB and migrate data from localStorage if needed.
 * Returns the loaded data for the in-memory caches.
 */
export async function initChatDb(): Promise<{
    messages: ChatMessage[];
    sessions: ChatSession[];
    contacts: ChatContact[];
}> {
    if (typeof window === "undefined") {
        return { messages: [], sessions: [], contacts: [] };
    }

    const alreadyMigrated = window.localStorage.getItem(LS_MIGRATED_FLAG);

    if (!alreadyMigrated) {
        // ── 防误清防线 ──────────────────────────────────────────
        // 迁移标记在易失的 localStorage，真实数据在更持久的 IndexedDB。标记可能
        // 单独消失（清「缓存」、隐私工具、配额逐出）。这里任何一步出错（包括
        // localStorage 配额满导致 setItem 抛错）都绝不允许落入下方「全新安装」的
        // 迁移分支——那个分支会把空的 localStorage 当成真数据返回并删掉旧键，
        // 水合后的第一次全量保存（dbReplaceSessions = clear + put）就会把
        // IndexedDB 里的真实会话/联系人整表清掉，也就是「小手机全部变成初始
        // 状态」的事故。
        let indexedDbHasData = false;
        try {
            const existingCount =
                (await chatDb.messages.count()) +
                (await chatDb.sessions.count()) +
                (await chatDb.contacts.count());
            indexedDbHasData = existingCount > 0;
        } catch (err) {
            // 探测失败（被占用/配额/瞬时错误）≠ 空库：改走带重试的 IndexedDB
            // 直读；仍失败就抛错保持「未水合」状态——所有写路径会自动退化为
            // 只增不改（见 chat-storage.ts），宁可见空也不能用空数据覆盖真库。
            console.warn("[ChatDB] Pre-migration IndexedDB check failed; recovering directly:", err);
            const recovered = await loadFromIndexedDbWithRetries();
            if (recovered) {
                markMigrated();
                return recovered;
            }
            throw new Error(`[ChatDB] 无法读取本地聊天数据库（${
                err instanceof Error ? err.message : String(err)
            }），已保持未水合状态以避免覆盖真实数据`);
        }

        if (indexedDbHasData) {
            const [messages, sessions, contacts] = await Promise.all([
                chatDb.messages.toArray(),
                chatDb.sessions.toArray(),
                chatDb.contacts.toArray(),
            ]);
            // 标记写失败（localStorage 配额满）只是性能问题，绝不能连带
            // 丢弃已读出的 IndexedDB 数据。
            markMigrated();
            console.log(`[ChatDB] Migration flag missing but IndexedDB has data; reusing it: ${messages.length} messages, ${sessions.length} sessions, ${contacts.length} contacts`);
            return { messages, sessions, contacts };
        }

        // First run after migration: move localStorage data → IndexedDB
        try {
            const rawMessages = window.localStorage.getItem(LS_MESSAGES_KEY);
            const rawSessions = window.localStorage.getItem(LS_SESSIONS_KEY);
            const rawContacts = window.localStorage.getItem(LS_CONTACTS_KEY);

            const lsMessages: ChatMessage[] = rawMessages ? JSON.parse(rawMessages) : [];
            const lsSessions: ChatSession[] = rawSessions ? JSON.parse(rawSessions) : [];
            const lsContacts: ChatContact[] = rawContacts ? JSON.parse(rawContacts) : [];

            if (lsMessages.length > 0) {
                await chatDb.messages.bulkPut(lsMessages);
            }
            if (lsSessions.length > 0) {
                await chatDb.sessions.bulkPut(lsSessions);
            }
            if (lsContacts.length > 0) {
                await chatDb.contacts.bulkPut(lsContacts);
            }

            // Mark as migrated and remove old localStorage data
            window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
            window.localStorage.removeItem(LS_MESSAGES_KEY);
            window.localStorage.removeItem(LS_SESSIONS_KEY);
            window.localStorage.removeItem(LS_CONTACTS_KEY);

            console.log(`[ChatDB] Migrated from localStorage: ${lsMessages.length} messages, ${lsSessions.length} sessions, ${lsContacts.length} contacts`);

            return { messages: lsMessages, sessions: lsSessions, contacts: lsContacts };
        } catch (err) {
            console.error("[ChatDB] Migration failed, falling back to localStorage:", err);
            // If migration fails, load from localStorage as fallback
            const fallbackMessages: ChatMessage[] = safeParse(window.localStorage.getItem(LS_MESSAGES_KEY));
            const fallbackSessions: ChatSession[] = safeParse(window.localStorage.getItem(LS_SESSIONS_KEY));
            const fallbackContacts: ChatContact[] = safeParse(window.localStorage.getItem(LS_CONTACTS_KEY));
            return { messages: fallbackMessages, sessions: fallbackSessions, contacts: fallbackContacts };
        }
    }

    // Already migrated: load from IndexedDB (with retries)
    const loaded = await loadFromIndexedDbWithRetries();
    if (!loaded) {
        throw new Error("[ChatDB] Failed to load after 3 attempts");
    }
    return loaded;
}

/** 写迁移标记；失败（如 localStorage 配额满）只是性能问题，不应升级成数据事故。 */
function markMigrated(): void {
    try {
        window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
    } catch (err) {
        console.warn("[ChatDB] Failed to persist migration flag:", err);
    }
}

/** 从 IndexedDB 读取全部数据，失败重试最多 3 次；全部失败返回 null（由调用方决定是否抛错）。 */
async function loadFromIndexedDbWithRetries(): Promise<{
    messages: ChatMessage[];
    sessions: ChatSession[];
    contacts: ChatContact[];
} | null> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const [messages, loadedSessions, loadedContacts] = await Promise.all([
                chatDb.messages.toArray(),
                chatDb.sessions.toArray(),
                chatDb.contacts.toArray(),
            ]);
            let sessions = loadedSessions;
            let contacts = loadedContacts;
            if (sessions.length === 0) {
                const diskSessions = readChatDiskMirror<ChatSession>(LS_SESSIONS_KEY);
                if (diskSessions.length > 0) {
                    sessions = diskSessions;
                    await chatDb.sessions.bulkPut(diskSessions).catch(() => {});
                }
            } else {
                writeChatDiskMirror(LS_SESSIONS_KEY, sessions);
            }
            if (contacts.length === 0) {
                const diskContacts = readChatDiskMirror<ChatContact>(LS_CONTACTS_KEY);
                if (diskContacts.length > 0) {
                    contacts = diskContacts;
                    await chatDb.contacts.bulkPut(diskContacts).catch(() => {});
                }
            } else {
                writeChatDiskMirror(LS_CONTACTS_KEY, contacts);
            }
            console.log(`[ChatDB] Loaded from IndexedDB: ${messages.length} messages, ${sessions.length} sessions, ${contacts.length} contacts`);
            return { messages, sessions, contacts };
        } catch (err) {
            lastErr = err;
            console.warn(`[ChatDB] Load attempt ${attempt + 1}/3 failed:`, err);
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
                try { if (!chatDb.isOpen()) await chatDb.open(); } catch {}
            }
        }
    }
    console.error("[ChatDB] All load attempts failed:", lastErr);
    return null;
}

function safeParse<T>(raw: string | null): T[] {
    try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

// ── Async persistence helpers (fire-and-forget) ──

export function dbPutMessage(msg: ChatMessage): void {
    chatDb.messages.put(msg).catch(err => console.warn("[ChatDB] put message failed:", err));
}

export function dbPutMessages(msgs: ChatMessage[]): void {
    chatDb.messages.bulkPut(msgs).catch(err => console.warn("[ChatDB] bulkPut messages failed:", err));
}

// 可等待、错误上抛、分块提交的批量写入。导入聊天记录这类大批量落库必须
// 感知真实结果（配额满/写入失败要能反馈给用户），且分块避免巨型单事务
// 卡死主线程；每块之间自然让出事件循环，页面保持可响应。
const DB_BULK_PUT_CHUNK = 2000;
export async function dbBulkPutMessages(msgs: ChatMessage[]): Promise<void> {
    if (msgs.length === 0) return;
    for (let start = 0; start < msgs.length; start += DB_BULK_PUT_CHUNK) {
        await chatDb.messages.bulkPut(msgs.slice(start, start + DB_BULK_PUT_CHUNK));
    }
}

export function dbDeleteMessage(id: string): void {
    chatDb.messages.delete(id).catch(err => console.warn("[ChatDB] delete message failed:", err));
}

export function dbDeleteMessagesBySession(sessionId: string): void {
    chatDb.messages.where("sessionId").equals(sessionId).delete()
        .catch(err => console.warn("[ChatDB] delete session messages failed:", err));
}

export function dbDeleteMessagesByIds(ids: string[]): void {
    chatDb.messages.bulkDelete(ids).catch(err => console.warn("[ChatDB] bulkDelete messages failed:", err));
}

export function dbPutSession(session: ChatSession): void {
    chatDb.sessions.put(session).catch(err => console.warn("[ChatDB] put session failed:", err));
}

export function dbPutSessions(sessions: ChatSession[]): void {
    writeChatDiskMirror(LS_SESSIONS_KEY, sessions);
    chatDb.sessions.bulkPut(sessions).catch(err => console.warn("[ChatDB] bulkPut sessions failed:", err));
}

export function dbReplaceSessions(sessions: ChatSession[]): void {
    writeChatDiskMirror(LS_SESSIONS_KEY, sessions);
    chatDb.transaction("rw", chatDb.sessions, async () => {
        await chatDb.sessions.clear();
        await chatDb.sessions.bulkPut(sessions);
    }).catch(err => console.warn("[ChatDB] replace sessions failed:", err));
}

export function dbDeleteSession(id: string): void {
    chatDb.sessions.delete(id).catch(err => console.warn("[ChatDB] delete session failed:", err));
}

export function dbPutContacts(contacts: ChatContact[]): void {
    writeChatDiskMirror(LS_CONTACTS_KEY, contacts);
    chatDb.contacts.bulkPut(contacts).catch(err => console.warn("[ChatDB] bulkPut contacts failed:", err));
}

export function dbClearContacts(): void {
    chatDb.contacts.clear().catch(err => console.warn("[ChatDB] clear contacts failed:", err));
}

export function dbReplaceContacts(contacts: ChatContact[]): void {
    writeChatDiskMirror(LS_CONTACTS_KEY, contacts);
    chatDb.transaction("rw", chatDb.contacts, async () => {
        await chatDb.contacts.clear();
        await chatDb.contacts.bulkPut(contacts);
    }).catch(err => console.warn("[ChatDB] replaceContacts failed:", err));
}
