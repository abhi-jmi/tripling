import { z } from "zod";
import { transaction, lockTrip } from "./db.js";
import { httpError } from "./travel-rules.js";
const kinds = { trip: "reports", block: "block_reason_reports" };
const states = ["new", "in_progress", "resolved", "dismissed"];
export function registerModeration(app, pool) {
  // /api/admin's authentication, role and write-throttling middleware runs first.
  app.get("/api/admin/reports", async (req, res) => {
    const q = z
      .object({
        kind: z.enum(["trip", "block"]).default("trip"),
        reportStatus: z.enum(states).optional(),
        reportOffset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .parse(req.query);
    const filter =
      q.reportStatus === "new"
        ? { $or: [{ status: "new" }, { status: { $exists: false } }] }
        : q.reportStatus
          ? { status: q.reportStatus }
          : {};
    const [rows, total] = await Promise.all([
      pool.all(kinds[q.kind], filter, {
        sort: { created_at: -1, id: 1 },
        limit: 25,
        skip: q.reportOffset,
      }),
      pool.count(kinds[q.kind], filter),
    ]);
    const reports = await Promise.all(
      rows.map(async (row) => {
        const block =
          q.kind === "block"
            ? await pool.one("user_blocks", { id: row.block_id })
            : null;
        const trip = await pool.one("trips", {
          id: row.trip_id || block?.context_trip_id,
        });
        return {
          ...row,
          status: row.status || "new",
          revision: row.revision || 0,
          trip: trip
            ? {
                id: trip.id,
                title: trip.title,
                hidden: !!trip.moderation_hidden,
              }
            : null,
          statement: block
            ? {
                id: block.id,
                reason: block.reason,
                category: block.category,
                hidden: !!block.notice_hidden,
              }
            : null,
        };
      }),
    );
    res.json({
      reports,
      total,
      offset: q.reportOffset,
      nextOffset:
        q.reportOffset + rows.length < total
          ? q.reportOffset + rows.length
          : null,
    });
  });
  app.put("/api/admin/reports/:kind/:id", async (req, res) => {
    const kind = z.enum(["trip", "block"]).parse(req.params.kind),
      id = z.uuid().parse(req.params.id);
    const d = z
      .object({
        status: z.enum(states),
        action: z.enum(["none", "hide", "restore"]).default("none"),
        reason: z.string().trim().min(10).max(2000),
        revision: z.number().int().min(0),
      })
      .parse(req.body);
    if (d.action !== "none" && d.status !== "resolved")
      throw httpError(
        400,
        "Resolve the report when applying a visibility decision.",
      );
    await transaction(pool, async (db) => {
      const report = await db.one(kinds[kind], { id });
      if (!report) throw httpError(404, "Report not found.");
      if ((report.revision || 0) !== d.revision)
        throw httpError(
          409,
          "Another administrator updated this report. Reload it before deciding.",
        );
      if (d.action !== "none") {
        if (kind === "trip") {
          const trip = await lockTrip(db, report.trip_id);
          if (!trip) throw httpError(404, "Reported trip not found.");
          await db.update(
            "trips",
            { id: trip.id },
            { $set: { moderation_hidden: d.action === "hide" } },
          );
        } else {
          const r = await db.update(
            "user_blocks",
            { id: report.block_id },
            { $set: { notice_hidden: d.action === "hide" } },
          );
          if (!r.matchedCount)
            throw httpError(404, "Reported statement not found.");
          // Suppressing a statement never removes its author's personal block.
        }
      }
      await db.update(
        kinds[kind],
        { id },
        {
          $set: {
            status: d.status,
            decision_reason: d.reason,
            action: d.action,
            reviewed_by: req.user.id,
            reviewed_at: new Date(),
          },
          $inc: { revision: 1 },
        },
      );
      await db.insert("admin_audit", {
        actor_id: req.user.id,
        action: `${kind}_report_${d.status}`,
        subject: id,
        reason: d.reason,
        visibility_action: d.action,
      });
    });
    res.json({ ok: true });
  });
}
