-- 기존 자료와 공유 범위는 유지하고 선택적인 확장 필드만 추가한다.
ALTER TABLE resources ADD COLUMN details TEXT NOT NULL DEFAULT 'null';
ALTER TABLE resources ADD COLUMN files TEXT NOT NULL DEFAULT '[]';
ALTER TABLE resources ADD COLUMN write_token TEXT NOT NULL DEFAULT '';
CREATE TABLE resource_versions (id TEXT PRIMARY KEY NOT NULL, resource_id TEXT NOT NULL, number INTEGER NOT NULL, actor_id TEXT NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX resource_versions_number_idx ON resource_versions(resource_id, number);
CREATE TABLE resource_files (id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, resource_id TEXT, path TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, storage_key TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX resource_files_resource_idx ON resource_files(resource_id);
CREATE INDEX resource_files_owner_idx ON resource_files(owner_id);
CREATE TABLE resource_file_chunks (file_id TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL);
CREATE UNIQUE INDEX resource_file_chunks_part_idx ON resource_file_chunks(file_id,part);
