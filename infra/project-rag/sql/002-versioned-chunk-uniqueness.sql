BEGIN;

ALTER TABLE project_chunks
  DROP CONSTRAINT IF EXISTS project_chunks_file_chunk_unique;

ALTER TABLE project_chunks
  DROP CONSTRAINT IF EXISTS project_chunks_file_version_chunk_unique;

ALTER TABLE project_chunks
  ADD CONSTRAINT project_chunks_file_version_chunk_unique
  UNIQUE (file_id, version_id, chunk_index);

UPDATE project_chunks AS chunks
SET enabled = false,
    updated_at = now()
FROM project_files AS files
WHERE files.id = chunks.file_id
  AND chunks.version_id IS DISTINCT FROM files.active_version_id
  AND chunks.enabled = true;

COMMIT;
