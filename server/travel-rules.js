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
  if (
    !(await db.one(current ? "trip_members" : "trip_participants", {
      trip_id: tripId,
      user_id: userId,
    }))
  )
    throw httpError(
      403,
      "This information is for this trip’s registered participants only.",
    );
}
export async function hasBlock(db, a, b) {
  return !!(await db.one("user_blocks", {
    ended_at: null,
    $or: [
      { blocker_id: a, blocked_id: b },
      { blocker_id: b, blocked_id: a },
    ],
  }));
}
export async function blockedWithCrew(db, tripId, userId) {
  const crew = (
    await db.all("trip_members", { trip_id: tripId, user_id: { $ne: userId } })
  ).map((m) => m.user_id);
  return !!(await db.one("user_blocks", {
    ended_at: null,
    $or: [
      { blocker_id: userId, blocked_id: { $in: crew } },
      { blocked_id: userId, blocker_id: { $in: crew } },
    ],
  }));
}
export async function addMember(db, tripId, userId) {
  const now = new Date();
  await db.insert("trip_members", {
    trip_id: tripId,
    user_id: userId,
    joined_at: now,
  });
  await db.update(
    "trip_participants",
    { trip_id: tripId, user_id: userId },
    {
      $set: { last_joined_at: now, left_at: null },
      $setOnInsert: { first_joined_at: now },
    },
    { upsert: true },
  );
}
export async function removeMember(db, tripId, userId) {
  const result = await db.remove("trip_members", {
    trip_id: tripId,
    user_id: userId,
  });
  if (result.deletedCount)
    await db.update(
      "trip_participants",
      { trip_id: tripId, user_id: userId },
      { $set: { left_at: new Date() } },
    );
}
export function prefix(value) {
  return new RegExp("^" + value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}
export async function reviewEligible(db, trip, user) {
  const t =
    typeof trip === "string" ? await db.one("trips", { id: trip }) : trip;
  if (!t) return false;
  const p = await db.one("trip_participants", { trip_id: t.id, user_id: user });
  const day = (value) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
      new Date(value),
    );
  return (
    !!p &&
    day(p.first_joined_at) <= t.ends_on &&
    (!p.left_at || day(p.left_at) >= t.starts_on)
  );
}
