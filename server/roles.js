export const isAdmin = (user) =>
  !!user &&
  (process.env.TRIPLING_ADMIN_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .includes(user.id);
export const verifiedOrganizer = (user) =>
  user?.organizer_verification === "approved";
export function organizerVerificationEnabled(
  value = process.env.ORGANIZER_VERIFICATION_REQUIRED ?? "false",
) {
  if (!["true", "false"].includes(value))
    throw new Error("ORGANIZER_VERIFICATION_REQUIRED must be true or false.");
  return value === "true";
}
export async function requireVerified(db, id, required = true) {
  const user = await db.one("users", { id });
  if (!user || (required && !verifiedOrganizer(user)))
    throw Object.assign(
      new Error(
        "Organizer verification approval is required before publishing or managing trips.",
      ),
      { status: 403 },
    );
  return user;
}
export const cancellationMessage =
  "Cancellation is not allowed within 24 hours of the scheduled trip departure. Please contact support for exceptional requests.";
export function canCancelParticipation(trip, now = new Date()) {
  if (
    trip.status === "canceled" ||
    trip.ends_on <
      new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now)
  )
    return true;
  if (!trip.departure_utc) return null;
  return new Date(trip.departure_utc).getTime() - now.getTime() > 86400000;
}
