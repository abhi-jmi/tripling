"use strict";
const paths = {
  bell: "M6 8a6 6 0 0 1 12 0v8l2 2H4l2-2V8 M10 21h4",
  refresh: "M20 8a8 8 0 1 0 1 6 M20 3v5h-5",
  mail: "M3 5h18v14H3Z m0 1 9 7 9-7",
  mountain: "m3 17 6-11 4 8 3-5 5 9H3Z M7 10l2 2 2-2",
  pin: "M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0Z M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  calendar: "M5 5h14v16H5Z M8 3v4 M16 3v4 M5 10h14 M8 14h2 M14 14h2",
  route:
    "M5 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4 M19 21a2 2 0 1 1 0-4 2 2 0 0 1 0 4 M5 7v7a3 3 0 0 0 3 3h8 M19 17V10a3 3 0 0 0-3-3h-5",
  shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z m-4 9 3 3 5-6",
  plus: "M12 5v14 M5 12h14",
  search: "M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M15 15l6 6",
  compass: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 m-6-3-2 6-6 2 2-6 6-2Z",
  "arrow-up-right": "M6 18 18 6 M6 6h12v12",
  "arrow-right": "M4 12h16 m-6-6 6 6-6 6",
  "arrow-down": "M12 4v16 m-6-6 6 6 6-6",
  users:
    "M15 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M5 21v-3a5 5 0 0 1 10 0v3 M17 5a3 3 0 0 1 0 6 M18 14a4 4 0 0 1 3 4v3",
  lock: "M6 10h12v11H6Z M8 10V7a4 4 0 1 1 8 0v3 M12 14v3",
  flag: "M5 21V4c5-4 9 4 14 0v10c-5 4-9-4-14 0",
  grid: "M4 4h6v6H4Z M14 4h6v6h-6Z M4 14h6v6H4Z M14 14h6v6h-6Z",
  flower:
    "M12 7c-6-7-12 3-4 5-8 2-2 12 4 5 6 7 12-3 4-5 8-2 2-12-4-5Z M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0",
  sliders: "M4 7h6 M14 7h6 M4 17h10 M18 17h2 M10 4v6 M14 14v6",
  bookmark: "M6 3h12v18l-6-4-6 4V3Z",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z",
  x: "M6 6l12 12 M6 18 18 6",
  info: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 11v6 M12 7v.1",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 6v6l4 2",
  check: "m5 12 4 4L19 6",
  heart: "M12 21S2 14 2 8a5 5 0 0 1 10-1A5 5 0 0 1 22 8c0 6-10 13-10 13",
};
const $ = (selector) => document.querySelector(selector);
const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.compass}"/></svg>`;
function icons(root = document) {
  root
    .querySelectorAll("[data-icon]")
    .forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
}
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (n) => "₹" + Number(n).toLocaleString("en-IN");
const today = () =>
  data.today ||
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const date = (d) =>
  new Date(d + "T12:00:00").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
const range = (t) => `${date(t.start)} – ${date(t.end)}`;
const duration = (t) =>
  Math.round((new Date(t.end) - new Date(t.start)) / 86400000) + 1;
const auth = window.TriplingAuth,
  api = auth.api;
let data = {
  user: null,
  trips: [],
  saved: [],
  requests: [],
  incoming: [],
  notifications: [],
  hidden: [],
};
let state = {
  profile: { name: "Traveler", city: "", bio: "", gender: "", age: false },
  saved: [],
  requests: {},
  created: [],
};
let view = "login",
  authMode = "login",
  category = "All trips",
  maxBudget = 1000000,
  travelMode = "",
  womenFilter = false,
  visibleCount = 6,
  currentTrip = null;
const trips = () => data.trips;
let modalVersion = 0,
  chatTimer = null,
  toastTimer = null;
