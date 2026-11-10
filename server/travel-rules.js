export const TODAY_SQL =
  "(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date";
export const travelDate = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
    new Date(),
  );
export const profileComplete = (user) =>
  !!user?.first_name?.trim() && !!user?.last_name?.trim();
export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
export async function requireParticipant(
  db,
  tripId,
  userId,
  { current = false } = {},
) {
  const query = current
    ? "SELECT 1 FROM trip_members WHERE trip_id=$1 AND user_id=$2"
    : "SELECT 1 FROM trip_participants WHERE trip_id=$1 AND user_id=$2";
  if (!(await db.query(query, [tripId, userId])).rowCount)
    throw httpError(
      403,
      "This information is for this trip’s registered participants only.",
    );
}
export async function hasBlock(db, a, b) {
  return (
    (
      await db.query(
        "SELECT 1 FROM user_blocks WHERE ended_at IS NULL AND ((blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1))",
        [a, b],
      )
    ).rowCount > 0
  );
}
export async function blockedWithCrew(db, tripId, userId) {
  return (
    (
      await db.query(
        "SELECT 1 FROM user_blocks b JOIN trip_members m ON m.trip_id=$1 AND m.user_id<>$2 WHERE b.ended_at IS NULL AND ((b.blocker_id=$2 AND b.blocked_id=m.user_id) OR (b.blocked_id=$2 AND b.blocker_id=m.user_id)) LIMIT 1",
        [tripId, userId],
      )
    ).rowCount > 0
  );
}
