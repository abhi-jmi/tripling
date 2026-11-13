(() => {
  let c,
    routeVersion = 0;
  const pagePaths = {
    dashboard: "/organizer/dashboard",
    verification: "/organizer/verification",
    admin: "/admin",
    feedback: "/feedback",
  };
  const hasPath = (path) => Object.values(pagePaths).includes(path);
  function pageOptions() {
    const path = location.pathname,
      version = routeVersion;
    return {
      page: hasPath(path),
      valid: () => location.pathname === path && routeVersion === version,
    };
  }
  async function navigate(path) {
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin || !hasPath(url.pathname))
      throw Error("Unknown Tripling page.");
    if (
      location.pathname + location.search !== url.pathname + url.search ||
      location.hash
    )
      history.pushState(null, "", url.pathname + url.search);
    return c.route();
  }
  async function showRoute() {
    const version = ++routeVersion,
      path = location.pathname,
      opts = {
        page: true,
        valid: () => routeVersion === version && location.pathname === path,
      };
    if (!hasPath(path)) return false;
    if (path !== pagePaths.feedback && !c.login(path + location.search))
      return true;
    c.page("Loading…", '<p role="status">Loading your page…</p>');
    try {
      if (path === pagePaths.dashboard) await dashboard(opts);
      if (path === pagePaths.verification) await verification(opts);
      if (path === pagePaths.feedback) await feedback(opts);
      if (path === pagePaths.admin) {
        if (!c.data().user?.isAdmin)
          throw Object.assign(new Error("Administrator access is required."), {
            status: 403,
          });
        await admin(location.search, opts);
      }
    } catch (error) {
      if (opts.valid())
        c.page(
          error.status === 403 ? "Access restricted" : "Unable to load page",
          `<p class="community-error" role="alert">${esc(error.message)}</p><a class="secondary" href="${esc(path + location.search)}">Try again</a>`,
        );
    }
    return true;
  }

  const esc = (v) => c.esc(String(v ?? ""));
  const field = (name, label, value = "", type = "text") =>
    `<label class="form-field">${label}<input name="${name}" type="${type}" value="${esc(value)}" required></label>`;
  const options = (values, current) =>
    values
      .map(
        (v) => `<option ${v === current ? "selected" : ""}>${esc(v)}</option>`,
      )
      .join("");
  const frame = (title, body, opts = {}) => {
    if (opts.valid && !opts.valid()) return;
    if (opts.page)
      c.page(title, `<p class="community-error" role="alert"></p>${body}`);
    else
      c.modal(
        `<div class="modal-pad"><h2 id="modal-title">${title}</h2><p class="community-error" role="alert"></p>${body}</div>`,
      );
  };
  const form = (action, body, label = "Submit") =>
    `<form class="community-form" data-community-form="${action}">${body}<button class="primary" type="submit">${esc(label)}</button></form>`;
  const hidden = (name, value) =>
    `<input type="hidden" name="${name}" value="${esc(value)}">`;
  const message = (name, label, value = "", min = 10, max = 4000) =>
    `<label class="form-field">${label}<textarea name="${name}" minlength="${min}" maxlength="${max}" ${min > 0 ? "required" : ""}>${esc(value)}</textarea></label>`;
  const categories = [
    "General Feedback",
    "Suggestion",
    "Complaint",
    "Technical Issue",
    "Trip Related",
    "Other",
  ];
  async function verification(opts = {}) {
    if (!c.login(pagePaths.verification)) return;
    if (!c.data().features?.organizerVerificationRequired) {
      frame(
        "Organizer verification",
        `<div class="verification-preview"><div class="verification-preview-background" inert aria-hidden="true"><p>Status: Not submitted</p><p>Approval reflects an organizer application review, not a guarantee of safety. Do not submit Aadhaar, passport or other government identity documents. A business or experience reference is sufficient.</p><div class="community-form">${field("name", "Organizer or business name", "")}${field("contact", "Private contact details", "")}${message("experience", "Travel organizing experience and references", "", 30)}</div></div><div class="verification-coming-soon" role="status"><span>Coming soon</span></div></div>`,
        opts,
      );
      return;
    }
    const r = await c.api("/organizer/verification");
    frame(
      "Organizer verification",
      `<p>Status: <strong>${esc(r.status)}</strong></p>${r.request?.reason ? `<p>${esc(r.request.reason)}</p>` : ""}<p>Approval reflects an organizer application review, not a guarantee of safety. Do not submit Aadhaar, passport or other government identity documents. A business or experience reference is sufficient.</p>${["pending", "approved"].includes(r.status) ? "" : form("verification", field("name", "Organizer or business name", c.data().user.name) + field("contact", "Private contact details", c.data().user.email) + message("experience", "Travel organizing experience and references", "", 30) + (r.documentUploadsEnabled ? '<label class="form-field">Optional supporting PDF, PNG or JPEG (2 MB maximum)<input name="document" type="file" accept="application/pdf,image/png,image/jpeg"></label>' : "<p>Document uploads are unavailable until private encryption storage is configured. You can submit your details for review.</p>"))}`,
      opts,
    );
  }
  const tripDay = (day) =>
    new Date(day + "T12:00:00Z").toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  const price = (amount) => "₹" + Number(amount).toLocaleString("en-IN");
  function dashboardTrip(t, r) {
    const members = r.members.filter((m) => m.trip_id === t.id).length;
    const pending = r.requests.filter(
      (v) => v.trip_id === t.id && v.status === "pending",
    ).length;
    const day =
      c.data().today ||
      new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const status =
      t.status === "canceled"
        ? "Cancelled"
        : t.ends_on < day
          ? "Completed"
          : t.starts_on > day
            ? "Upcoming"
            : "In progress";
    const editable =
      t.status === "open" &&
      t.starts_on >= day &&
      (!t.departure_utc || new Date(t.departure_utc) > new Date());
    const spots = Math.max(0, t.capacity - t.existing_travelers - members + 1);
    const cityImage = {
      goa: "goa",
      rishikesh: "rishikesh",
      udaipur: "udaipur",
      manali: "manali",
    }[t.destination.toLowerCase().split(",")[0].trim()];
    const image =
      cityImage ||
      (["goa", "rishikesh", "udaipur", "manali", "mountains"].includes(t.image)
        ? t.image
        : "manali");
    return `<article class="organizer-trip-card"><img class="organizer-trip-image" src="assets/${image}.jpg" alt="${esc(t.destination)} travel inspiration" loading="lazy"><div class="organizer-trip-body"><div class="organizer-trip-heading"><span class="organizer-trip-style">${esc(t.category)}</span><span class="organizer-trip-status ${status === "Cancelled" ? "is-cancelled" : status === "Completed" ? "is-completed" : ""}">${status}</span></div><h3>${esc(t.title)}</h3><p class="organizer-trip-route">${esc(t.from_city)} <span aria-hidden="true">→</span> ${esc(t.destination)}</p><div class="organizer-trip-facts"><span>${tripDay(t.starts_on)} – ${tripDay(t.ends_on)}</span><span>${members} registered · ${spots} spots open</span><span>${price(t.budget_min)}–${price(t.budget_max)} / person</span></div><div class="organizer-trip-actions"><button class="secondary trip-action-view" data-trip="${esc(t.id)}">View trip</button><button class="secondary trip-action-requests" data-incoming="${esc(t.id)}">Join requests${pending ? ` (${pending})` : ""}</button><button class="secondary trip-action-edit" data-community="edit" data-id="${esc(t.id)}" ${editable ? "" : 'disabled title="Only trips that have not departed can be edited"'}>Edit</button><button class="secondary trip-action-participants" data-community="participants" data-id="${esc(t.id)}">Participants</button><button class="secondary trip-action-cancel" data-community="cancel" data-id="${esc(t.id)}" ${t.status === "open" && t.ends_on >= day ? "" : "disabled"}>Cancel trip</button></div></div></article>`;
  }
  async function dashboard(opts = {}) {
    if (!c.login(pagePaths.dashboard)) return;
    const r = await c.api("/organizer/dashboard");
    frame(
      "Organizer dashboard",
      `${c.data().features?.organizerVerificationRequired ? `<p>Verification: ${esc(r.verification)} <button class="secondary" data-community="verification">Apply / view status</button></p>` : `<p>Organizer verification: coming soon. <button class="secondary" data-community="verification">Learn more</button></p>`}<div class="community-stats">${Object.entries(
        r.stats,
      )
        .map(([k, v]) => `<span><strong>${v}</strong> ${esc(k)}</span>`)
        .join(
          "",
        )}</div><button class="organizer-profile-link" data-community="profile" data-id="${esc(c.data().user.id)}"><span><strong>Organizer profile & reviews</strong><small>Your public profile and feedback from fellow travelers</small></span><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 18 18 6M6 6h12v12" /></svg></button><div class="organizer-trips-title"><h2>Your organized trips</h2><p>Your plans, people and next steps in one place.</p></div><div class="organizer-trip-list">${r.trips.map((t) => dashboardTrip(t, r)).join("") || '<p class="organizer-trips-empty">No organized trips yet. Start your first plan with Create a trip in the header.</p>'}</div>`,
      opts,
    );
  }
  async function edit(id) {
    const r = await c.api("/organizer/dashboard"),
      t = r.trips.find((t) => t.id === id);
    if (!t) throw Error("Trip is not managed by you.");
    const count = r.members.filter((m) => m.trip_id === id).length;
    const going = t.existing_travelers + count - 1;
    const zone = t.departure_timezone || "Asia/Kolkata";
    const departureTime = t.departure_utc
      ? new Intl.DateTimeFormat("en-GB", {
          timeZone: zone,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(new Date(t.departure_utc))
      : "12:00";
    const input = (name, label, value, type = "text", attrs = "") =>
      `<label class="form-field">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${attrs} required></label>`;
    frame(
      "Edit trip",
      form(
        "edit",
        hidden("id", id) +
          hidden("revision", t.revision || 0) +
          `<div class="form-grid">` +
          input(
            "title",
            "Give your trip a name",
            t.title,
            "text",
            'maxlength="65"',
          ) +
          input(
            "from",
            "Starting from",
            t.from_city,
            "text",
            `data-location data-place-id="${esc(t.from_place_id || "")}" maxlength="60"`,
          ) +
          input(
            "destination",
            "Destination",
            t.destination,
            "text",
            `data-location data-place-id="${esc(t.destination_place_id || "")}" maxlength="60"`,
          ) +
          input("start", "Departure", t.starts_on, "date") +
          input("departureTime", "Departure time", departureTime, "time") +
          input(
            "timeZone",
            "Departure time zone",
            zone,
            "text",
            'maxlength="80"',
          ) +
          input("end", "Return", t.ends_on, "date") +
          input(
            "min",
            "Minimum budget / person (₹)",
            t.budget_min,
            "number",
            'min="0" max="1000000"',
          ) +
          input(
            "max",
            "Maximum budget / person (₹)",
            t.budget_max,
            "number",
            'min="0" max="1000000"',
          ) +
          input(
            "going",
            "Already going (including registered participants)",
            going,
            "number",
            `min="${Math.max(1, count)}" max="20"`,
          ) +
          input(
            "seats",
            "Open spots",
            Math.max(0, t.capacity - going),
            "number",
            'min="0" max="19"',
          ) +
          `<label class="form-field">Travel style<select name="category">${options([...c.data().options.travelStyles, ...c.data().options.legacyStyles], t.category)}</select></label><label class="form-field">Travel mode<select name="mode">${options(["Bus", "Train", "Shared cab", "Self-drive", "Flight"], t.mode)}</select></label><label class="form-field full">Who can request to join?<select name="group" required>${c
            .data()
            .options.groups.map(
              (g) =>
                `<option value="${g.value}" ${(t.group_eligibility || (t.women_only ? "women" : "mixed")) === g.value ? "selected" : ""}>${esc(g.label)}</option>`,
            )
            .join("")}</select></label></div>` +
          message(
            "description",
            "Tell us about the plan",
            t.description,
            25,
            1200,
          ) +
          message(
            "plan",
            "A loose itinerary (optional)",
            t.plan || "",
            0,
            2000,
          ) +
          message(
            "rules",
            "Group ground rules (optional)",
            t.rules || "",
            0,
            1200,
          ) +
          '<label class="check-label"><input type="checkbox" name="adult" required> I am 18 or older. I’ll use public meeting points and respect travelers’ privacy.</label><p class="notice">Times use the departure time zone above. Registered participants stay in the trip and cannot be excluded by capacity or eligibility changes. Members and pending applicants will be notified of changes.</p>',
        "Save trip",
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
      `${c.data().features?.organizerVerificationRequired ? `<p>${r.verified ? "✓ Verified Organizer" : "Organizer application not approved"}</p>` : ""}<p>${esc(r.bio)}</p><p>${r.average ? r.average.toFixed(1) + "/5" : "No ratings yet"} · ${r.total} reviews</p><p>${r.distribution.map((n, i) => `${i + 1} stars: ${n}`).join(" · ")}</p>${r.reviews.map((v) => `<article class="request-item"><strong>${v.rating}/5 · ${esc(v.author_name)}</strong><p>${esc(v.body)}</p><small>${esc(v.trip_title)}</small></article>`).join("")}${trips.length ? form("organizer-review", `<label class="form-field">Completed trip<select name="tripId">${trips.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join("")}</select></label><label class="form-field">Stars<select name="rating">${options(["5", "4", "3", "2", "1"])}</select></label>` + message("body", "Your review")) : ""}`,
    );
  }
  async function admin(query = "", opts = {}) {
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
      opts,
    );
    if (!opts.valid || opts.valid()) {
      const filters = document.querySelector(
        (opts.page ? "#community-page-content" : "#modal-content") +
          ' [data-community-form="feedback-filter"]',
      );
      if (filters) {
        const values = new URLSearchParams(query.replace(/^\?/, ""));
        filters.elements.category.value = values.get("category") || "";
        filters.elements.status.value = values.get("status") || "";
      }
    }
  }
  async function feedback(opts = {}) {
    frame(
      "Write to Us",
      form(
        "feedback",
        field("name", "Name", c.data().user?.name || "") +
          field("email", "Email", c.data().user?.email || "", "email") +
          `<label class="form-field">Category<select name="category">${options(categories)}</select></label><label class="feedback-trap" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>` +
          message("message", "Your message", "", 20),
      ),
      opts,
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
      `<div class="stories-empty"><span aria-hidden="true">✳</span><div><strong>Your next trip could be a story worth sharing.</strong><p>Traveler stories will appear here after consent and review.</p></div></div>`;
    document.getElementById("community-admin").hidden = !c.data().user?.isAdmin;
  }
  window.TriplingCommunity = {
    init(ctx) {
      c = ctx;
      publicSection().catch(() => {});
    },
    verification: () => navigate(pagePaths.verification),
    dashboard: () => navigate(pagePaths.dashboard),
    navigate,
    hasPath,
    showRoute,
    invalidate: () => {
      routeVersion++;
    },
    organizer,
  };
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-community]");
    if (!b || !c) return;
    try {
      const name = b.dataset.community;
      if (pagePaths[name]) {
        if (
          b.tagName === "A" &&
          (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
        )
          return;
        e.preventDefault();
        return await navigate(
          pagePaths[name] +
            (name === "admin" ? "?offset=" + (b.dataset.offset || 0) : ""),
        );
      }
      if (name === "testimonial") await testimonial();
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
    const originPage = location.pathname,
      opts = pageOptions();
    const b = f.querySelector("[type=submit]");
    b.disabled = true;
    const d = Object.fromEntries(new FormData(f)),
      action = f.dataset.communityForm;
    try {
      if (action === "feedback-filter") {
        await navigate(
          "/admin?" +
            new URLSearchParams(Object.entries(d).filter(([, v]) => v)),
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
        if (!f.elements.from.dataset.placeId)
          throw Error("Select a starting city from the location suggestions.");
        body = {
          title: d.title,
          from: d.from,
          fromPlaceId: f.elements.from.dataset.placeId,
          destination: d.destination,
          ...(f.elements.destination.dataset.placeId
            ? { destinationPlaceId: f.elements.destination.dataset.placeId }
            : {}),
          start: d.start,
          end: d.end,
          departureTime: d.departureTime,
          timeZone: d.timeZone,
          min: +d.min,
          max: +d.max,
          going: +d.going,
          seats: +d.seats,
          category: d.category,
          mode: d.mode,
          groupEligibility: d.group,
          women: d.group === "women",
          description: d.description,
          plan: d.plan,
          rules: d.rules,
          age: !!d.adult,
          revision: +d.revision,
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
      if (location.pathname !== originPage || (opts.valid && !opts.valid()))
        return;
      c.toast(
        action === "reindex"
          ? `Processed ${saved.processed}; indexed ${saved.indexed}; unresolved ${saved.unresolved}. Unresolved places remain excluded.`
          : "Saved successfully.",
      );
      if (
        ["edit", "cancel", "remove"].includes(action) &&
        originPage === pagePaths.dashboard
      ) {
        c.close();
        await dashboard(opts);
        return;
      }
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
        await admin(location.search, opts);
      else if (action === "verification") await verification(opts);
      else
        frame(
          "Thank you",
          "<p>Your submission has been saved. Reviews and testimonials are subject to the applicable participation and moderation rules.</p>",
          opts,
        );
      await publicSection();
    } catch (error) {
      if (location.pathname !== originPage || (opts.valid && !opts.valid()))
        return;
      const alert =
        document.querySelector("#modal[open] .community-error") ||
        document.querySelector("#community-page-content .community-error");
      if (alert) alert.textContent = error.message;
      else c.toast(error.message);
    } finally {
      if (b.isConnected) b.disabled = false;
    }
  });
})();
