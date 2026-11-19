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

// ── Android 原生 filesDir 分片灾备镜像（支持 49MB+ 超长会话分片保存，仅在整库被系统清空时恢复，绝不复活已删数据）──
type NativeVaultBridge = {
    saveLocalDiskData?: (key: string, content: string) => boolean;
    loadLocalDiskData?: (key: string) => string;
    removeLocalDiskData?: (key: string) => boolean;
    listLocalDiskKeys?: () => string;
};

function getNativeVaultBridge(): NativeVaultBridge | null {
    if (typeof window === "undefined") return null;
    const w = window as unknown as { AndroidShell?: NativeVaultBridge };
    return w.AndroidShell ?? null;
}

const MAX_CHUNK_CHARS = 3_500_000;

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

function removeSessionDiskChunks(sessionId: string): void {
    if (typeof window === "undefined" || !sessionId) return;
    try {
        const bridge = getNativeVaultBridge();
        if (!bridge || typeof bridge.removeLocalDiskData !== "function") return;
        bridge.removeLocalDiskData("msg_sess_" + sessionId);
        if (typeof bridge.loadLocalDiskData === "function") {
            const metaRaw = bridge.loadLocalDiskData("msg_meta_" + sessionId);
            if (metaRaw) {
                try {
                    const meta = JSON.parse(metaRaw) as { chunks?: number };
                    const count = Number(meta?.chunks || 0);
                    for (let i = 0; i < count; i++) {
                        bridge.removeLocalDiskData("msg_sess_" + sessionId + "_p" + i);
                    }
                } catch {}
            }
        }
        bridge.removeLocalDiskData("msg_meta_" + sessionId);
    } catch {}
}

function writeSingleSessionDiskMirror(sessionId: string, list: ChatMessage[]): void {
    if (typeof window === "undefined" || !sessionId) return;
    try {
        const bridge = getNativeVaultBridge();
        if (!bridge || typeof bridge.saveLocalDiskData !== "function") return;
        if (!list || list.length === 0) {
            removeSessionDiskChunks(sessionId);
            return;
        }
        const chunks: string[] = [];
        let currentBatch: ChatMessage[] = [];
        let currentLen = 2;
        for (const msg of list) {
            const itemStr = JSON.stringify(msg);
            if (currentBatch.length > 0 && currentLen + itemStr.length + 1 > MAX_CHUNK_CHARS) {
                chunks.push(JSON.stringify(currentBatch));
                currentBatch = [msg];
                currentLen = 2 + itemStr.length;
            } else {
                currentBatch.push(msg);
                currentLen += itemStr.length + 1;
            }
        }
        if (currentBatch.length > 0) chunks.push(JSON.stringify(currentBatch));
        for (let i = 0; i < chunks.length; i++) {
            bridge.saveLocalDiskData("msg_sess_" + sessionId + "_p" + i, chunks[i]);
        }
        bridge.saveLocalDiskData("msg_meta_" + sessionId, JSON.stringify({ chunks: chunks.length, updatedAt: Date.now() }));
        if (typeof bridge.removeLocalDiskData === "function") {
            bridge.removeLocalDiskData("msg_sess_" + sessionId);
        }
    } catch {}
}

