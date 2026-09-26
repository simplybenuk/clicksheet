const action = document.querySelector('[data-action="load-details"]');
const result = document.querySelector('[data-role="result"]');

action?.addEventListener("click", () => {
  action.disabled = true;
  result.textContent = "Loading workspace details…";

  window.setTimeout(() => {
    result.textContent = "Workspace details loaded.";
    action.disabled = false;
  }, 180);
});

// Same-document route change: the URL changes through pushState without a load.
const route = document.querySelector('[data-action="route"]');
const routeLabel = document.querySelector('[data-role="route"]');

route?.addEventListener("click", (event) => {
  event.preventDefault();
  history.pushState({}, "", route.getAttribute("href"));
  routeLabel.textContent = "Route: users";
});

// A submit-style button that changes itself, then navigates after a slow
// server response. The page it leads to must still be captured.
const saveAndGo = document.querySelector('[data-action="save-and-go"]');
saveAndGo?.addEventListener("click", () => {
  saveAndGo.textContent = "Saving…";
  saveAndGo.disabled = true;
  window.setTimeout(() => { location.href = "/second.html"; }, 700);
});

// "Show password" turns the field into plain text; it must stay masked.
const reveal = document.querySelector('[data-action="reveal-password"]');
const password = document.querySelector('[data-role="password"]');
reveal?.addEventListener("click", () => {
  password.type = password.type === "password" ? "text" : "password";
  reveal.textContent = password.type === "password" ? "Show password" : "Hide password";
});

// Ambient change: a ticking clock must not turn no-op clicks into frames.
const clock = document.querySelector('[data-role="clock"]');
let ticks = 0;
if (clock) window.setInterval(() => { clock.textContent = String(++ticks); }, 400);

// Pagination with an async response: each click must get its own frame even
// when clicked repeatedly.
const nextPage = document.querySelector('[data-action="next-page"]');
const pageList = document.querySelector('[data-role="page-list"]');
let pageNumber = 1;
nextPage?.addEventListener("click", () => {
  nextPage.disabled = true;
  pageList.textContent = "Loading…";
  window.setTimeout(() => {
    pageList.textContent = `Page ${++pageNumber}`;
    nextPage.disabled = false;
  }, 120);
});

// A status line that updates itself a few times on load, then goes quiet.
// A later click whose only effect is on this line must still be captured.
const syncStatus = document.querySelector('[data-role="sync-status"]');
// Only with ?sync, so other scenarios on this page are not disturbed.
if (new URLSearchParams(location.search).has("sync")) {
  [1, 2, 3].forEach((step) => window.setTimeout(() => { syncStatus.textContent = `Syncing ${step}/3…`; }, 2000 + step * 250));
}
document.querySelector('[data-action="refresh-status"]')?.addEventListener("click", () => {
  syncStatus.textContent = `Refreshed at ${new Date().toLocaleTimeString()}`;
});