const modal = $("#modal");
let focusBefore = null;
function stopChat() {
  clearInterval(chatTimer);
  chatTimer = null;
}
function openModal(html) {
  stopChat();
  modalVersion++;
  focusBefore = document.activeElement;
  $("#modal-content").innerHTML = html;
  icons(modal);
  window.TriplingLocations.init(modal);
  if (!modal.open) modal.showModal();
  modal.scrollTop = 0;
  setTimeout(() => {
    (
      modal.querySelector("[autofocus]") || modal.querySelector(".modal-close")
    )?.focus();
  }, 0);
}
function closeModal() {
  stopChat();
  modalVersion++;
  modal.close();
  focusBefore?.focus();
}
modal.addEventListener("close", stopChat);
modal.addEventListener("click", (e) => {
  if (e.target === modal) {
    const r = modal.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      closeModal();
  }
});
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 4500);
}
async function refresh() {
  data = await api("/bootstrap");
  auth.setUser(data.user);
  state = {
    profile: data.user || {
      name: "Traveler",
      city: "",
      bio: "",
      gender: "",
      age: false,
    },
    saved: data.saved,
    requests: Object.fromEntries(data.requests.map((r) => [r.trip_id, r])),
    created: data.trips.filter((t) => t.ownerId === data.user?.id),
  };
  $("#connection-error").hidden = true;
  render();
}
function errorMessage(error) {
  if (error.status === 401) {
    requestLogin(null);
    toast("Please log in again to continue.");
  } else toast(error.message);
}
function requireLogin(action) {
  if (auth.session) return true;
  requestLogin(action);
  return false;
}
function requestLogin(action) {
  auth.remember(action);
  if (modal.open) closeModal();
  location.hash = "login";
  setView("login");
  window.scrollTo({ top: 0 });
}
function browseGuest() {
  auth.remember(null);
  location.hash = "discover";
  setView("discover");
}
let legalVersions = null;
let googleEnabled = false;
async function loadLegal() {
  const response = await api("/legal");
  legalVersions = response.documents;
}
function setAuthMode(mode) {
  authMode = mode === "signup" ? "signup" : "login";
  const signup = authMode === "signup";
  $("#signup-names").hidden = !signup;
  for (const id of ["signup-first-name", "signup-last-name"]) {
    $("#" + id).disabled = !signup;
    $("#" + id).required = signup;
  }
  $("#confirm-password-field").hidden = !signup;
  $("#confirm-password").disabled = !signup;
  $("#confirm-password").required = signup;
  $("#signup-adult").disabled = !signup;
  $("#signup-adult").required = signup;
  $("#signup-legal").disabled = !signup;
  $("#signup-legal").required = signup;
  if (signup) {
    $("#auth-submit").disabled = true;
    loadLegal()
      .then(() => {
        if (authMode === "signup") $("#auth-submit").disabled = false;
      })
      .catch((error) => {
        if (authMode === "signup") {
          $("#login-error").textContent = error.message;
          $("#login-error").hidden = false;
        }
      });
  } else $("#auth-submit").disabled = false;
  $("#login-password").minLength = signup ? 10 : 1;
  $("#login-password").autocomplete = signup
    ? "new-password"
    : "current-password";
  $("#auth-subtitle").textContent = signup
    ? "Make an account. Find your people. Plan something good."
    : "Welcome back. Your next adventure is waiting.";
  $("#auth-submit").innerHTML =
    `${signup ? "Create account" : "Log in"} ${icon("arrow-right")}`;
  document.querySelectorAll("[data-auth-mode]").forEach((b) => {
    b.classList.toggle("selected", b.dataset.authMode === authMode);
    b.setAttribute("aria-pressed", String(b.dataset.authMode === authMode));
  });
  $("#login-error").hidden = true;
  $("#login-password").value = "";
  $("#confirm-password").value = "";
}
function setView(next) {
  if (next === "login") {
    if (auth.session) {
      location.hash = "discover";
      setView("discover");
      return;
    }
    view = "login";
    $("#login-page").hidden = false;
    $("#app-shell").hidden = true;
    document.body.classList.add("auth-screen");
    document.title = "Log in — Tripling";
    const action = auth.pending;
    const messages = {
      save: "Log in to save this trip for later.",
      join: "Log in to request to join this crew.",
      create: "Log in to create a trip.",
      profile: "Log in to set up your traveler profile.",
      view: "Log in to see your personal travel plans.",
      report: "Log in to record a report.",
      chat: "Log in to open your group chat.",
      notifications: "Log in to see your notifications.",
    };
    $("#login-context").hidden = !action;
    $("#login-context").textContent = messages[action?.type] || "";
    return;
  }
  if (
    ["saved", "my-trips"].includes(next) &&
    !requireLogin({ type: "view", view: next })
  )
    return;
  view = ["saved", "my-trips", "past-trips"].includes(next) ? next : "discover";
  $("#login-page").hidden = true;
  $("#app-shell").hidden = false;
  document.body.classList.remove("auth-screen");
  document.title = "Tripling — Find your people. Go places.";
  $("#discovery-intro").hidden = view !== "discover";
  $(".filter-row").hidden = view !== "discover";
  $(".why").hidden = view !== "discover";
  $(".create-banner").hidden = view !== "discover";
  $(".explore").classList.toggle("tab-intro", view !== "discover");
  $("#section-title").textContent =
    view === "saved"
      ? "Your someday, saved."
      : view === "my-trips"
        ? "Your next stories start here."
        : "Good trips need good company.";
  $("#section-eyebrow").textContent =
    view === "saved"
      ? "KEEP THE GOOD PLANS CLOSE"
      : view === "my-trips"
        ? "YOUR TRAVEL PLANS"
        : "FIND YOUR NEXT CHAPTER";
  $("#section-description").textContent =
    view === "saved"
      ? "Good plans, ready when you are."
      : view === "my-trips"
        ? "Your trips, join requests, and travel crews."
        : "Real plans. Like-minded travelers. A place for you.";
  if (view === "past-trips") {
    $("#section-title").textContent = "Past journeys. Shared stories.";
    $("#section-eyebrow").textContent = "TRAVEL HISTORY";
    $("#section-description").textContent =
      "Completed trips and reviews from registered participants.";
  }
  document.querySelectorAll("[data-view]").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === view);
    if (el.dataset.view === view) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });
  visibleCount = 6;
  render();
}
function card(t) {
  const saved = state.saved.includes(t.id),
    owned = t.organizerId === data.user?.id,
    request = state.requests[t.id],
    incoming = data.incoming.filter((r) => r.trip_id === t.id).length;
  return `<article class="trip-card"><div class="card-image"><img src="assets/${esc(t.image)}.jpg" alt="${esc(t.destination)} travel inspiration" loading="lazy"><span class="match-badge">${icon(t.women ? "shield" : "compass")} ${t.lifecycle === "completed" ? `Completed · ${t.reviewCount} reviews` : !t.organizerId ? "Inactive plan" : t.status === "canceled" ? "Canceled" : t.women ? "Women-only crew" : t.seats ? "Open to join" : "Crew complete"}</span><button class="save-button ${saved ? "saved" : ""}" data-save="${esc(t.id)}" aria-label="${saved ? "Unsave" : "Save"} ${esc(t.title)}" aria-pressed="${saved}">${icon("bookmark")}</button><span class="image-label">${icon("pin")} ${esc(t.destination)}</span></div><div class="card-content"><div class="card-tags">${t.tags.map((tag) => `<span class="tag ${tag === "Women only" ? "women" : ""}">${esc(tag)}</span>`).join("")}</div><button class="card-title" data-trip="${esc(t.id)}">${esc(t.title)}</button><p class="card-route">${esc(t.from)} → ${esc(t.destination)}</p><div class="card-info"><span>${icon("calendar")} ${range(t)}</span><span>${icon("clock")} ${duration(t)} days</span></div><div class="card-cost"><strong>${money(t.min)}–${money(t.max).slice(1)}</strong><span>/ person</span><span>${t.end < today() ? `${t.reviewCount} reviews${t.averageRating ? ` · ${t.averageRating}/5` : ""}` : `${t.seats} spots open`}</span></div><div class="card-footer"><span class="avatar host-avatar">${esc(t.initials)}</span><div class="host-name">Planned by <strong>${esc(owned ? "you" : t.host)}</strong><span>${t.isMember ? "Your travel crew" : "Community traveler"}</span></div><button class="card-cta" data-trip="${esc(t.id)}">View trip ${icon("arrow-up-right")}</button></div>${view === "my-trips" ? `<div class="my-card-status"><span class="request-status">${t.status === "canceled" ? "Canceled" : owned ? "Organizer" : t.isMember ? "Joined" : request?.status === "pending" ? "Awaiting approval" : "Left trip"}</span>${owned && t.end >= today() ? `<button data-incoming="${esc(t.id)}">Requests (${incoming})</button>` : ""}${t.isMember ? `<button data-leave="${esc(t.id)}">Leave trip</button>` : request ? `<button data-leave="${esc(t.id)}">${request.status === "accepted" ? "Leave trip" : "Cancel request"}</button>` : ""}</div>${t.isMember ? `<button class="card-chat" data-chat="${esc(t.id)}">${icon("users")} Open group chat ${icon("arrow-right")}</button>` : ""}` : ""}</div></article>`;
}
function render() {
  let list = trips();
  if (view === "saved") list = list.filter((t) => state.saved.includes(t.id));
  else if (view === "my-trips")
    list = list.filter(
      (t) =>
        t.participated ||
        t.ownerId === data.user?.id ||
        state.requests[t.id] ||
        t.isMember,
    );
  else if (view === "past-trips") list = list.filter((t) => t.end < today());
  else {
    const dest = $("#destination").value.trim().toLowerCase(),
      origin = $("#origin").value.trim().toLowerCase(),
      when = $("#departure").value;
    list = list.filter(
      (t) =>
        t.status === "open" &&
        !data.hidden.includes(t.id) &&
        t.end >= today() &&
        (!dest || `${t.destination} ${t.title}`.toLowerCase().includes(dest)) &&
        (!origin || t.from.toLowerCase().includes(origin)) &&
        (!when || (t.start <= when && t.end >= when)) &&
        (category === "All trips" ||
          (category === "Women only" ? t.women : t.category === category)) &&
        t.min <= maxBudget &&
        (!travelMode || t.mode.toLowerCase().includes(travelMode)) &&
        (!womenFilter || t.women),
    );
  }
  const sort = $("#sort").value;
  list = [...list].sort((a, b) =>
    sort === "budget" ? a.min - b.min : a.start.localeCompare(b.start),
  );
  $("#trip-grid").innerHTML = list.slice(0, visibleCount).map(card).join("");
  $("#empty").hidden = !!list.length;
  $("#empty h3").textContent =
    view === "saved"
      ? "Keep a good plan close."
      : view === "my-trips"
        ? "Your next story starts with a plan."
        : "Be the start of a good adventure.";
  $("#empty p").textContent =
    view === "saved"
      ? "Bookmark a trip to find it here."
      : view === "my-trips"
        ? "Create a trip or request to join a crew."
        : "No trips match yet. Try different filters, or create your own trip.";
  $("#results-count").innerHTML =
    `<strong>${list.length} ${list.length === 1 ? "trip" : "trips"}</strong> ${view === "saved" ? "saved for later" : view === "my-trips" ? "in your travel plans" : "with a story to share"}`;
  $("#load-more-wrap").hidden = view !== "discover" || !list.length;
  $("#load-more").hidden = list.length <= visibleCount;
  const count = [maxBudget < 1000000, !!travelMode, womenFilter].filter(
    Boolean,
  ).length;
  $("#filter-count").hidden = !count;
  $("#filter-count").textContent = count;
  $("#request-count").textContent = state.created.length + data.requests.length;
  $("#request-count").hidden = !(state.created.length + data.requests.length);
  $(".profile-button").hidden = !data.user;
  $(".login-nav").hidden = !!data.user;
  $(".notifications-nav").hidden = !data.user;
  $(".profile-button").childNodes[0].textContent = (data.user?.name || "Y")
    .slice(0, 1)
    .toUpperCase();
  const unread = data.notifications.filter((n) => !n.read_at).length;
  $("#notification-count").hidden = !unread;
  $("#notification-count").textContent = unread;
  const hosts = [
    ...new Map(data.trips.map((t) => [t.ownerId, t.initials])).values(),
  ].slice(0, 3);
  $(".avatar-stack").innerHTML = hosts.length
    ? hosts.map((name) => `<span>${esc(name)}</span>`).join("")
    : `<span>${icon("users")}</span>`;
  icons($("#trip-grid"));
}
async function detail(id) {
  const t = trips().find((t) => t.id === id);
  if (!t) return;
  currentTrip = id;
  const owned = t.organizerId === data.user?.id,
    request = state.requests[id];
  openModal(
    `<img class="modal-photo" src="assets/${esc(t.image)}.jpg" alt="${esc(t.destination)} scenery"><div class="modal-pad"><div class="detail-tags">${t.tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join("")}</div><h2 id="modal-title">${esc(t.title)}</h2><p class="detail-lead">${esc(t.description)}</p><div class="detail-grid"><div>${icon("route")}<span><small>The route</small>${esc(t.from)} → ${esc(t.destination)}</span></div><div>${icon("calendar")}<span><small>Travel dates</small>${range(t)}</span></div><div>${icon("users")}<span><small>Your crew</small>${t.total - t.seats} going · ${t.end < today() ? `${t.reviewCount} reviews${t.averageRating ? ` · ${t.averageRating}/5` : ""}` : `${t.seats} spots open`}</span></div><div>${icon("compass")}<span><small>Travel mode</small>${esc(t.mode)}</span></div></div><div class="detail-section"><h3>The loose plan</h3><p>${esc(t.plan || "Get to know the crew and decide the details together.")}</p></div><div class="detail-section"><h3>Budget for the journey</h3><p>${money(t.min)}–${money(t.max)} per person, estimated. Confirm costs together. Tripling does not collect payments.</p></div><div class="detail-section"><h3>Shared ground rules</h3><p>${esc(t.rules || "Respect personal boundaries, meet in public, and agree on costs before booking.")}</p></div><div class="detail-host"><span class="avatar">${esc(t.initials)}</span><div><strong>Planned by ${esc(t.host)}</strong><p>Community traveler</p></div></div><p class="notice">${t.women ? "Women-only membership is based on self-declaration. " : ""}A profile is not a guarantee of safety. Get to know your crew before committing.</p><div class="modal-actions">${t.isMember ? `<button class="primary" data-chat="${esc(id)}">Open group chat ${icon("users")}</button>` : t.end < today() || !t.organizerId || t.status !== "open" ? '<button class="primary" disabled>Joining closed</button>' : request ? '<button class="primary" disabled>Waiting for organizer approval</button>' : t.seats > 0 ? `<button class="primary" data-join="${esc(id)}">Request to join ${icon("arrow-right")}</button>` : '<button class="primary" disabled>No spots available</button>'}<button class="secondary" data-save="${esc(id)}">${icon("bookmark")} ${state.saved.includes(id) ? "Saved" : "Save trip"}</button></div>${owned && t.end >= today() ? `<button class="secondary" data-incoming="${esc(id)}">Manage join requests</button>` : ""}${t.participated ? `<button class="secondary" data-crew="${esc(id)}">Travelers & trip notices</button>` : ""}${t.isMember || request ? `<button class="report-link" data-leave="${esc(id)}">${t.isMember ? "Leave this trip" : "Cancel my request"}</button>` : ""}<p class="notice">Created by ${esc(t.creator)}. Trip records are retained. Everyone, including the organizer, can leave.</p><section class="detail-section" id="trip-reviews"><h3>Travel reviews</h3><p>Loading reviews…</p></section>${t.participated && t.status === "open" && t.end < today() ? `<button class="secondary" data-review="${esc(id)}">Review a traveler</button>` : ""}${!owned ? `<button class="report-link" data-report="${esc(id)}">Report or hide this trip</button>` : ""}</div>`,
  );
  const version = modalVersion;
  try {
    const result = await api(`/trips/${id}/reviews`);
    if (version !== modalVersion || !$("#trip-reviews")) return;
    $("#trip-reviews").innerHTML =
      "<h3>Travel reviews</h3>" +
      (result.reviews.length
        ? result.reviews
            .map(
              (r) =>
                `<div class="review-item"><strong>${esc(r.author)} → ${esc(r.traveler)} · ${r.rating}/5</strong><p>${esc(r.body)}</p></div>`,
            )
            .join("")
        : "<p>No reviews for this trip yet.</p>");
  } catch (error) {
    if (version === modalVersion && $("#trip-reviews"))
      $("#trip-reviews").innerHTML = "<p>Reviews could not be loaded.</p>";
  }
}
function join(id) {
  if (!requireLogin({ type: "join", id })) return;
  const t = trips().find((t) => t.id === id);
  if (!t) return;
  if (!state.profile.profileComplete) {
    profile();
    toast("First and last name are required before joining.");
    return;
  }
  if (t.women && state.profile.gender !== "woman") {
    openModal(
      `<div class="modal-pad"><h2 id="modal-title">This is a women-only trip.</h2><p>Only eligible travelers can request to join. Set your self-declared eligibility in your profile.</p><div class="modal-actions"><button class="primary" data-action="profile">Open profile</button></div></div>`,
    );
    return;
  }
  openModal(
    `<div class="modal-pad"><div class="eyebrow">START WITH A HELLO</div><h2 id="modal-title">Meet your next travel crew.</h2><p>Introduce yourself to ${esc(t.host)} for ${esc(t.title)}.</p><form id="join-form" data-id="${esc(id)}"><div class="form-grid"><label class="form-field full">Your introduction<textarea name="note" required minlength="15" maxlength="600" placeholder="Why does this trip feel like your kind of plan?" autofocus></textarea></label></div><p class="notice">The organizer will review your introduction. Group chat opens only after approval.</p><p class="form-error" data-form-error role="alert"></p><div class="modal-actions"><button class="primary" type="submit">Send join request ${icon("arrow-right")}</button><button class="secondary" type="button" data-trip="${esc(id)}">Back</button></div></form></div>`,
  );
}
function create() {
  if (!requireLogin({ type: "create" })) return;
  if (!state.profile.profileComplete) {
    profile();
    toast("Complete first and last name before creating a trip.");
    return;
  }
  openModal(
    `<div class="modal-pad"><div class="eyebrow">YOU BRING THE PLAN</div><h2 id="modal-title">Make room for a new adventure.</h2><p>Give your crew a feel for the trip. You can keep the details flexible.</p><form id="create-form"><div class="form-grid"><label class="form-field full">Give your trip a name<input name="title" required maxlength="65" placeholder="A weekend in the mountains…" autofocus></label><label class="form-field">Starting from<input name="from" data-location required maxlength="60" placeholder="e.g. Delhi"></label><label class="form-field">Destination<input name="destination" data-location required maxlength="60" placeholder="e.g. Manali"></label><label class="form-field">Departure<input type="date" name="start" min="${today()}" required></label><label class="form-field">Return<input type="date" name="end" min="${today()}" required></label><label class="form-field">Minimum budget / person (₹)<input name="min" type="number" min="0" max="1000000" required placeholder="5000"></label><label class="form-field">Maximum budget / person (₹)<input name="max" type="number" min="0" max="1000000" required placeholder="8000"></label><label class="form-field">Already going (including you)<input name="going" type="number" min="1" max="19" value="1" required></label><label class="form-field">Open spots<input name="seats" type="number" min="1" max="19" value="2" required></label><label class="form-field">Travel style<select name="category"><option>Mountains</option><option>Beach</option><option>Adventure</option><option>Weekend</option></select></label><label class="form-field">Travel mode<select name="mode"><option>Bus</option><option>Train</option><option>Shared cab</option><option>Self-drive</option><option>Flight</option></select></label><label class="form-field full">Tell us about the plan<textarea name="description" required minlength="25" maxlength="1200" placeholder="The places, the pace, and the people you’d love to share it with."></textarea></label><label class="form-field full">A loose itinerary (optional)<textarea name="plan" maxlength="2000" placeholder="The places you’d like to visit, with room for a detour."></textarea></label><label class="form-field full">Group ground rules (optional)<textarea name="rules" maxlength="1200" placeholder="Public meeting points, shared expectations, and personal boundaries."></textarea></label><label class="form-field full">Who can request to join?<select name="group"><option value="mixed">All eligible travelers (18+)</option><option value="women">Women only</option></select></label></div><label class="check-label"><input type="checkbox" required name="adult"> I am 18 or older. I’ll use public meeting points and respect travelers’ privacy.</label><p id="create-error" class="form-error" role="alert"></p><p class="notice">Your plan will be shared with the community. You approve who joins. Do not include private contact details or collect payments in the listing.</p><div class="modal-actions"><button class="primary" type="submit">Create my trip ${icon("arrow-up-right")}</button></div></form></div>`,
  );
}
function profile() {
  if (!requireLogin({ type: "profile" })) return;
  openModal(
    `<div class="modal-pad"><div class="eyebrow">THE PERSON BEHIND THE PLAN</div><h2 id="modal-title">Your traveler profile.</h2><div class="session-email">${icon("mail")}<div>${esc(auth.session?.email)}<small>Private account email</small></div></div><div class="profile-preview"><span class="avatar">${esc(state.profile.name.slice(0, 1))}</span><div><strong>${esc(state.profile.name)}</strong><p>Traveler profile</p></div></div><div class="modal-actions"><button class="secondary" data-directory>Find or block a traveler</button>${data.user?.googleLinked ? "<span>Google connected</span>" : googleEnabled ? '<a class="secondary" href="/api/auth/google/start?mode=link">Connect Google</a>' : "<small>Google sign-in is not configured yet.</small>"}</div><form id="profile-form"><div class="form-grid"><label class="form-field">First name<input name="firstName" required maxlength="50" autocomplete="given-name" value="${esc(state.profile.firstName)}" autofocus></label><label class="form-field">Last name<input name="lastName" required maxlength="50" autocomplete="family-name" value="${esc(state.profile.lastName)}"></label><label class="form-field">Home city (optional)<input name="city" data-location value="${esc(state.profile.city)}" maxlength="40" placeholder="City only, no exact address"></label><label class="form-field">Group eligibility<select name="gender"><option value="">Prefer not to say</option><option value="woman" ${state.profile.gender === "woman" ? "selected" : ""}>I identify as a woman</option><option value="other" ${state.profile.gender === "other" ? "selected" : ""}>Other / not eligible for women-only trips</option></select></label><label class="form-field full">Your travel style<textarea name="bio" maxlength="500" placeholder="A little about how you like to travel…">${esc(state.profile.bio)}</textarea></label></div><label class="check-label"><input type="checkbox" name="adult" required ${state.profile.age ? "checked" : ""}> I confirm I am 18 or older.</label><p class="notice">Your email is private. Your traveler name and introduction are visible to other members when you join a trip.</p><div class="modal-actions"><button class="primary" type="submit">Save profile ${icon("check")}</button><button class="secondary logout-button" type="button" data-action="logout">Log out</button></div></form></div>`,
  );
}
function safety() {
  openModal(
    `<div class="modal-pad"><div class="eyebrow">A LITTLE TRUST GOES A LONG WAY</div><h2 id="modal-title">Your journey. Your boundaries.</h2><p>Getting to know someone is part of the journey. Take your time before committing to travel together.</p><ul class="safety-list"><li>${icon("users")}<div><strong>Meet your crew first</strong><p>Have a video call, discuss the plan, and arrange your first meeting in a busy public place.</p></div></li><li>${icon("lock")}<div><strong>Keep personal details yours</strong><p>Avoid sharing your home address, identity documents, live location, or private contact details in public trip descriptions.</p></div></li><li>${icon("shield")}<div><strong>Trust has no shortcut</strong><p>A travel-fit score measures shared preferences. Even future verification badges won’t guarantee someone’s behavior or safety.</p></div></li><li>${icon("flag")}<div><strong>You can always change your mind</strong><p>Leave a plan if you feel uncomfortable. Use “Report or hide this trip” on a listing to record a report and hide it from your feed.</p></div></li></ul><p class="notice">In an emergency in India, call 112 or contact local emergency services. Share your plans with a trusted person. Tripling does not provide emergency monitoring. Reports are recorded for follow-up; they are not an emergency service.</p><div class="modal-actions"><button class="primary" data-action="close">Got it. Let’s explore.</button></div></div>`,
  );
}
function filters() {
  openModal(
    `<div class="modal-pad"><div class="eyebrow">A PLAN THAT FEELS LIKE YOU</div><h2 id="modal-title">Find your kind of trip.</h2><form id="filter-form"><div class="form-grid"><label class="form-field full">Maximum budget per person<select name="budget"><option value="1000000">Any budget</option><option value="5000">Up to ₹5,000</option><option value="10000">Up to ₹10,000</option><option value="15000">Up to ₹15,000</option></select></label><label class="form-field full">Travel mode<select name="mode"><option value="">Any travel mode</option><option value="bus">Bus</option><option value="train">Train</option><option value="cab">Cab</option><option value="self-drive">Self-drive</option><option value="flight">Flight</option></select></label></div><label class="check-label"><input type="checkbox" name="women" ${womenFilter ? "checked" : ""}> Show women-only trips</label><p class="notice">Budget filters use each trip’s minimum estimated cost. Final expenses are agreed between travelers.</p><div class="modal-actions"><button type="submit" class="primary">Show matching trips</button><button type="button" class="secondary" data-action="reset-filters">Reset filters</button></div></form></div>`,
  );
  $("#filter-form [name=budget]").value = String(maxBudget);
  $("#filter-form [name=mode]").value = travelMode;
}
function reset() {
  category = "All trips";
  maxBudget = 1000000;
  travelMode = "";
  womenFilter = false;
  $("#search-form").reset();
  document
    .querySelectorAll("[data-category]")
    .forEach((b) =>
      b.classList.toggle("selected", b.dataset.category === category),
    );
  if (view !== "discover") {
    location.hash = "discover";
    setView("discover");
  }
  render();
}
function report(id) {
  if (!requireLogin({ type: "report", id })) return;
  openModal(
    `<div class="modal-pad"><div class="eyebrow">YOUR SPACE. YOUR CHOICE.</div><h2 id="modal-title">Report or hide this trip.</h2><p>Hide the listing from your discovery feed. Your report will be stored securely for follow-up.</p><form id="report-form" data-id="${esc(id)}"><div class="form-grid"><label class="form-field full">Reason<select name="reason"><option>I don’t want to see this trip</option><option>Spam or commercial promotion</option><option>Harassment or inappropriate content</option><option>Safety concern</option></select></label><label class="form-field full">More context (optional)<textarea name="note" maxlength="600" placeholder="Please do not include sensitive personal details."></textarea></label></div><p class="notice">For an immediate danger, contact emergency services. Reports do not trigger an immediate emergency response.</p><div class="modal-actions"><button class="primary" type="submit">Submit report & hide trip</button><button class="secondary" type="button" data-trip="${esc(id)}">Back</button></div></form></div>`,
  );
}
async function saveTrip(id) {
  if (!requireLogin({ type: "save", id })) return;
  const saved = !state.saved.includes(id);
  await api(`/trips/${id}/save`, { method: "PUT", body: { saved } });
  await refresh();
  if (modal.open) await detail(id);
  toast(saved ? "Saved for another day." : "Trip removed from saved.");
}
async function incoming(id) {
  if (!requireLogin({ type: "view", view: "my-trips" })) return;
  await refresh();
  const t = trips().find((t) => t.id === id);
  if (!t) return;
  const requests = data.incoming.filter((r) => r.trip_id === id);
  openModal(
    `<div class="modal-pad"><div class="eyebrow">FIND YOUR KIND OF CREW</div><h2 id="modal-title">Join requests</h2><p>${esc(t.title)} · ${t.seats} spots available</p>${requests.length ? requests.map((r) => `<article class="request-item"><h3>${esc(r.display_name)}</h3>${r.bio ? `<p>${esc(r.bio)}</p>` : ""}<p class="request-note">${esc(r.note)}</p><div class="modal-actions"><button class="primary" data-decision="accepted" data-id="${esc(id)}" data-user="${esc(r.user_id)}">Accept</button><button class="secondary" data-decision="rejected" data-id="${esc(id)}" data-user="${esc(r.user_id)}">Decline</button></div></article>`).join("") : "<p>No pending requests. Share your plan with your community.</p>"}<div class="modal-actions"><button class="secondary" data-trip="${esc(id)}">Back to trip</button></div></div>`,
  );
}
async function chat(id) {
  if (!requireLogin({ type: "chat", id })) return;
  const result = await api(`/trips/${id}/members`);
  const t = trips().find((t) => t.id === id);
  openModal(
    `<div class="modal-pad"><div class="eyebrow">YOUR TRAVEL CREW</div><h2 id="modal-title">${esc(t?.title || "Group chat")}</h2><p>${result.members.map((m) => esc(m.name)).join(" · ")}</p><div id="chat-messages" class="chat-messages" aria-live="polite"></div><p id="chat-error" class="form-error" role="status"></p>${t?.status === "canceled" || t?.end < today() || !t?.organizerId ? '<p class="notice">This trip is past or inactive. The chat is read-only.</p>' : `<form id="chat-form" data-id="${esc(id)}"><label class="form-field">Message your crew<textarea name="body" required maxlength="2000" rows="3" placeholder="A public meeting point? A place to stay? Start planning together."></textarea></label><div class="modal-actions"><button class="primary" type="submit">Send message ${icon("arrow-right")}</button></div></form>`}</div>`,
  );
  const version = modalVersion;
  await loadMessages(id, version, true);
  chatTimer = setInterval(() => loadMessages(id, version), 5000);
}
async function loadMessages(id, version, scroll = false) {
  try {
    const result = await api(`/trips/${id}/messages`);
    if (version !== modalVersion || !modal.open || !$("#chat-messages")) return;
    const box = $("#chat-messages");
    const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const html = result.messages.length
      ? result.messages
          .map(
            (m) =>
              `<div class="chat-row ${m.user_id === data.user?.id ? "mine" : ""}"><small>${esc(m.name)} · ${esc(new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</small>${esc(m.body)}</div>`,
          )
          .join("")
      : '<p class="chat-empty">Your crew is here. Start with a hello.</p>';
    if (box.innerHTML !== html) {
      box.innerHTML = html;
      if (scroll || nearEnd) box.scrollTop = box.scrollHeight;
    }
    $("#chat-error").textContent = "";
  } catch (error) {
    if (version === modalVersion && $("#chat-error"))
      $("#chat-error").textContent = error.message;
  }
}
async function notifications() {
  if (!requireLogin({ type: "notifications" })) return;
  await refresh();
  openModal(
    `<div class="modal-pad"><div class="eyebrow">WHAT’S NEW WITH YOUR PLANS</div><h2 id="modal-title">Your notifications</h2>${data.notifications.length ? data.notifications.map((n) => `<article class="notification-item ${n.read_at ? "" : "unread"}"><p>${esc(n.body)}</p><small>${esc(new Date(n.created_at).toLocaleString())}</small>${n.trip_id ? `<button class="report-link" data-trip="${esc(n.trip_id)}">View trip</button>` : ""}</article>`).join("") : "<p>Nothing new yet. We’ll keep your trip updates here.</p>"}</div>`,
  );
  await api("/notifications/read", { method: "POST", body: {} });
  await refresh();
}
async function review(id) {
  const result = await api(`/trips/${id}/members`);
  const members = result.canReview
    ? result.members.filter((m) => m.id !== data.user?.id && m.canReview)
    : [];
  openModal(
    `<div class="modal-pad"><h2 id="modal-title">How was traveling together?</h2><p>Focus on reliability, communication, and respect for the crew.</p>${members.length ? `<form id="review-form" data-id="${esc(id)}"><div class="form-grid"><label class="form-field full">Traveler<select name="travelerId">${members.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("")}</select></label><label class="form-field full">Travel experience<select name="rating"><option value="5">5 — Excellent</option><option value="4">4 — Good</option><option value="3">3 — Okay</option><option value="2">2 — Difficult</option><option value="1">1 — Poor</option></select></label><label class="form-field full">Your review<textarea name="body" required minlength="10" maxlength="1000"></textarea></label></div><p class="form-error" data-form-error role="alert"></p><button type="submit" class="primary">Post review</button></form>` : "<p>There are no other registered members to review.</p>"}</div>`,
  );
}
async function endSession() {
  await auth.logout();
  setAuthMode("login");
  data = {
    user: null,
    trips: [],
    saved: [],
    requests: [],
    incoming: [],
    notifications: [],
    hidden: [],
  };
  if (modal.open) closeModal();
  await refresh();
  location.hash = "login";
  setView("login");
  toast("You’re logged out. Your plans are saved to your account.");
}
async function resumeAction() {
  const action = auth.consume();
  await refresh();
  location.hash = "discover";
  setView("discover");
  window.scrollTo({ top: 0 });
  if (!action) return;
  if (action.type === "view") {
    const next = ["saved", "my-trips"].includes(action.view)
      ? action.view
      : "discover";
    location.hash = next;
    setView(next);
    return;
  }
  if (
    ["save", "join", "report", "chat"].includes(action.type) &&
    !trips().some((t) => t.id === action.id)
  ) {
    toast("That trip is no longer available.");
    return;
  }
  if (action.type === "save") await saveTrip(action.id);
  if (action.type === "join") join(action.id);
  if (action.type === "create") create();
  if (action.type === "profile") profile();
  if (action.type === "report") report(action.id);
  if (action.type === "chat") await chat(action.id);
  if (action.type === "notifications") await notifications();
}
$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target,
    button = $("#auth-submit"),
    error = $("#login-error"),
    email = $("#login-email").value.trim().toLowerCase(),
    password = $("#login-password").value,
    confirm = $("#confirm-password").value;
  error.hidden = true;
  if (authMode === "signup" && password !== confirm) {
    error.textContent = "Passwords do not match.";
    error.hidden = false;
    $("#confirm-password").focus();
    return;
  }
  button.disabled = true;
  button.textContent =
    authMode === "signup" ? "Creating your account…" : "Logging in…";
  try {
    if (authMode === "signup") {
      if (!legalVersions?.terms || !legalVersions?.privacy)
        throw new Error(
          "The legal policies are not available. Please reload this page before signing up.",
        );
      if (!$("#signup-legal").checked)
        throw new Error(
          "Review and accept the Terms and Privacy Policy before signing up.",
        );
      await auth.signup(
        email,
        password,
        confirm,
        $("#signup-adult").checked,
        legalVersions,
        $("#signup-first-name").value.trim(),
        $("#signup-last-name").value.trim(),
      );
    } else await auth.login(email, password);
    form.reset();
    await resumeAction();
    if (!auth.session?.profileComplete) profile();
    toast(
      authMode === "signup"
        ? "Welcome to Tripling. Make yourself at home."
        : "Welcome back. Your plans are ready.",
    );
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    if (err.status === 409 && authMode === "signup") {
      $("#signup-legal").checked = false;
      await loadLegal().catch(() => {});
    }
  } finally {
    button.disabled = false;
    button.innerHTML = `${authMode === "signup" ? "Create account" : "Log in"} ${icon("arrow-right")}`;
  }
});
async function handleClick(event) {
  const b = event.target.closest("button,a");
  if (!b || b.disabled) return;
  if (b.dataset.authMode) {
    setAuthMode(b.dataset.authMode);
    return;
  }
  if (b.dataset.togglePassword) {
    const field = $("#" + b.dataset.togglePassword);
    field.type = field.type === "password" ? "text" : "password";
    b.textContent = field.type === "password" ? "Show" : "Hide";
    b.setAttribute(
      "aria-label",
      field.type === "password" ? "Show password" : "Hide password",
    );
    b.setAttribute("aria-pressed", String(field.type === "text"));
    return;
  }
  if (b.dataset.save) {
    b.disabled = true;
    try {
      await saveTrip(b.dataset.save);
    } finally {
      b.disabled = false;
    }
    return;
  }
  if (b.dataset.trip) {
    await detail(b.dataset.trip);
    return;
  }
  if (b.dataset.join) {
    join(b.dataset.join);
    return;
  }
  if (b.dataset.chat) {
    await chat(b.dataset.chat);
    return;
  }
  if (b.dataset.incoming) {
    await incoming(b.dataset.incoming);
    return;
  }
  if (b.dataset.review) {
    await review(b.dataset.review);
    return;
  }
  if (b.dataset.decision) {
    b.disabled = true;
    try {
      await api(`/trips/${b.dataset.id}/requests/${b.dataset.user}`, {
        method: "PUT",
        body: { status: b.dataset.decision },
      });
      await incoming(b.dataset.id);
      toast(
        b.dataset.decision === "accepted"
          ? "Traveler accepted. Your group chat is ready."
          : "Join request declined.",
      );
    } finally {
      b.disabled = false;
    }
    return;
  }
  if (b.dataset.leave) {
    if (!requireLogin({ type: "view", view: "my-trips" })) return;
    openModal(
      `<div class="modal-pad"><h2 id="modal-title">Leave this travel plan?</h2><p>Your active membership will end. The trip and participation history stay available. If you are the organizer, another active member becomes organizer. With no members left, new requests close.</p><div class="modal-actions"><button class="primary" data-confirm-leave="${esc(b.dataset.leave)}">Leave plan</button><button class="secondary" data-action="close">Keep it</button></div></div>`,
    );
    return;
  }
  if (b.dataset.confirmLeave) {
    await api(`/trips/${b.dataset.confirmLeave}/requests`, {
      method: "DELETE",
      body: {},
    });
    closeModal();
    await refresh();
    toast("You’ve left this travel plan.");
    return;
  }
  if (b.dataset.report) {
    report(b.dataset.report);
    return;
  }
  if (b.dataset.category) {
    category = b.dataset.category;
    document
      .querySelectorAll("[data-category]")
      .forEach((el) => el.classList.toggle("selected", el === b));
    render();
    return;
  }
  if (b.dataset.destination) {
    $("#destination").value = b.dataset.destination;
    $("#search-form").requestSubmit();
    return;
  }
  const actions = {
    close: closeModal,
    create,
    profile,
    safety,
    filters,
    reset,
    login: () => requestLogin(null),
    "browse-guest": browseGuest,
    logout: endSession,
    notifications,
    refresh: async () => {
      await refresh();
      toast("Trips refreshed.");
    },
    "reset-filters": () => {
      maxBudget = 1000000;
      travelMode = "";
      womenFilter = false;
      closeModal();
      render();
    },
    "my-trips": () => {
      closeModal();
      location.hash = "my-trips";
      setView("my-trips");
    },
  };
  await actions[b.dataset.action]?.();
}
document.addEventListener("click", (event) => {
  handleClick(event).catch(errorMessage);
});
$("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  render();
  $(".explore").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#sort").addEventListener("change", render);
$("#load-more").addEventListener("click", () => {
  visibleCount += 6;
  render();
});
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (
    ![
      "create-form",
      "profile-form",
      "join-form",
      "filter-form",
      "report-form",
      "chat-form",
      "review-form",
    ].includes(form.id)
  )
    return;
  event.preventDefault();
  const d = Object.fromEntries(new FormData(form));
  const button = form.querySelector("[type=submit]");
  if (button) button.disabled = true;
  try {
    if (form.id === "filter-form") {
      maxBudget = Number(d.budget);
      travelMode = d.mode;
      womenFilter = !!d.women;
      closeModal();
      render();
      return;
    }
    if (
      !requireLogin(
        form.id === "create-form"
          ? { type: "create" }
          : form.id === "join-form"
            ? { type: "join", id: form.dataset.id }
            : { type: "profile" },
      )
    )
      return;
    if (form.id === "profile-form") {
      await api("/profile", {
        method: "PUT",
        body: {
          firstName: d.firstName,
          lastName: d.lastName,
          city: d.city,
          gender: d.gender,
          bio: d.bio,
          age: !!d.adult,
        },
      });
      closeModal();
      await refresh();
      toast("Your traveler profile is saved.");
    }
    if (form.id === "create-form") {
      await api("/trips", {
        method: "POST",
        body: {
          title: d.title,
          from: d.from,
          destination: d.destination,
          start: d.start,
          end: d.end,
          min: +d.min,
          max: +d.max,
          going: +d.going,
          seats: +d.seats,
          category: d.category,
          mode: d.mode,
          description: d.description,
          plan: d.plan,
          rules: d.rules,
          women: d.group === "women",
          age: !!d.adult,
        },
      });
      closeModal();
      await refresh();
      location.hash = "my-trips";
      setView("my-trips");
      toast("Your trip is live. Find your crew.");
    }
    if (form.id === "join-form") {
      await api(`/trips/${form.dataset.id}/requests`, {
        method: "POST",
        body: { note: d.note },
      });
      closeModal();
      await refresh();
      toast("Request sent. The organizer will review it.");
    }
    if (form.id === "report-form") {
      await api("/reports", {
        method: "POST",
        body: { tripId: form.dataset.id, reason: d.reason, note: d.note },
      });
      closeModal();
      await refresh();
      toast("Report recorded. The trip is hidden from your feed.");
    }
    if (form.id === "chat-form") {
      await api(`/trips/${form.dataset.id}/messages`, {
        method: "POST",
        body: { body: d.body },
      });
      form.reset();
      await loadMessages(form.dataset.id, modalVersion, true);
    }
    if (form.id === "review-form") {
      await api(`/trips/${form.dataset.id}/reviews`, {
        method: "POST",
        body: { travelerId: d.travelerId, rating: +d.rating, body: d.body },
      });
      await detail(form.dataset.id);
      toast("Your travel review is posted.");
    }
  } catch (error) {
    if (error.status === 401) errorMessage(error);
    else {
      const target =
        form.querySelector("[data-form-error]") ||
        form.querySelector(".form-error");
      if (target) {
        target.textContent = error.message;
        target.scrollIntoView({ block: "nearest" });
      } else toast(error.message);
    }
  } finally {
    if (button) button.disabled = false;
  }
});
window.addEventListener("hashchange", () => {
  const hash = location.hash.slice(1);
  if (hash === "sso-complete") completeGoogle().catch(errorMessage);
  else if (hash === "profile" && auth.session) profile();
  else setView(hash);
});
window.addEventListener("focus", () => {
  if (view !== "login") refresh().catch(errorMessage);
});
async function completeGoogle() {
  const pending = await api("/auth/google/pending");
  await loadLegal();
  openModal(
    `<div class="modal-pad"><div class="eyebrow">GOOGLE SIGN-IN</div><h2 id="modal-title">Complete your traveler profile.</h2><p>${esc(pending.email)} · verified by Google</p><form id="google-complete-form"><div class="form-grid"><label class="form-field">First name<input name="firstName" required maxlength="50" autocomplete="given-name" value="${esc(pending.firstName)}"></label><label class="form-field">Last name<input name="lastName" required maxlength="50" autocomplete="family-name" value="${esc(pending.lastName)}"></label></div><label class="check-label"><input name="age" type="checkbox" required>I am 18 or older.</label><label class="check-label"><input name="legal" type="checkbox" required><span>I agree to the <a href="/terms" target="_blank" rel="noopener">Terms</a> and acknowledge the <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</span></label><p class="form-error" data-form-error role="alert"></p><button class="primary" type="submit">Create my account</button></form></div>`,
  );
}
function blockNotices(notices) {
  return notices.length
    ? notices
        .map(
          (n) =>
            `<div class="trip-notice"><strong>${esc(n.blocker)} blocked ${esc(n.blocked)}</strong><p>${esc(n.category)} · ${esc(n.reason)}</p><small>Statement by the blocking user; not a finding by Tripling. Visible only to registered participants of ${esc(n.title || "this trip")}.</small><div><button class="report-link" data-notice-report="${esc(n.id)}">Report this statement</button></div></div>`,
        )
        .join("")
    : "<p>No active notices shared with this trip.</p>";
}
async function crew(id) {
  const result = await api(`/trips/${id}/members`),
    trip = trips().find((t) => t.id === id);
  openModal(
    `<div class="modal-pad"><h2 id="modal-title">${esc(trip?.title)} · Travelers</h2><p>Registered participants, including those who left. Private notices stay within this trip.</p>${result.members.map((m) => `<div class="traveler-row"><strong>${esc(m.name)}</strong> · ${m.active ? "Active" : "Left trip"}<p>${esc(m.bio)}</p><button class="secondary" data-traveler="${esc(m.id)}">Traveler profile</button></div>`).join("")}<h3>Trip notices</h3>${blockNotices(result.blocks)}</div>`,
  );
}
function directory() {
  if (!requireLogin({ type: "profile" })) return;
  openModal(
    `<div class="modal-pad"><h2 id="modal-title">Find a traveler.</h2><form id="directory-form"><label class="form-field">Name starts with<input name="query" required maxlength="101" placeholder="Type first letters of their name" autofocus></label><button class="primary" type="submit">Search travelers</button><p class="form-error" data-form-error role="alert"></p></form><div id="traveler-results" aria-live="polite"></div><h3>Your active blocks</h3>${(data.blocks || []).map((b) => `<div class="trip-notice"><strong>${esc(b.name)} · ${esc(b.category)}</strong><p>${esc(b.reason)}</p><small>${b.context_trip_id ? "Shared with registered participants of the selected trip" : "Reason visible only to you"}</small><div><button class="secondary" data-unblock="${esc(b.id)}">Unblock traveler</button></div></div>`).join("") || "<p>You have no active blocks.</p>"}</div>`,
  );
}
async function traveler(id) {
  const result = await api(`/travelers/${id}`);
  openModal(
    `<div class="modal-pad"><h2 id="modal-title">${esc(result.user.name)}</h2><p>${esc(result.user.bio)}</p>${id === data.user?.id ? "" : result.myBlockId ? `<button class="secondary" data-unblock="${esc(result.myBlockId)}">Unblock traveler</button>` : `<form id="block-form" data-id="${esc(id)}"><h3>Block this traveler</h3><p class="notice">Blocks prevent new requests or approvals into each other’s crews and hide messages between you. Existing members remain in the trip; you may leave at any time.</p><div class="form-grid"><label class="form-field full">Category<select name="category">${["Harassment", "Safety concern", "Spam", "Communication / boundaries", "Other"].map((c) => `<option>${esc(c)}</option>`).join("")}</select></label><label class="form-field full">Who can see your reason?<select name="tripId"><option value="">Only me (private block)</option>${result.sharedTrips.map((t) => `<option value="${esc(t.id)}">Registered participants: ${esc(t.title)}</option>`).join("")}</select></label><label class="form-field full">Explain your reason<textarea name="reason" required minlength="20" maxlength="1000" placeholder="Describe the behavior clearly. Do not include contact details or identity documents."></textarea></label></div><p class="notice">A shared reason is labeled as your statement. Guests and unrelated travelers cannot see it. Participants may report it.</p><p class="form-error" data-form-error role="alert"></p><button class="primary" type="submit">Block traveler</button></form>`}<h3>Notices in your shared trips</h3>${blockNotices(result.notices)}</div>`,
  );
}
document.addEventListener("click", (event) => {
  const b = event.target.closest("button");
  if (!b) return;
  (async () => {
    if (b.hasAttribute("data-directory")) directory();
    if (b.dataset.crew) await crew(b.dataset.crew);
    if (b.dataset.traveler) await traveler(b.dataset.traveler);
    if (b.dataset.unblock) {
      await api("/blocks/" + b.dataset.unblock, { method: "DELETE", body: {} });
      await refresh();
      directory();
      toast("Traveler unblocked.");
    }
    if (b.dataset.noticeReport)
      openModal(
        `<div class="modal-pad"><h2 id="modal-title">Report a trip statement</h2><form id="notice-report-form" data-id="${esc(b.dataset.noticeReport)}"><label class="form-field">Why should this be reviewed?<textarea name="reason" required minlength="15" maxlength="600"></textarea></label><p class="notice">Reports are recorded for operator follow-up. For urgent help in India, call 112.</p><p class="form-error" data-form-error role="alert"></p><button class="primary" type="submit">Record report</button></form></div>`,
      );
  })().catch(errorMessage);
});
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (
    ![
      "directory-form",
      "block-form",
      "notice-report-form",
      "google-complete-form",
    ].includes(form.id)
  )
    return;
  event.preventDefault();
  const d = Object.fromEntries(new FormData(form)),
    button = form.querySelector("[type=submit]");
  button.disabled = true;
  (async () => {
    if (form.id === "directory-form") {
      const r = await api("/travelers?q=" + encodeURIComponent(d.query));
      $("#traveler-results").innerHTML =
        r.travelers
          .map(
            (u) =>
              `<div class="traveler-row"><strong>${esc(u.name)}</strong><p>${esc(u.bio)}</p><button class="secondary" data-traveler="${esc(u.id)}">View traveler</button></div>`,
          )
          .join("") || "<p>No travelers found.</p>";
    }
    if (form.id === "block-form") {
      await api("/blocks", {
        method: "POST",
        body: {
          userId: form.dataset.id,
          tripId: d.tripId || null,
          category: d.category,
          reason: d.reason,
        },
      });
      await refresh();
      await traveler(form.dataset.id);
      toast("Traveler blocked.");
    }
    if (form.id === "notice-report-form") {
      await api("/blocks/" + form.dataset.id + "/report", {
        method: "POST",
        body: { reason: d.reason },
      });
      closeModal();
      toast("Report recorded for follow-up.");
    }
    if (form.id === "google-complete-form") {
      const r = await api("/auth/google/complete", {
        method: "POST",
        body: {
          firstName: d.firstName,
          lastName: d.lastName,
          age: !!d.age,
          acceptedLegal: !!d.legal,
          termsVersion: legalVersions.terms.version,
          privacyVersion: legalVersions.privacy.version,
        },
      });
      auth.setUser(r.user);
      closeModal();
      location.hash = "discover";
      await resumeAction();
    }
  })()
    .catch(async (e) => {
      const target = form.querySelector("[data-form-error]");
      if (target) target.textContent = e.message;
      if (form.id === "google-complete-form" && e.status === 409) {
        await loadLegal();
        form.elements.legal.checked = false;
      }
    })
    .finally(() => {
      button.disabled = false;
    });
});

