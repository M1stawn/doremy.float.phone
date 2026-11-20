// lib/moments-db.ts
// IndexedDB persistence layer for Moments (朋友圈) posts & comments via Dexie.js,
// backed by Android native disk vault mirroring with immediate delete sync.

import Dexie from "dexie";
import type { MomentPost, MomentComment } from "./moments-types";
import {
    VAULT_KEYS,
    hasNativeVault,
    vaultHasKey,
    vaultReadJson,
    vaultReadLegacyChunkedArray,
    vaultRemove,
    vaultRemoveLegacyChunked,
    vaultWriteJson,
} from "./native-vault";

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

let _postsMirrorTimer: ReturnType<typeof setTimeout> | null = null;
let _commentsMirrorTimer: ReturnType<typeof setTimeout> | null = null;

function writePostsMirror(posts: MomentPost[]): void {
    if (!hasNativeVault()) return;
    if (posts.length === 0) {
        vaultRemove(VAULT_KEYS.MOMENTS_POSTS);
    } else {
        vaultWriteJson(VAULT_KEYS.MOMENTS_POSTS, posts);
    }
    vaultRemoveLegacyChunked(VAULT_KEYS.MOMENTS_POSTS);
}

function writeCommentsMirror(comments: MomentComment[]): void {
    if (!hasNativeVault()) return;
    if (comments.length === 0) {
        vaultRemove(VAULT_KEYS.MOMENTS_COMMENTS);
    } else {
        vaultWriteJson(VAULT_KEYS.MOMENTS_COMMENTS, comments);
    }
    vaultRemoveLegacyChunked(VAULT_KEYS.MOMENTS_COMMENTS);
}

function readPostsMirror(): MomentPost[] {
    const current = vaultReadJson<MomentPost[]>(VAULT_KEYS.MOMENTS_POSTS);
    if (Array.isArray(current) && current.length > 0) return current;
    return vaultReadLegacyChunkedArray<MomentPost>(VAULT_KEYS.MOMENTS_POSTS);
}

function readCommentsMirror(): MomentComment[] {
    const current = vaultReadJson<MomentComment[]>(VAULT_KEYS.MOMENTS_COMMENTS);
    if (Array.isArray(current) && current.length > 0) return current;
    return vaultReadLegacyChunkedArray<MomentComment>(VAULT_KEYS.MOMENTS_COMMENTS);
}

async function flushPostsMirrorNow(): Promise<void> {
    if (!hasNativeVault()) return;
    if (_postsMirrorTimer) {
        clearTimeout(_postsMirrorTimer);
        _postsMirrorTimer = null;
    }
    try {
        const posts = await momentsDb.posts.orderBy("createdAt").reverse().toArray();
        writePostsMirror(posts);
    } catch {
        // ignore
    }
}

async function flushCommentsMirrorNow(): Promise<void> {
    if (!hasNativeVault()) return;
    if (_commentsMirrorTimer) {
        clearTimeout(_commentsMirrorTimer);
        _commentsMirrorTimer = null;
    }
    try {
        const comments = await momentsDb.comments.toArray();
        writeCommentsMirror(comments);
    } catch {
        // ignore
    }
}

function schedulePostsMirror(): void {
    if (!hasNativeVault()) return;
    if (_postsMirrorTimer) clearTimeout(_postsMirrorTimer);
    _postsMirrorTimer = setTimeout(() => {
        _postsMirrorTimer = null;
        void flushPostsMirrorNow();
    }, 500);
}

function scheduleCommentsMirror(): void {
    if (!hasNativeVault()) return;
    if (_commentsMirrorTimer) clearTimeout(_commentsMirrorTimer);
    _commentsMirrorTimer = setTimeout(() => {
        _commentsMirrorTimer = null;
        void flushCommentsMirrorNow();
    }, 500);
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
            const diskPosts = readPostsMirror();
            const diskComments = readCommentsMirror();
            if (diskPosts.length > 0) {
                posts = diskPosts;
                await momentsDb.posts.bulkPut(diskPosts).catch(() => {});
            }
            if (diskComments.length > 0) {
                comments = diskComments;
                await momentsDb.comments.bulkPut(diskComments).catch(() => {});
            }
        } else if (hasNativeVault()) {
            if (posts.length > 0 && !vaultHasKey(VAULT_KEYS.MOMENTS_POSTS)) {
                writePostsMirror(posts);
            }
            if (comments.length > 0 && !vaultHasKey(VAULT_KEYS.MOMENTS_COMMENTS)) {
                writeCommentsMirror(comments);
            }
        }
        return { posts, comments };
    } catch (err) {
        console.warn("[MomentsDB] load failed:", err);
        return { posts: [], comments: [] };
    }
}

// ── Per-record persistence ──

export function dbPutPost(post: MomentPost): void {
    momentsDb.posts.put(post)
        .then(() => schedulePostsMirror())
        .catch((err) => console.warn("[MomentsDB] put post failed:", err));
}

export function dbDeletePost(id: string): void {
    momentsDb.posts.delete(id)
        .then(() => flushPostsMirrorNow())
        .catch((err) => console.warn("[MomentsDB] delete post failed:", err));
}

export function dbPutComment(comment: MomentComment): void {
    momentsDb.comments.put(comment)
        .then(() => scheduleCommentsMirror())
        .catch((err) => console.warn("[MomentsDB] put comment failed:", err));
}

export function dbDeleteComment(id: string): void {
    momentsDb.comments.delete(id)
        .then(() => flushCommentsMirrorNow())
        .catch((err) => console.warn("[MomentsDB] delete comment failed:", err));
}

export function dbDeleteCommentsByPost(postId: string): void {
    momentsDb.comments.where("postId").equals(postId).delete()
        .then(() => flushCommentsMirrorNow())
        .catch((err) => console.warn("[MomentsDB] delete post comments failed:", err));
}

// ── Whole-collection replace (for the array-level save APIs) ──

export function dbReplacePosts(posts: MomentPost[]): void {
    if (_postsMirrorTimer) {
        clearTimeout(_postsMirrorTimer);
        _postsMirrorTimer = null;
    }
    writePostsMirror(posts);
    momentsDb.transaction("rw", momentsDb.posts, async () => {
        await momentsDb.posts.clear();
        await momentsDb.posts.bulkPut(posts);
    }).catch((err) => console.warn("[MomentsDB] replace posts failed:", err));
}