function writeMessagesDiskMirror(messages: ChatMessage[]): void {
    if (typeof window === "undefined" || !messages) return;
    try {
        const bridge = getNativeVaultBridge();
        if (!bridge || typeof bridge.saveLocalDiskData !== "function") return;
        const bySession = new Map<string, ChatMessage[]>();
        for (const m of messages) {
            if (!m || !m.sessionId) continue;
            const arr = bySession.get(m.sessionId) || [];
            arr.push(m);
            bySession.set(m.sessionId, arr);
        }
        for (const [sessId, list] of bySession.entries()) {
            writeSingleSessionDiskMirror(sessId, list);
        }
        if (typeof bridge.listLocalDiskKeys === "function" && typeof bridge.removeLocalDiskData === "function") {
            try {
                const keys = JSON.parse(bridge.listLocalDiskKeys() || "[]") as string[];
                for (const k of keys) {
                    if (k.startsWith("msg_meta_")) {
                        const sid = k.slice("msg_meta_".length);
                        if (!bySession.has(sid)) removeSessionDiskChunks(sid);
                    } else if (k.startsWith("msg_sess_") && !k.includes("_p")) {
                        const sid = k.slice("msg_sess_".length);
                        if (!bySession.has(sid)) bridge.removeLocalDiskData(k);
                    }
                }
            } catch {}
        }
        if (typeof bridge.removeLocalDiskData === "function") {
            bridge.removeLocalDiskData(LS_MESSAGES_KEY);
        }
    } catch {}
}

let _msgMirrorTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleMessagesDiskMirror(): void {
    if (typeof window === "undefined") return;
    if (_msgMirrorTimer) clearTimeout(_msgMirrorTimer);
    _msgMirrorTimer = setTimeout(() => {
        _msgMirrorTimer = null;
        chatDb.messages.toArray().then(all => writeMessagesDiskMirror(all)).catch(() => {});
    }, 1500);
}

