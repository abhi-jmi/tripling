import { z } from "zod";
import { TRAVEL_STYLES, LEGACY_STYLES } from "./trip-options.js";
export const tripSchema = z
  .object({
    title: z.string().trim().min(3).max(65),
    from: z.string().trim().min(1).max(60),
    destination: z.string().trim().min(1).max(60),
    destinationPlaceId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,250}$/)
      .optional(),
    start: z.iso.date(),
    departureUtc: z.iso.datetime({ offset: true }),
    timeZone: z.string().max(80),
    end: z.iso.date(),
    min: z.number().int().min(0).max(1000000),
    max: z.number().int().min(0).max(1000000),
    going: z.number().int().min(1).max(19),
    seats: z.number().int().min(1).max(19),
    category: z.enum([...TRAVEL_STYLES, ...LEGACY_STYLES]),
    groupEligibility: z.enum(["men", "women", "mixed"]).optional(),
    fromPlaceId: z
      .string()
      .regex(
        /^[a-zA-Z0-9_-]{1,250}$/,
        "Select a starting city from the location suggestions.",
      ),
    mode: z.enum(["Bus", "Train", "Shared cab", "Self-drive", "Flight"]),
    description: z.string().trim().min(25).max(1200),
    plan: z.string().trim().max(2000).default(""),
    rules: z.string().trim().max(1200).default(""),
    women: z.boolean().default(false),
    age: z.literal(true),
  })
  .refine((t) => t.end >= t.start, {
    message: "Return date must be on or after departure.",
  })
  .refine((t) => t.max >= t.min, {
    message: "Maximum budget must be at least the minimum.",
  })
  .refine((t) => t.going + t.seats <= 20, {
    message: "Groups can have at most 20 travelers.",
  });

export const editableTripSchema = tripSchema.safeExtend({
  seats: z.number().int().min(0).max(19),
  going: z.number().int().min(1).max(20),
  fromPlaceId: tripSchema.shape.fromPlaceId.optional(),
});
export const tripPatchSchema = z
  .object({
    ...editableTripSchema.shape,
    plan: z.string().trim().max(2000),
    rules: z.string().trim().max(1200),
    women: z.boolean(),
  })
  .partial()
  .extend({
    departureTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    revision: z.number().int().nonnegative().optional(),
  })
  .strict();