async function boot() {
  icons();
  window.TriplingLocations.init();
  api("/auth/providers")
    .then((p) => {
      googleEnabled = p.google;
      $("#google-signin").hidden = !p.google;
      $("#google-unavailable").hidden = p.google;
    })
    .catch(() => {});
  setAuthMode("login");
  $("#auth-submit").disabled = true;
  try {
    await refresh();
    setView(location.hash.slice(1) || (data.user ? "discover" : "login"));
    if (data.user && auth.pending && location.hash === "#discover")
      await resumeAction();
    if (location.hash === "#sso-complete") await completeGoogle();
    else if (
      data.user &&
      (!data.user.profileComplete || location.hash === "#profile")
    )
      profile();
    const authError = new URLSearchParams(location.search).get("auth_error");
    if (authError) {
      const messages = {
        existing:
          "This email already has an account. Log in with your password, then connect Google in your profile.",
        link: "Use the Google account matching your Tripling email.",
        expired: "Google sign-in expired. Please try again.",
        canceled: "Google sign-in was canceled.",
        verification: "Google sign-in could not be verified. Please try again.",
        unavailable: "Google sign-in is not configured yet.",
      };
      $("#login-error").textContent =
        messages[authError] || "Sign-in failed. Please try again.";
      $("#login-error").hidden = false;
      history.replaceState(null, "", location.pathname + location.hash);
    }
  } catch (error) {
    $("#login-error").textContent = error.message;
    $("#login-error").hidden = false;
    $("#connection-error").textContent = error.message;
    $("#connection-error").hidden = false;
    setView(location.hash.slice(1) || "login");
  } finally {
    $("#auth-submit").disabled = false;
  }
}
boot();