function readMessagesDiskMirror(): ChatMessage[] {
    if (typeof window === "undefined") return [];
    try {
        const bridge = getNativeVaultBridge();
        if (!bridge || typeof bridge.loadLocalDiskData !== "function") return [];
        const combined: ChatMessage[] = [];
        const seenIds = new Set<string>();
        const addMsgs = (arr: unknown) => {
            if (!Array.isArray(arr)) return;
            for (const m of arr) {
                if (m && typeof m === "object" && "id" in m && typeof (m as ChatMessage).id === "string") {
                    const msg = m as ChatMessage;
                    if (!seenIds.has(msg.id)) {
                        seenIds.add(msg.id);
                        combined.push(msg);
                    }
                }
            }
        };
        if (typeof bridge.listLocalDiskKeys === "function") {
            const keys = JSON.parse(bridge.listLocalDiskKeys() || "[]") as string[];
            for (const k of keys) {
                if (k.startsWith("msg_meta_")) {
                    const sid = k.slice("msg_meta_".length);
                    const metaRaw = bridge.loadLocalDiskData(k);
                    if (metaRaw) {
                        const meta = JSON.parse(metaRaw) as { chunks?: number };
                        const count = Number(meta?.chunks || 0);
                        for (let i = 0; i < count; i++) {
                            const chunkRaw = bridge.loadLocalDiskData("msg_sess_" + sid + "_p" + i);
                            if (chunkRaw) addMsgs(JSON.parse(chunkRaw));
                        }
                    }
                } else if (k.startsWith("msg_sess_") && !k.includes("_p")) {
                    const raw = bridge.loadLocalDiskData(k);
                    if (raw) addMsgs(JSON.parse(raw));
                }
            }
        }
        return combined;
    } catch {}
    return [];
}

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
        let indexedDbHasData = false;
        try {
            const existingCount =
                (await chatDb.messages.count()) +
                (await chatDb.sessions.count()) +
                (await chatDb.contacts.count());
            indexedDbHasData = existingCount > 0;
        } catch (err) {
            console.warn("[ChatDB] Pre-migration IndexedDB check failed; recovering directly:", err);
            const recovered = await loadFromIndexedDbWithRetries();
            if (recovered) {
                markMigrated();
                return recovered;
            }
            throw new Error(`[ChatDB] 无法读取本地聊天数据库（${err instanceof Error ? err.message : String(err)}），已保持未水合状态以避免覆盖真实数据`);
        }

        if (indexedDbHasData) {
            const [messages, sessions, contacts] = await Promise.all([
                chatDb.messages.toArray(),
                chatDb.sessions.toArray(),
                chatDb.contacts.toArray(),
            ]);
            markMigrated();
            try {
                window.localStorage.removeItem(LS_MESSAGES_KEY);
                window.localStorage.removeItem(LS_SESSIONS_KEY);
                window.localStorage.removeItem(LS_CONTACTS_KEY);
            } catch {}
            return { messages, sessions, contacts };
        }

        const diskSessions = readChatDiskMirror<ChatSession>(LS_SESSIONS_KEY);
        const diskContacts = readChatDiskMirror<ChatContact>(LS_CONTACTS_KEY);
        const diskMessages = readMessagesDiskMirror();
        if (diskSessions.length > 0 || diskContacts.length > 0 || diskMessages.length > 0) {
            markMigrated();
            try {
                window.localStorage.removeItem(LS_MESSAGES_KEY);
                window.localStorage.removeItem(LS_SESSIONS_KEY);
                window.localStorage.removeItem(LS_CONTACTS_KEY);
            } catch {}
            if (diskMessages.length > 0) await chatDb.messages.bulkPut(diskMessages).catch(() => {});
            if (diskSessions.length > 0) await chatDb.sessions.bulkPut(diskSessions).catch(() => {});
            if (diskContacts.length > 0) await chatDb.contacts.bulkPut(diskContacts).catch(() => {});
            return { messages: diskMessages, sessions: diskSessions, contacts: diskContacts };
        }

        try {
            const rawMessages = window.localStorage.getItem(LS_MESSAGES_KEY);
            const rawSessions = window.localStorage.getItem(LS_SESSIONS_KEY);
            const rawContacts = window.localStorage.getItem(LS_CONTACTS_KEY);

            const lsMessages: ChatMessage[] = rawMessages ? JSON.parse(rawMessages) : [];
            const lsSessions: ChatSession[] = rawSessions ? JSON.parse(rawSessions) : [];
            const lsContacts: ChatContact[] = rawContacts ? JSON.parse(rawContacts) : [];

            if (lsMessages.length > 0) await chatDb.messages.bulkPut(lsMessages);
            if (lsSessions.length > 0) await chatDb.sessions.bulkPut(lsSessions);
            if (lsContacts.length > 0) await chatDb.contacts.bulkPut(lsContacts);

            window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
            window.localStorage.removeItem(LS_MESSAGES_KEY);
            window.localStorage.removeItem(LS_SESSIONS_KEY);
            window.localStorage.removeItem(LS_CONTACTS_KEY);

            return { messages: lsMessages, sessions: lsSessions, contacts: lsContacts };
        } catch (err) {
            console.error("[ChatDB] Migration failed, falling back to localStorage:", err);
            return {
                messages: safeParse(window.localStorage.getItem(LS_MESSAGES_KEY)),
                sessions: safeParse(window.localStorage.getItem(LS_SESSIONS_KEY)),
                contacts: safeParse(window.localStorage.getItem(LS_CONTACTS_KEY)),
            };
        }
    }

    const loaded = await loadFromIndexedDbWithRetries();
    if (!loaded) {
        throw new Error("[ChatDB] Failed to load after 3 attempts");
    }
    return loaded;
}

function markMigrated(): void {
    try {
        window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
    } catch (err) {
        console.warn("[ChatDB] Failed to persist migration flag:", err);
    }
}

