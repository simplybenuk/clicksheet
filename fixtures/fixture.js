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
