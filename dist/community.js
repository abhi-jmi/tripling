(() => {
  let c;
  const esc = (v) => c.esc(String(v ?? ""));
  const field = (name, label, value = "", type = "text") =>
    `<label class="form-field">${label}<input name="${name}" type="${type}" value="${esc(value)}" required></label>`;
  const options = (values, current) =>
    values
      .map(
        (v) => `<option ${v === current ? "selected" : ""}>${esc(v)}</option>`,
      )
      .join("");
  const frame = (title, body) =>
    c.modal(
      `<div class="modal-pad"><h2 id="modal-title">${title}</h2><p class="community-error" role="alert"></p>${body}</div>`,
    );
  const form = (action, body) =>
    `<form class="community-form" data-community-form="${action}">${body}<button class="primary" type="submit">Submit</button></form>`;
  const hidden = (name, value) =>
    `<input type="hidden" name="${name}" value="${esc(value)}">`;
  const message = (name, label, value = "", min = 10) =>
    `<label class="form-field">${label}<textarea name="${name}" minlength="${min}" maxlength="4000" ${min>0?"required":""}>${esc(value)}</textarea></label>`;
  const categories = [
    "General Feedback",
    "Suggestion",
    "Complaint",
    "Technical Issue",
    "Trip Related",
    "Other",
  ];
  async function verification() {
    if (!c.login()) return;
    const r = await c.api("/organizer/verification");
    frame(
      "Organizer verification",
      `<p>Status: <strong>${esc(r.status)}</strong></p>${r.request?.reason ? `<p>${esc(r.request.reason)}</p>` : ""}<p>Approval reflects an organizer application review, not a guarantee of safety. Do not submit Aadhaar, passport or other government identity documents. A business or experience reference is sufficient.</p>${["pending", "approved"].includes(r.status) ? "" : form("verification", field("name", "Organizer or business name", c.data().user.name) + field("contact", "Private contact details", c.data().user.email) + message("experience", "Travel organizing experience and references", "", 30) + (r.documentUploadsEnabled ? '<label class="form-field">Optional supporting PDF, PNG or JPEG (2 MB maximum)<input name="document" type="file" accept="application/pdf,image/png,image/jpeg"></label>' : "<p>Document uploads are unavailable until private encryption storage is configured. You can submit your details for review.</p>"))}`,
    );
  }
  async function dashboard() {
    if (!c.login()) return;
    const r = await c.api("/organizer/dashboard");
    frame(
      "Organizer dashboard",
      `<p>Verification: ${esc(r.verification)} <button class="secondary" data-community="verification">Apply / view status</button></p><div class="community-stats">${Object.entries(
        r.stats,
      )
        .map(([k, v]) => `<span><strong>${v}</strong> ${esc(k)}</span>`)
        .join(
          "",
        )}</div><button class="primary" data-action="create">Create trip</button><button class="secondary" data-community="profile" data-id="${esc(c.data().user.id)}">Organizer profile & reviews</button>${r.trips.map((t) => `<article class="request-item"><h3>${esc(t.title)}</h3><p>${esc(t.from_city)} → ${esc(t.destination)} · ${esc(t.starts_on)} · ${esc(t.status)}</p><div class="modal-actions"><button class="secondary" data-trip="${t.id}">View trip</button><button class="secondary" data-incoming="${t.id}">Join requests</button><button class="secondary" data-community="edit" data-id="${t.id}">Edit</button><button class="secondary" data-community="participants" data-id="${t.id}">Participants</button><button class="secondary" data-community="cancel" data-id="${t.id}">Cancel trip</button></div></article>`).join("") || "<p>You have no organized trips yet.</p>"}`,
    );
  }
  async function edit(id) {
    const r = await c.api("/organizer/dashboard"),
      t = r.trips.find((t) => t.id === id);
    if (!t) throw Error("Trip is not managed by you.");
    frame(
      "Edit upcoming trip",
      form(
        "edit",
        hidden("id", id) +
          field("title", "Title", t.title) +
          message("description", "Description", t.description, 25) +
          message("plan", "Itinerary", t.plan || "Flexible itinerary", 0) +
          message(
            "rules",
            "Group rules",
            t.rules || "Respect fellow travelers.",
            0,
          ) +
          `<label class="form-field">Travel style<select name="category">${options([...c.data().options.travelStyles, ...c.data().options.legacyStyles], t.category)}</select></label>` +
          field(
            "departureUtc",
            "Departure (UTC, include Z)",
            t.departure_utc || "",
          ) +
          field(
            "timeZone",
            "Display time zone",
            t.departure_timezone || "Asia/Kolkata",
          ) +
          `<p>Route, dates, eligibility and capacity stay fixed to protect accepted participants. Departure time must fall on the existing departure date in the specified time zone. Members will be notified.</p>`,
      ),
    );
  }
  async function participants(id) {
    const r = await c.api(`/trips/${id}/members`);
    frame(
      "Registered participants",
      r.members
        .map(
          (m) =>
            `<article class="request-item"><strong>${esc(m.name)}</strong><p>${m.active ? "Active" : "Left trip"}</p>${m.active ? `<button class="secondary" data-community="remove" data-id="${id}" data-user="${m.id}">Remove with reason</button>` : ""}</article>`,
        )
        .join(""),
    );
  }
  async function organizer(id) {
    const r = await c.api("/organizers/" + id),
      trips = c
        .data()
        .trips.filter(
          (t) =>
            t.end < new Date().toISOString().slice(0, 10) &&
            t.participated &&
            (t.reviewOrganizerId || t.organizerId || t.ownerId) === id,
        );
    frame(
      esc(r.name),
      `<p>${r.verified ? "✓ Verified Organizer" : "Organizer application not approved"}</p><p>${esc(r.bio)}</p><p>${r.average ? r.average.toFixed(1) + "/5" : "No ratings yet"} · ${r.total} reviews</p><p>${r.distribution.map((n, i) => `${i + 1} stars: ${n}`).join(" · ")}</p>${r.reviews.map((v) => `<article class="request-item"><strong>${v.rating}/5 · ${esc(v.author_name)}</strong><p>${esc(v.body)}</p><small>${esc(v.trip_title)}</small></article>`).join("")}${trips.length ? form("organizer-review", `<label class="form-field">Completed trip<select name="tripId">${trips.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join("")}</select></label><label class="form-field">Stars<select name="rating">${options(["5", "4", "3", "2", "1"])}</select></label>` + message("body", "Your review")) : ""}`,
    );
  }
  async function admin(query = "") {
    const offset = +(
      new URLSearchParams(query.replace(/^\?/, "")).get("offset") || 0
    );
    const [v, r] = await Promise.all([
      c.api("/admin/verifications?offset=" + offset),
      c.api("/admin/community" + query),
    ]);
    frame(
      "Administration",
      `<div class="modal-actions">${offset ? `<button class="secondary" data-community="admin" data-offset="${Math.max(0, offset - 100)}">Previous page</button>` : ""}${r.nextOffset !== null || v.nextOffset !== null ? `<button class="secondary" data-community="admin" data-offset="${offset + 100}">Next page</button>` : ""}</div><h3>Verification requests</h3>${v.requests.map((v) => `<article class="request-item"><h4>${esc(v.name)} · ${esc(v.status)}</h4><p>${esc(v.contact)}</p><p>${esc(v.experience)}</p>${v.hasDocument ? `<a class="secondary" href="/api/admin/verifications/${v.user_id}/document">Download private document</a>` : ""}${v.status === "pending" ? form("decision", hidden("user", v.user_id) + `<label class="form-field">Decision<select name="status">${options(["approved", "rejected"])}</select></label>` + field("reason", "Decision reason (optional)").replace(" required", "")) : ""}</article>`).join("")}
  <h3>Feedback</h3>${form("feedback-filter", `<label>Category<select name="category"><option value="">All</option>${options(categories)}</select></label><label>Status<select name="status"><option value="">All</option>${options(["New", "In Progress", "Resolved"])}</select></label>`)}${r.feedback.map((f) => `<article class="request-item"><strong>${esc(f.name)} · ${esc(f.email)} · ${esc(f.category)}</strong><p>${esc(f.message)}</p>${form("feedback-update", hidden("id", f.id) + `<label class="form-field">Status<select name="status">${options(["New", "In Progress", "Resolved"], f.status)}</select></label>` + message("notes", "Internal notes", f.notes, 0))}</article>`).join("")}
  <h3>Testimonials</h3>${r.testimonials.map((t) => `<article class="request-item"><strong>${esc(t.name)} · ${esc(t.status)}</strong><p>${esc(t.message)}</p>${form("testimonial-decision", hidden("id", t.id) + `<select name="status">${options(["approved", "rejected", "hidden"], t.status)}</select><label class="check-label"><input name="featured" type="checkbox" ${t.featured ? "checked" : ""}>Feature on homepage</label>`)}</article>`).join("")}
  <h3>Organizer reviews</h3>${r.reviews.map((v) => `<article class="request-item"><p>${esc(v.body)}</p>${form("review-moderate", hidden("id", v.id) + `<label class="check-label"><input name="hidden" type="checkbox" ${v.hidden ? "checked" : ""}>Hide from public</label>` + field("reason", "Moderation reason"))}</article>`).join("")}
  <h3>Location index maintenance</h3>${form("reindex", "<p>Refresh up to 25 missing or expired trip locations. Google API billing applies; ambiguous cities remain excluded.</p>")}<h3>Exceptional cancellation</h3>${form("override", field("trip", "Trip UUID") + field("user", "Participant UUID") + message("reason", "Required exception reason"))}
  <h3>Audit history</h3>${r.audit.map((a) => `<p>${esc(a.created_at)} · ${esc(a.action)} · ${esc(a.subject)} · ${esc(a.reason)}</p>`).join("")}`,
    );
  }
  async function feedback() {
    frame(
      "Write to Us",
      form(
        "feedback",
        field("name", "Name", c.data().user?.name || "") +
          field("email", "Email", c.data().user?.email || "", "email") +
          `<label class="form-field">Category<select name="category">${options(categories)}</select></label><label class="feedback-trap" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>` +
          message("message", "Your message", "", 20),
      ),
    );
  }
  async function testimonial() {
    if (!c.login()) return;
    const trips = c
      .data()
      .trips.filter((t) => t.participated && t.lifecycle === "completed");
    frame(
      "Share a genuine travel experience",
      trips.length
        ? form(
            "testimonial",
            `<label class="form-field">Completed trip<select name="tripId">${trips.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join("")}</select></label>` +
              message("message", "Your experience", "", 20) +
              '<label class="check-label"><input type="checkbox" name="consent" required>I consent to publication of my name, trip title and this message on Tripling after review. No photo will be published.</label>',
          )
        : "<p>A confirmed completed trip is required before submitting a testimonial.</p>",
    );
  }
  async function publicSection() {
    const r = await c.api("/testimonials"),
      root = document.getElementById("testimonials-list");
    root.innerHTML =
      r.testimonials
        .map(
          (t) =>
            `<article class="request-item"><p>${esc(t.message)}</p><strong>${esc(t.name)}</strong><small> · ${esc(t.trip_title)}</small></article>`,
        )
        .join("") ||
      "<p>No published traveler stories yet. Experiences appear only with consent and approval.</p>";
    document.getElementById("community-admin").hidden = !c.data().user?.isAdmin;
  }
  window.TriplingCommunity = {
    init(ctx) {
      c = ctx;
      publicSection().catch(() => {});
    },
    verification,
    dashboard,
    organizer,
  };
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-community]");
    if (!b || !c) return;
    try {
      const name = b.dataset.community;
      if (name === "verification") await verification();
      if (name === "dashboard") await dashboard();
      if (name === "feedback") await feedback();
      if (name === "testimonial") await testimonial();
      if (name === "admin") await admin("?offset=" + (b.dataset.offset || 0));
      if (name === "profile") await organizer(b.dataset.id);
      if (name === "edit") await edit(b.dataset.id);
      if (name === "participants") await participants(b.dataset.id);
      if (name === "cancel" || name === "remove")
        frame(
          name === "cancel" ? "Cancel this trip" : "Remove participant",
          form(
            name,
            hidden("id", b.dataset.id) +
              hidden("user", b.dataset.user || "") +
              message("reason", "Reason"),
          ),
        );
    } catch (error) {
      c.toast(error.message);
    }
  });
  document.addEventListener("submit", async (e) => {
    const f = e.target.closest(".community-form");
    if (!f || !c) return;
    e.preventDefault();
    const b = f.querySelector("[type=submit]");
    b.disabled = true;
    const d = Object.fromEntries(new FormData(f)),
      action = f.dataset.communityForm;
    try {
      if (action === "feedback-filter") {
        await admin(
          "?" + new URLSearchParams(Object.entries(d).filter(([, v]) => v)),
        );
        return;
      }
      let path,
        method = "POST",
        body = d;
      if (action === "verification") {
        body = { name: d.name, experience: d.experience, contact: d.contact };
        const file = f.elements.document?.files[0];
        if (file) {
          if (file.size > 2 * 1024 * 1024)
            throw Error("Document must be at most 2 MB.");
          const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(",")[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          body.document = { type: file.type, base64 };
        }
        path = "/organizer/verification";
      }
      if (action === "edit") {
        path = "/organizer/trips/" + d.id;
        method = "PATCH";
        body = {
          title: d.title,
          description: d.description,
          plan: d.plan,
          rules: d.rules,
          category: d.category,
          departureUtc: d.departureUtc,
          timeZone: d.timeZone,
        };
      }
      if (action === "cancel") path = "/organizer/trips/" + d.id + "/cancel";
      if (action === "remove" || action === "override") {
        path = "/organizer/trips/" + (d.trip || d.id) + "/members/" + d.user;
        method = "DELETE";
        body = { reason: d.reason };
      }
      if (action === "decision") {
        path = "/admin/verifications/" + d.user;
        method = "PUT";
        body = { status: d.status, reason: d.reason };
      }
      if (action === "organizer-review") {
        path = "/trips/" + d.tripId + "/organizer-review";
        body = { rating: +d.rating, body: d.body };
      }
      if (action === "feedback") path = "/feedback";
      if (action === "reindex") {
        path = "/admin/locations/reindex";
        body = { limit: 25 };
      }
      if (action === "testimonial") {
        path = "/testimonials";
        body = { tripId: d.tripId, message: d.message, consent: !!d.consent };
      }
      if (action === "feedback-update") {
        path = "/admin/feedback/" + d.id;
        method = "PUT";
        body = { status: d.status, notes: d.notes };
      }
      if (action === "testimonial-decision") {
        path = "/admin/testimonials/" + d.id;
        method = "PUT";
        body = { status: d.status, featured: !!d.featured };
      }
      if (action === "review-moderate") {
        path = "/admin/reviews/" + d.id;
        method = "PUT";
        body = { hidden: !!d.hidden, reason: d.reason };
      }
      const saved = await c.api(path, { method, body });
      await c.refresh();
      c.toast(
        action === "reindex"
          ? `Processed ${saved.processed}; indexed ${saved.indexed}; unresolved ${saved.unresolved}. Unresolved places remain excluded.`
          : "Saved successfully.",
      );
      if (
        [
          "decision",
          "feedback-update",
          "testimonial-decision",
          "review-moderate",
          "override",
          "reindex",
        ].includes(action)
      )
        await admin();
      else if (action === "verification") await verification();
      else
        frame(
          "Thank you",
          "<p>Your submission has been saved. Reviews and testimonials are subject to the applicable participation and moderation rules.</p>",
        );
      await publicSection();
    } catch (error) {
      const alert = document.querySelector(".community-error");
      if (alert) alert.textContent = error.message;
      else c.toast(error.message);
    } finally {
      if (b.isConnected) b.disabled = false;
    }
  });
})();
