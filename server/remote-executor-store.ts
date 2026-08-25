import type { AppDatabase } from "./db.js";
import type { ExecutorTarget } from "./executor-router.js";

const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type StoredExecutorTarget = ExecutorTarget & { updatedAt?: string };

function sameTarget(left: ExecutorTarget, right: ExecutorTarget): boolean {
  return left.kind === right.kind && (left.kind === "tenant" || (right.kind === "remote" && left.projectId === right.projectId));
}

export class RemoteExecutorStore {
  constructor(private readonly db: AppDatabase) {
    this.db.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS conversation_executors (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('tenant','remote')),
        project_id TEXT,
        updated_at TEXT NOT NULL,
        CHECK(
          (kind='tenant' AND project_id IS NULL)
          OR (kind='remote' AND project_id IS NOT NULL)
        )
      );
    `);
  }

  get(conversationId: string): StoredExecutorTarget {
    const row = this.db.sqlite.prepare(`
      SELECT kind,project_id,updated_at FROM conversation_executors WHERE conversation_id=?
    `).get(conversationId) as { kind: "tenant" | "remote"; project_id: string | null; updated_at: string } | undefined;
    if (!row || row.kind === "tenant") return row
      ? { kind: "tenant", updatedAt: row.updated_at }
      : { kind: "tenant" };
    if (!row.project_id || !SAFE_PROJECT_ID.test(row.project_id)) throw new Error("Stored remote executor project id is invalid");
    return { kind: "remote", projectId: row.project_id, updatedAt: row.updated_at };
  }

  set(conversationId: string, target: ExecutorTarget): StoredExecutorTarget {
    if (!this.db.getConversation(conversationId)) throw new Error("Conversation does not exist");
    if (target.kind === "remote" && !SAFE_PROJECT_ID.test(target.projectId)) throw new Error("Invalid remote executor project id");
    const previous = this.get(conversationId);
    const now = new Date().toISOString();
    this.db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      if (!sameTarget(previous, target)) {
        // Codex thread ids belong to one concrete executor/CODEX_HOME. Never
        // carry a tenant thread into a remote machine or between remote projects.
        this.db.sqlite.prepare("UPDATE conversations SET codex_thread_id=NULL,rollout_bytes=NULL,updated_at=? WHERE id=?")
          .run(now, conversationId);
      }
      this.db.sqlite.prepare(`
        INSERT INTO conversation_executors(conversation_id,kind,project_id,updated_at)
        VALUES(?,?,?,?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          kind=excluded.kind,
          project_id=excluded.project_id,
          updated_at=excluded.updated_at
      `).run(conversationId, target.kind, target.kind === "remote" ? target.projectId : null, now);
      this.db.sqlite.exec("COMMIT");
    } catch (error) {
      this.db.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.get(conversationId);
  }

  clear(conversationId: string): void {
    const previous = this.get(conversationId);
    if (previous.kind === "tenant") {
      this.db.sqlite.prepare("DELETE FROM conversation_executors WHERE conversation_id=?").run(conversationId);
      return;
    }
    const now = new Date().toISOString();
    this.db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.db.sqlite.prepare("DELETE FROM conversation_executors WHERE conversation_id=?").run(conversationId);
      this.db.sqlite.prepare("UPDATE conversations SET codex_thread_id=NULL,rollout_bytes=NULL,updated_at=? WHERE id=?")
        .run(now, conversationId);
      this.db.sqlite.exec("COMMIT");
    } catch (error) {
      this.db.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}
