// A web component that renders its password field asynchronously, like
// Lit-style components, inside an open shadow root.
class FixtureLogin extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    queueMicrotask(() => {
      root.innerHTML = `
        <label style="font: 16px system-ui">Component password
          <input type="password" value="component-secret" data-role="password" style="font-size: 18px">
        </label>
        <button type="button" data-action="reveal">Show</button>`;
      const input = root.querySelector('[data-role="password"]');
      root.querySelector('[data-action="reveal"]').addEventListener("click", () => {
        input.type = input.type === "password" ? "text" : "password";
      });
    });
  }
}
customElements.define("fixture-login", FixtureLogin);