async function loadFromIndexedDbWithRetries(): Promise<{
    messages: ChatMessage[];
    sessions: ChatSession[];
    contacts: ChatContact[];
} | null> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const [loadedMessages, loadedSessions, loadedContacts] = await Promise.all([
                chatDb.messages.toArray(),
                chatDb.sessions.toArray(),
                chatDb.contacts.toArray(),
            ]);
            let messages = loadedMessages;
            let sessions = loadedSessions;
            let contacts = loadedContacts;
            // 仅当整库为空（缓存被系统清空）时才从原生磁盘恢复，绝不复活用户日常主动删除的单条或单个会话
            if (messages.length === 0 && sessions.length === 0) {
                const diskMessages = readMessagesDiskMirror();
                if (diskMessages.length > 0) {
                    messages = diskMessages;
                    await chatDb.messages.bulkPut(diskMessages).catch(() => {});
                }
                const diskSessions = readChatDiskMirror<ChatSession>(LS_SESSIONS_KEY);
                if (diskSessions.length > 0) {
                    sessions = diskSessions;
                    await chatDb.sessions.bulkPut(diskSessions).catch(() => {});
                }
                const diskContacts = readChatDiskMirror<ChatContact>(LS_CONTACTS_KEY);
                if (diskContacts.length > 0) {
                    contacts = diskContacts;
                    await chatDb.contacts.bulkPut(diskContacts).catch(() => {});
                }
            } else {
                writeChatDiskMirror(LS_SESSIONS_KEY, sessions);
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
    chatDb.messages.put(msg).then(() => scheduleMessagesDiskMirror()).catch(err => console.warn("[ChatDB] put message failed:", err));
}

export function dbPutMessages(msgs: ChatMessage[]): void {
    chatDb.messages.bulkPut(msgs).then(() => scheduleMessagesDiskMirror()).catch(err => console.warn("[ChatDB] bulkPut messages failed:", err));
}

const DB_BULK_PUT_CHUNK = 2000;
export async function dbBulkPutMessages(msgs: ChatMessage[]): Promise<void> {
    if (msgs.length === 0) return;
    for (let start = 0; start < msgs.length; start += DB_BULK_PUT_CHUNK) {
        await chatDb.messages.bulkPut(msgs.slice(start, start + DB_BULK_PUT_CHUNK));
    }
    scheduleMessagesDiskMirror();
}

export function dbDeleteMessage(id: string): void {
    chatDb.messages.delete(id).then(() => scheduleMessagesDiskMirror()).catch(err => console.warn("[ChatDB] delete message failed:", err));
}

export function dbDeleteMessagesBySession(sessionId: string): void {
    removeSessionDiskChunks(sessionId);
    chatDb.messages.where("sessionId").equals(sessionId).delete()
        .then(() => scheduleMessagesDiskMirror())
        .catch(err => console.warn("[ChatDB] delete session messages failed:", err));
}

export function dbDeleteMessagesByIds(ids: string[]): void {
    chatDb.messages.bulkDelete(ids).then(() => scheduleMessagesDiskMirror()).catch(err => console.warn("[ChatDB] bulkDelete messages failed:", err));
}

export function dbPutSession(session: ChatSession): void {
    chatDb.sessions.put(session).then(() => chatDb.sessions.toArray().then(s => writeChatDiskMirror(LS_SESSIONS_KEY, s))).catch(err => console.warn("[ChatDB] put session failed:", err));
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
    removeSessionDiskChunks(id);
    chatDb.sessions.delete(id).then(() => chatDb.sessions.toArray().then(s => writeChatDiskMirror(LS_SESSIONS_KEY, s))).catch(err => console.warn("[ChatDB] delete session failed:", err));
}

export function dbPutContacts(contacts: ChatContact[]): void {
    writeChatDiskMirror(LS_CONTACTS_KEY, contacts);
    chatDb.contacts.bulkPut(contacts).catch(err => console.warn("[ChatDB] bulkPut contacts failed:", err));
}

export function dbClearContacts(): void {
    writeChatDiskMirror(LS_CONTACTS_KEY, []);
    chatDb.contacts.clear().catch(err => console.warn("[ChatDB] clear contacts failed:", err));
}

export function dbReplaceContacts(contacts: ChatContact[]): void {
    writeChatDiskMirror(LS_CONTACTS_KEY, contacts);
    chatDb.transaction("rw", chatDb.contacts, async () => {
        await chatDb.contacts.clear();
        await chatDb.contacts.bulkPut(contacts);
    }).catch(err => console.warn("[ChatDB] replaceContacts failed:", err));
}
