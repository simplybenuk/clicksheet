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
