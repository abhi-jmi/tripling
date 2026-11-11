CREATE TABLE legal_documents (
  slug text NOT NULL CHECK (slug IN ('terms','privacy')),
  version varchar(80) NOT NULL,
  title text NOT NULL,
  content jsonb NOT NULL,
  operator_name text NOT NULL,
  contact_email text NOT NULL,
  jurisdiction text NOT NULL,
  effective_on date NOT NULL,
  published boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(slug,version)
);
CREATE INDEX legal_current ON legal_documents(slug,published,created_at DESC);
CREATE TABLE legal_acceptances (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug text NOT NULL,
  version varchar(80) NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,slug,version),
  FOREIGN KEY(slug,version) REFERENCES legal_documents(slug,version)
);
