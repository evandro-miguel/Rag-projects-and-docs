BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE OR REPLACE FUNCTION docs_rag_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION docs_rag_refresh_document_search()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.title_normalized := lower(unaccent(coalesce(NEW.title, '')));
  NEW.source_path_normalized := lower(unaccent(coalesce(NEW.source_path, '')));
  NEW.search_text_normalized := lower(
    unaccent(
      concat_ws(
        ' ',
        NEW.title,
        NEW.category,
        NEW.kind,
        NEW.language,
        NEW.authority,
        coalesce(nullif(NEW.searchable_text, ''), NEW.content)
      )
    )
  );
  NEW.search_vector := to_tsvector('simple', NEW.search_text_normalized);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION docs_rag_refresh_chunk_search()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_text_normalized := lower(
    unaccent(
      concat_ws(' ', NEW.heading, NEW.section, coalesce(nullif(NEW.searchable_text, ''), NEW.content))
    )
  );
  NEW.search_vector := to_tsvector('simple', NEW.search_text_normalized);
  RETURN NEW;
END;
$$;

CREATE TABLE docs_documents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id text NOT NULL,
  source_path text NOT NULL,
  source_absolute_path text,
  title text NOT NULL,
  category text,
  kind text,
  language text,
  authority text,
  canonical_url text,
  content_hash text NOT NULL,
  searchable_text text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'indexed',
  title_normalized text NOT NULL DEFAULT '',
  source_path_normalized text NOT NULL DEFAULT '',
  search_text_normalized text NOT NULL DEFAULT '',
  search_vector tsvector NOT NULL DEFAULT ''::tsvector,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT docs_documents_source_identity_unique UNIQUE (source_id, source_path),
  CONSTRAINT docs_documents_status_check CHECK (status IN ('pending', 'indexed', 'error'))
);

CREATE TABLE docs_chunks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES docs_documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  heading text,
  section text,
  content text NOT NULL,
  searchable_text text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  start_line integer,
  end_line integer,
  token_count integer,
  enabled boolean NOT NULL DEFAULT true,
  search_text_normalized text NOT NULL DEFAULT '',
  search_vector tsvector NOT NULL DEFAULT ''::tsvector,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT docs_chunks_document_chunk_unique UNIQUE (document_id, chunk_index),
  CONSTRAINT docs_chunks_line_order_check CHECK (
    start_line IS NULL OR end_line IS NULL OR start_line <= end_line
  )
);

CREATE TABLE docs_embeddings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id bigint REFERENCES docs_documents(id) ON DELETE CASCADE,
  chunk_id bigint REFERENCES docs_chunks(id) ON DELETE CASCADE,
  embedding_kind text NOT NULL,
  embedding_model text NOT NULL,
  embedding_provider text,
  embedding_dimensions integer NOT NULL DEFAULT 1024,
  embedding halfvec(1024) NOT NULL,
  source_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT docs_embeddings_owner_check CHECK (
    (document_id IS NOT NULL AND chunk_id IS NULL)
    OR (document_id IS NULL AND chunk_id IS NOT NULL)
  ),
  CONSTRAINT docs_embeddings_kind_check CHECK (embedding_kind IN ('document', 'chunk')),
  CONSTRAINT docs_embeddings_dimensions_check CHECK (embedding_dimensions = 1024)
);

CREATE INDEX docs_documents_source_path_idx ON docs_documents (source_path);
CREATE INDEX docs_documents_source_id_idx ON docs_documents (source_id);
CREATE INDEX docs_documents_category_idx ON docs_documents (category);
CREATE INDEX docs_documents_kind_idx ON docs_documents (kind);
CREATE INDEX docs_documents_language_idx ON docs_documents (language);
CREATE INDEX docs_documents_authority_idx ON docs_documents (authority);
CREATE INDEX docs_documents_status_idx ON docs_documents (status);
CREATE INDEX docs_documents_content_hash_idx ON docs_documents (content_hash);
CREATE INDEX docs_documents_title_trgm_idx
  ON docs_documents USING gin (title_normalized gin_trgm_ops);
CREATE INDEX docs_documents_path_trgm_idx
  ON docs_documents USING gin (source_path_normalized gin_trgm_ops);
CREATE INDEX docs_documents_search_vector_idx ON docs_documents USING gin (search_vector);

CREATE INDEX docs_chunks_document_id_idx ON docs_chunks (document_id);
CREATE INDEX docs_chunks_section_idx ON docs_chunks (section);
CREATE INDEX docs_chunks_enabled_idx ON docs_chunks (enabled);
CREATE INDEX docs_chunks_search_trgm_idx
  ON docs_chunks USING gin (search_text_normalized gin_trgm_ops);
CREATE INDEX docs_chunks_search_vector_idx ON docs_chunks USING gin (search_vector);

CREATE INDEX docs_embeddings_document_id_idx ON docs_embeddings (document_id);
CREATE INDEX docs_embeddings_chunk_id_idx ON docs_embeddings (chunk_id);
CREATE INDEX docs_embeddings_kind_model_dimensions_idx
  ON docs_embeddings (embedding_kind, embedding_model, embedding_dimensions);
CREATE UNIQUE INDEX docs_embeddings_document_unique_idx
  ON docs_embeddings (document_id, embedding_model);
CREATE UNIQUE INDEX docs_embeddings_chunk_unique_idx
  ON docs_embeddings (chunk_id, embedding_model);
CREATE INDEX docs_embeddings_1024_hnsw_idx
  ON docs_embeddings
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 128);

CREATE TRIGGER docs_documents_refresh_search
BEFORE INSERT OR UPDATE ON docs_documents
FOR EACH ROW
EXECUTE FUNCTION docs_rag_refresh_document_search();

CREATE TRIGGER docs_documents_touch_updated_at
BEFORE UPDATE ON docs_documents
FOR EACH ROW
EXECUTE FUNCTION docs_rag_touch_updated_at();

CREATE TRIGGER docs_chunks_refresh_search
BEFORE INSERT OR UPDATE ON docs_chunks
FOR EACH ROW
EXECUTE FUNCTION docs_rag_refresh_chunk_search();

CREATE TRIGGER docs_chunks_touch_updated_at
BEFORE UPDATE ON docs_chunks
FOR EACH ROW
EXECUTE FUNCTION docs_rag_touch_updated_at();

CREATE TRIGGER docs_embeddings_touch_updated_at
BEFORE UPDATE ON docs_embeddings
FOR EACH ROW
EXECUTE FUNCTION docs_rag_touch_updated_at();

COMMIT;
