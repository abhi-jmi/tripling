CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL,
  display_name varchar(50) NOT NULL DEFAULT 'Traveler',
  city varchar(60) NOT NULL DEFAULT '',
  gender text NOT NULL DEFAULT '' CHECK (gender IN ('', 'woman', 'other')),
  bio varchar(500) NOT NULL DEFAULT '',
  adult_confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE auth_rate_limits (
  bucket_key char(64) NOT NULL,
  window_start bigint NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  PRIMARY KEY(bucket_key, window_start)
);
CREATE TABLE trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title varchar(65) NOT NULL,
  destination varchar(60) NOT NULL,
  from_city varchar(60) NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL CHECK (ends_on >= starts_on),
  budget_min integer NOT NULL CHECK (budget_min >= 0),
  budget_max integer NOT NULL CHECK (budget_max >= budget_min),
  existing_travelers integer NOT NULL CHECK (existing_travelers BETWEEN 1 AND 19),
  capacity integer NOT NULL CHECK (capacity BETWEEN 2 AND 20),
  category text NOT NULL CHECK (category IN ('Mountains','Beach','Adventure','Weekend')),
  mode text NOT NULL CHECK (mode IN ('Bus','Train','Shared cab','Self-drive','Flight')),
  women_only boolean NOT NULL DEFAULT false,
  description varchar(1200) NOT NULL,
  plan varchar(2000) NOT NULL DEFAULT '',
  rules varchar(1200) NOT NULL DEFAULT '',
  image text NOT NULL DEFAULT 'manali' CHECK (image IN ('manali','goa','rishikesh','spiti','kasol','udaipur')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','canceled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (capacity > existing_travelers)
);
CREATE INDEX trips_discovery ON trips(status, starts_on, destination);
CREATE TABLE trip_members (
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(trip_id,user_id)
);
CREATE TABLE join_requests (
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note varchar(600) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','canceled')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(trip_id,user_id)
);
CREATE TABLE saved_trips (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id,trip_id)
);
CREATE TABLE messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body varchar(2000) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_by_trip ON messages(trip_id,id DESC);
CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  reason varchar(100) NOT NULL,
  note varchar(600) NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewing','closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hidden_trips (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id,trip_id)
);
CREATE TABLE notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id uuid REFERENCES trips(id) ON DELETE CASCADE,
  body varchar(240) NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_by_user ON notifications(user_id,id DESC);
CREATE TABLE reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  traveler_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body varchar(1000) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(trip_id,author_id,traveler_id),
  CHECK(author_id <> traveler_id)
);
