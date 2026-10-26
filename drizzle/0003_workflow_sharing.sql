-- Additive migration: existing workflows remain private, including existing versions.
ALTER TABLE workflows ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
ALTER TABLE workflows ADD COLUMN read_emails TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workflows ADD COLUMN edit_emails TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workflows ADD COLUMN last_modified_by TEXT NOT NULL DEFAULT '';
UPDATE workflows SET last_modified_by=owner_id WHERE last_modified_by='';
CREATE INDEX workflows_visibility_idx ON workflows(visibility);
