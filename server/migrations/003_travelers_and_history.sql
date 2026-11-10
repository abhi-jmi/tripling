ALTER TABLE users ADD COLUMN first_name varchar(50);
ALTER TABLE users ADD COLUMN last_name varchar(50);
ALTER TABLE users ALTER COLUMN display_name TYPE varchar(101);
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD CONSTRAINT user_first_name_nonempty CHECK(first_name IS NULL OR length(btrim(first_name))>0);
ALTER TABLE users ADD CONSTRAINT user_last_name_nonempty CHECK(last_name IS NULL OR length(btrim(last_name))>0);

ALTER TABLE trips ADD COLUMN organizer_id uuid REFERENCES users(id) ON DELETE SET NULL;
UPDATE trips t SET organizer_id=owner_id WHERE EXISTS(SELECT 1 FROM trip_members m WHERE m.trip_id=t.id AND m.user_id=t.owner_id);
CREATE TABLE trip_participants (
 trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 first_joined_at timestamptz NOT NULL,
 last_joined_at timestamptz NOT NULL,
 left_at timestamptz,
 PRIMARY KEY(trip_id,user_id)
);
INSERT INTO trip_participants(trip_id,user_id,first_joined_at,last_joined_at)
 SELECT trip_id,user_id,joined_at,joined_at FROM trip_members;
CREATE FUNCTION track_trip_participation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO trip_participants(trip_id,user_id,first_joined_at,last_joined_at)
   VALUES(NEW.trip_id,NEW.user_id,NEW.joined_at,NEW.joined_at)
   ON CONFLICT(trip_id,user_id) DO UPDATE SET last_joined_at=NEW.joined_at,left_at=NULL;
  RETURN NEW;
 ELSE
  UPDATE trip_participants SET left_at=now() WHERE trip_id=OLD.trip_id AND user_id=OLD.user_id;
  RETURN OLD;
 END IF;
END;
$$;
CREATE TRIGGER membership_history_insert AFTER INSERT ON trip_members FOR EACH ROW EXECUTE FUNCTION track_trip_participation();
CREATE TRIGGER membership_history_delete AFTER DELETE ON trip_members FOR EACH ROW EXECUTE FUNCTION track_trip_participation();

CREATE TABLE user_blocks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 context_trip_id uuid REFERENCES trips(id) ON DELETE SET NULL,
 category varchar(80) NOT NULL,
 reason varchar(1000) NOT NULL CHECK(length(btrim(reason))>=20),
 created_at timestamptz NOT NULL DEFAULT now(),
 ended_at timestamptz,
 CHECK(blocker_id<>blocked_id)
);
CREATE UNIQUE INDEX active_user_block ON user_blocks(blocker_id,blocked_id) WHERE ended_at IS NULL;
CREATE INDEX block_visibility ON user_blocks(context_trip_id,created_at);
CREATE TABLE block_reason_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 block_id uuid NOT NULL REFERENCES user_blocks(id) ON DELETE CASCADE,
 reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 reason varchar(600) NOT NULL CHECK(length(btrim(reason))>=15),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE location_catalog(name varchar(60) PRIMARY KEY);
INSERT INTO location_catalog(name) VALUES
('Agra'),('Ahmedabad'),('Ajmer'),('Alappuzha'),('Almora'),('Amritsar'),('Andaman Islands'),('Aurangabad'),('Auli'),('Ayodhya'),('Bengaluru'),('Bhopal'),('Bhubaneswar'),('Bikaner'),('Bir'),('Chandigarh'),('Chennai'),('Cherrapunji'),('Chikmagalur'),('Coimbatore'),('Coorg'),('Dalhousie'),('Darjeeling'),('Dehradun'),('Delhi'),('Dharamshala'),('Diu'),('Gangtok'),('Goa'),('Gokarna'),('Gulmarg'),('Gurugram'),('Guwahati'),('Hampi'),('Haridwar'),('Hyderabad'),('Indore'),('Jaipur'),('Jaisalmer'),('Jammu'),('Jodhpur'),('Kalimpong'),('Kalpa'),('Kanyakumari'),('Kasol'),('Kaza'),('Kochi'),('Kodaikanal'),('Kolkata'),('Kovalam'),('Kullu'),('Leh'),('Lonavala'),('Lucknow'),('Madurai'),('Mahabaleshwar'),('Manali'),('Mangalore'),('Mathura'),('McLeod Ganj'),('Mount Abu'),('Mumbai'),('Munnar'),('Mussoorie'),('Mysuru'),('Nagpur'),('Nainital'),('Nashik'),('Noida'),('Ooty'),('Palampur'),('Pondicherry'),('Port Blair'),('Pune'),('Puri'),('Pushkar'),('Rameswaram'),('Ranchi'),('Ranikhet'),('Rishikesh'),('Shillong'),('Shimla'),('Siliguri'),('Sonamarg'),('Spiti'),('Srinagar'),('Surat'),('Tawang'),('Thekkady'),('Thiruvananthapuram'),('Tirupati'),('Udaipur'),('Udupi'),('Ujjain'),('Vadodara'),('Varanasi'),('Varkala'),('Vijayawada'),('Visakhapatnam'),('Wayanad');

CREATE TABLE oauth_identities (
 provider text NOT NULL CHECK(provider='google'),
 subject text NOT NULL,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(provider,subject),
 UNIQUE(provider,user_id)
);
CREATE TABLE oauth_flows (
 state_hash char(64) PRIMARY KEY,
 browser_hash char(64) NOT NULL,
 link_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
 link_session_hash char(64),
 verifier text NOT NULL,
 nonce text NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE oauth_pending (
 token_hash char(64) PRIMARY KEY,
 subject text NOT NULL,
 email text NOT NULL,
 first_name varchar(50) NOT NULL DEFAULT '',
 last_name varchar(50) NOT NULL DEFAULT '',
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
