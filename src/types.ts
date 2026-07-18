/**
 * Shared types for the Bluud CLI.
 */

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
}

export interface AuthSession extends TokenPair {
  token_type: "bearer";
}

export interface ProjectIdentity {
  projectId: string;
  identitySource: "git_remote" | "path_hash";
  gitRemote: string | null;
  path: string;
}

export interface StoredProject {
  projectId: string;
  displayName: string | null;
  identitySource: "git_remote" | "path_hash";
}

export interface MemoryNode {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  description: string;
  body: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
  depth: number;
}

export interface MemoryTree {
  nodes: MemoryNode[];
  total_size_bytes: number;
  quota_usage_ratio: number;
}

export interface MemoryPushResult extends MemoryTree {
  read_only: boolean;
}

export type DiffOperation =
  | { op: "create"; id?: string; document: string }
  | { op: "update"; id: string; document: string }
  | { op: "delete"; id: string };

export interface ProjectStatus {
  project_id: string;
  display_name: string | null;
  identity_source: "git_remote" | "path_hash";
  read_only: boolean;
  is_owner: boolean;
  role: "owner" | "contributor";
  created_at: string;
  last_activity_at: string;
  total_size_bytes: number;
  quota_usage_ratio: number;
  token_active: boolean;
  token_created_at: string | null;
}
