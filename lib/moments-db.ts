// lib/moments-db.ts
// IndexedDB persistence layer for Moments (朋友圈) posts & comments via Dexie.js.

import Dexie from "dexie";
import type { MomentPost, MomentComment } from "./moments-types";

class MomentsDatabase extends Dexie {
    posts!: Dexie.Table<MomentPost, string>;
    comments!: Dexie.Table<MomentComment, string>;

    constructor() {
        super("AiPhoneMomentsDB");
        this.version(1).stores({
            posts: "id, authorId, createdAt",
            comments: "id, postId, createdAt",
        });
    }
}

export const momentsDb = new MomentsDatabase();

// ── Android 原生 filesDir 分片灾备镜像（保护朋友圈图文动态与评论，仅在整库清空时恢复）──
type NativeVaultBridge = {
    saveLocalDiskData?: (key: string, content: string) => boolean;
    loadLocalDiskData?: (key: string) => string;
    removeLocalDiskData?: (key: string) => boolean;
};

function getNativeVaultBridge(): NativeVaultBridge | null {
    if (typeof window === "undefined") return null;
    const w = window as unknown as { AndroidShell?: NativeVaultBridge };
    return w.AndroidShell ?? null;
}

const MAX_MOMENTS_CHUNK = 3_500_000;

function writeMomentsChunks<T>(prefix: string, items: T[]): void {
    if (typeof window === "undefined") return;
    try {
        const bridge = getNativeVaultBridge();
        if (!bridge || typeof bridge.saveLocalDiskData !== "function") return;
        if (!items || items.length === 0) {
            if (typeof bridge.removeLocalDiskData === "function") {
                bridge.removeLocalDiskData(prefix + "_meta");
                bridge.removeLocalDiskData(prefix + "_p0");
            }
            return;
        }
        const chunks: string[] = [];
        let batch: T[] = [];
        let len = 2;
        for (const item of items) {
            const s = JSON.stringify(item);
            if (batch.length > 0 && len + s.length + 1 > MAX_MOMENTS_CHUNK) {
                chunks.push(JSON.stringify(batch));
                batch = [item];
                len = 2 + s.length;
            } else {
                batch.push(item);
                len += s.length + 1;
            }
        }
        if (batch.length > 0) chunks.push(JSON.stringify(batch));
        for (let i = 0; i < chunks.length; i++) {
            bridge.saveLocalDiskData(prefix + "_p" + i, chunks[i]);
        }
        bridge.saveLocalDiskData(prefix + "_meta", JSON.stringify({ chunks: chunks.length, updatedAt: Date.now() }));
    } catch {}
}

function readMomentsChunks<T>(prefix: string): T[] {
    if (typeof window === "undefined") return [];
    try {
        const bridge = getNativeVaultBridge();
        if (!bridge || typeof bridge.loadLocalDiskData !== "function") return [];
        const metaRaw = bridge.loadLocalDiskData(prefix + "_meta");
        if (!metaRaw) return [];
        const meta = JSON.parse(metaRaw) as { chunks?: number };
        const count = Number(meta?.chunks || 0);
        const out: T[] = [];
        for (let i = 0; i < count; i++) {
            const raw = bridge.loadLocalDiskData(prefix + "_p" + i);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) out.push(...(parsed as T[]));
            }
        }
        return out;
    } catch {
        return [];
    }
}

let _momentsMirrorTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleMomentsMirror(): void {
    if (typeof window === "undefined") return;
    if (_momentsMirrorTimer) clearTimeout(_momentsMirrorTimer);
    _momentsMirrorTimer = setTimeout(() => {
        _momentsMirrorTimer = null;
        Promise.all([
            momentsDb.posts.orderBy("createdAt").reverse().toArray(),
            momentsDb.comments.toArray(),
        ]).then(([p, c]) => {
            writeMomentsChunks("moments_posts_v1", p);
            writeMomentsChunks("moments_comments_v1", c);
        }).catch(() => {});
    }, 1200);
}

/** Load all posts & comments for the in-memory caches. No legacy migration. */
export async function initMomentsDb(): Promise<{ posts: MomentPost[]; comments: MomentComment[] }> {
    if (typeof window === "undefined") return { posts: [], comments: [] };
    try {
        const [loadedPosts, loadedComments] = await Promise.all([
            momentsDb.posts.orderBy("createdAt").reverse().toArray(),
            momentsDb.comments.toArray(),
        ]);
        let posts = loadedPosts;
        let comments = loadedComments;
        if (posts.length === 0 && comments.length === 0) {
            const diskPosts = readMomentsChunks<MomentPost>("moments_posts_v1");
            const diskComments = readMomentsChunks<MomentComment>("moments_comments_v1");
            if (diskPosts.length > 0) {
                posts = diskPosts;
                await momentsDb.posts.bulkPut(diskPosts).catch(() => {});
            }
            if (diskComments.length > 0) {
                comments = diskComments;
                await momentsDb.comments.bulkPut(diskComments).catch(() => {});
            }
        } else {
            writeMomentsChunks("moments_posts_v1", posts);
            writeMomentsChunks("moments_comments_v1", comments);
        }
        return { posts, comments };
    } catch (err) {
        console.warn("[MomentsDB] load failed:", err);
        return { posts: [], comments: [] };
    }
}

// ── Per-record persistence (fire-and-forget) ──

export function dbPutPost(post: MomentPost): void {
    momentsDb.posts.put(post).then(() => scheduleMomentsMirror()).catch(err => console.warn("[MomentsDB] put post failed:", err));
}

export function dbDeletePost(id: string): void {
    momentsDb.posts.delete(id).then(() => scheduleMomentsMirror()).catch(err => console.warn("[MomentsDB] delete post failed:", err));
}

export function dbPutComment(comment: MomentComment): void {
    momentsDb.comments.put(comment).then(() => scheduleMomentsMirror()).catch(err => console.warn("[MomentsDB] put comment failed:", err));
}

export function dbDeleteComment(id: string): void {
    momentsDb.comments.delete(id).then(() => scheduleMomentsMirror()).catch(err => console.warn("[MomentsDB] delete comment failed:", err));
}

export function dbDeleteCommentsByPost(postId: string): void {
    momentsDb.comments.where("postId").equals(postId).delete()
        .then(() => scheduleMomentsMirror())
        .catch(err => console.warn("[MomentsDB] delete post comments failed:", err));
}

// ── Whole-collection replace (for the array-level save APIs) ──

export function dbReplacePosts(posts: MomentPost[]): void {
    writeMomentsChunks("moments_posts_v1", posts);
    momentsDb.transaction("rw", momentsDb.posts, async () => {
        await momentsDb.posts.clear();
        await momentsDb.posts.bulkPut(posts);
    }).catch(err => console.warn("[MomentsDB] replace posts failed:", err));
}
