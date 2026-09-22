BEGIN;

CREATE OR REPLACE FUNCTION docs_rag_refresh_eval_case_search()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.query_normalized := lower(unaccent(coalesce(NEW.query, '')));
  NEW.query_vector := to_tsvector('simple', NEW.query_normalized);
  RETURN NEW;
END;
$$;

CREATE TABLE docs_eval_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_name text NOT NULL,
  corpus_name text NOT NULL DEFAULT 'docs-rag',
  retrieval_mode text NOT NULL DEFAULT 'hybrid',
  embedding_model text,
  embedding_dimensions integer,
  query_set_name text,
  status text NOT NULL DEFAULT 'queued',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT docs_eval_runs_status_check CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  CONSTRAINT docs_eval_runs_dimensions_check CHECK (
    embedding_dimensions IS NULL OR embedding_dimensions = 1024
  )
);

CREATE TABLE docs_eval_cases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES docs_eval_runs(id) ON DELETE CASCADE,
  case_key text NOT NULL,
  query text NOT NULL,
  query_normalized text NOT NULL DEFAULT '',
  query_vector tsvector NOT NULL DEFAULT ''::tsvector,
  expected_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  expected_answer text,
  observed_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  observed_score numeric(8, 4),
  status text NOT NULL DEFAULT 'queued',
  notes text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT docs_eval_cases_run_case_unique UNIQUE (run_id, case_key),
  CONSTRAINT docs_eval_cases_status_check CHECK (status IN ('queued', 'passed', 'failed', 'skipped'))
);

CREATE INDEX docs_eval_runs_status_idx ON docs_eval_runs (status);
CREATE INDEX docs_eval_runs_started_at_idx ON docs_eval_runs (started_at);
CREATE INDEX docs_eval_runs_query_set_idx ON docs_eval_runs (query_set_name);

CREATE INDEX docs_eval_cases_run_id_idx ON docs_eval_cases (run_id);
CREATE INDEX docs_eval_cases_status_idx ON docs_eval_cases (status);
CREATE INDEX docs_eval_cases_query_trgm_idx
  ON docs_eval_cases USING gin (query_normalized gin_trgm_ops);
CREATE INDEX docs_eval_cases_query_vector_idx ON docs_eval_cases USING gin (query_vector);

CREATE TRIGGER docs_eval_runs_touch_updated_at
BEFORE UPDATE ON docs_eval_runs
FOR EACH ROW
EXECUTE FUNCTION docs_rag_touch_updated_at();

CREATE TRIGGER docs_eval_cases_refresh_search
BEFORE INSERT OR UPDATE ON docs_eval_cases
FOR EACH ROW
EXECUTE FUNCTION docs_rag_refresh_eval_case_search();

CREATE TRIGGER docs_eval_cases_touch_updated_at
BEFORE UPDATE ON docs_eval_cases
FOR EACH ROW
EXECUTE FUNCTION docs_rag_touch_updated_at();

COMMIT;
