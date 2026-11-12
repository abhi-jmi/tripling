export const TRAVEL_STYLES = [
  "Adventure",
  "Backpacking",
  "Road Trip",
  "Trekking",
  "Camping",
  "Leisure / Relaxation",
  "Cultural / Heritage",
  "Budget Travel",
  "Luxury Travel",
  "Spiritual / Religious",
];
export const LEGACY_STYLES = ["Mountains", "Beach", "Weekend"];
export const GENDERS = [
  { value: "man", label: "Male" },
  { value: "woman", label: "Female" },
  { value: "non-binary", label: "Non-Binary" },
  { value: "self-describe", label: "Self-Describe" },
  { value: "prefer-not-to-say", label: "Prefer Not to Say" },
  { value: "other", label: "Other (legacy profile)" },
];
export const GROUPS = [
  { value: "men", label: "Men Only" },
  { value: "women", label: "Women Only" },
  { value: "mixed", label: "Mixed Group" },
];
export const groupOf = (trip) =>
  trip.group_eligibility || (trip.women_only ? "women" : "mixed");
export function eligibleForGroup(group, gender) {
  return (
    group === "mixed" ||
    (group === "men" && gender === "man") ||
    (group === "women" && gender === "woman")
  );
}
export const tripOptions = {
  travelStyles: TRAVEL_STYLES,
  legacyStyles: LEGACY_STYLES,
  genders: GENDERS,
  groups: GROUPS,
};
