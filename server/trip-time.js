import { httpError } from "./travel-rules.js";
// Convert a wall-clock departure using its IANA zone, without guessing through DST gaps.
export function departureFromLocalTime(day, time, timeZone) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
  )
    throw httpError(400, "Choose a valid departure date and time.");
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw httpError(400, "Choose a valid IANA time zone.");
  }
  const wall = new Date(day + "T" + time + ":00Z").getTime();
  if (!Number.isFinite(wall))
    throw httpError(400, "Choose a valid departure date.");
  const parts = (stamp) =>
    Object.fromEntries(
      formatter
        .formatToParts(stamp)
        .filter((p) => p.type !== "literal")
        .map((p) => [p.type, p.value]),
    );
  const offsets = new Set(
    [-36, -12, 0, 12, 36].map((hours) => {
      const sample = wall + hours * 3600000,
        p = parts(sample);
      return (
        Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) -
        sample
      );
    }),
  );
  const matches = [...offsets]
    .map((offset) => wall - offset)
    .filter((stamp) => {
      const p = parts(stamp);
      return (
        `${p.year}-${p.month}-${p.day}` === day &&
        `${p.hour}:${p.minute}` === time
      );
    });
  if (matches.length !== 1)
    throw httpError(
      400,
      "This departure time is missing or repeated during a daylight-saving change. Choose another time.",
    );
  return new Date(matches[0]);
}
