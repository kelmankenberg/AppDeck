"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createUi(storage = new Map(), options = {}) {
  const timers = new Map();
  const animations = [];
  const previews = [];
  let nextTimer = 1;
  function element() {
    const classes = new Set();
    const item = {
      children: [],
      listeners: {},
      attributes: {},
      dataset: {},
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); },
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
      },
      style: {
        properties: {},
        setProperty(name, value) { this.properties[name] = value; },
        removeProperty(name) { delete this.properties[name]; }
      },
      getBoundingClientRect() {
        const index = this.parentElement?.children.indexOf(this) ?? -1;
        return { width: 278, height: 100, left: Math.max(index, 0) * 100, top: 0 };
      },
      append(child) { child.parentElement = this; this.children.push(child); },
      insertBefore(child, reference) {
        this.children.splice(this.children.indexOf(child), 1);
        const index = reference ? this.children.indexOf(reference) : this.children.length;
        this.children.splice(index, 0, child);
      },
      replaceChildren() { this.children = []; },
      addEventListener(event, callback) { this.listeners[event] = callback; },
      setAttribute(name, value) { this.attributes[name] = value; },
      querySelector() { return element(); },
      closest() { return this; },
      setPointerCapture() {},
      focus() {},
      cloneNode() { return element(); },
      remove() { this.removed = true; },
      animate(frames, timing) {
        animations.push({ frames, timing });
        return { cancel() {} };
      }
    };
    Object.defineProperty(item, "nextSibling", { get() {
      if (!this.parentElement) return null;
      return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] || null;
    } });
    return item;
  }
  const elements = new Map();
  const classes = new Set();
  const document = {
    fullscreenEnabled: true,
    fullscreenElement: null,
    documentElement: Object.assign(element(), { async requestFullscreen() {} }),
    async exitFullscreen() {},
    listeners: {},
    addEventListener(event, callback) { this.listeners[event] = callback; },
    body: { append(item) { previews.push(item); }, classList: { toggle(name, enabled) {
      if (enabled) classes.add(name);
      else classes.delete(name);
    } } },
    elementFromPoint() { return this.hit || null; },
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    createElement: element
  };
  const context = vm.createContext({
    document,
    navigator: options.navigator || {},
    URL: {
      createObjectURL() { return "blob:wallpaper-preview"; },
      revokeObjectURL() {}
    },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, value); },
      removeItem(key) { storage.delete(key); }
    },
    sessionStorage: options.sessionStorage || { getItem() { return null; }, removeItem() {} },
    fetch: options.fetch,
    window: {
      location: options.location || { hash: "", protocol: "https:" },
      history: { replaceState() {} },
      clearInterval() {},
      setInterval() { return 1; },
      setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
      innerHeight: 844,
      requestAnimationFrame() { return 1; },
      cancelAnimationFrame() {},
      scrollBy() {},
      matchMedia(query) {
        return { matches: query === "(display-mode: standalone)" ? Boolean(options.standalone) : Boolean(options.reducedMotion) };
      },
      listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
      getComputedStyle() { return { fontSize: "16px" }; }
    }
  });
  for (const file of ["appearance.js", "app.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "../web", file), "utf8");
    vm.runInContext(source, context);
  }
  return { context, elements, classes, animations, previews, runTimers() {
    for (const [id, callback] of Array.from(timers)) { timers.delete(id); callback(); }
  } };
}

test("desktop appearance stays opt-in, persists settings, and restores the default palette", async () => {
  const storage = new Map();
  const calls = [];
  let accent = "#eeeeee";
  const ui = createUi(storage, { fetch: async (url) => {
    calls.push(url);
    return { ok: true, async json() {
      return { colors: { background: "#ffffff", foreground: "#202020", accent } };
    } };
  } });
  vm.runInContext('token = "paired"; setConnected(true)', ui.context);
  await vm.runInContext("refreshDesktopAppearance()", ui.context);
  assert.deepEqual(calls, []);
  const toggle = ui.elements.get("#follow-desktop-theme");
  toggle.checked = true;
  toggle.listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  const properties = ui.context.document.documentElement.style.properties;
  assert.equal(properties["--page-bg"], "#ffffff");
  assert.equal(properties["--on-accent"], "#000000");
  assert.equal(properties["--color-scheme"], "light");
  accent = "#114488";
  await vm.runInContext("refreshDesktopAppearance()", ui.context);
  assert.equal(properties["--accent"], "#114488");
  assert.equal(createUi(storage).elements.get("#follow-desktop-theme").checked, true);
  toggle.checked = false;
  toggle.listeners.change();
  assert.equal(properties["--page-bg"], undefined);
  assert.equal(properties["--accent"], undefined);
});

test("wallpaper uses authenticated bounded previews, tracks revisions and revokes blob URLs", async () => {
  let revision = "a".repeat(64);
  const calls = [];
  const revoked = [];
  const ui = createUi(new Map(), { fetch: async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/wallpaper") return {
      ok: true, headers: { get() { return "image/jpeg"; } },
      async blob() { return { size: 100 }; }
    };
    return { ok: true, async json() { return { wallpaper: revision }; } };
  } });
  ui.context.URL.revokeObjectURL = (url) => revoked.push(url);
  vm.runInContext('token = "paired"; setConnected(true)', ui.context);
  const toggle = ui.elements.get("#use-desktop-wallpaper");
  toggle.checked = true;
  toggle.listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.classes.has("has-wallpaper"), true);
  assert.equal(calls.find(({ url }) => url === "/api/wallpaper").options.headers.Authorization, "Bearer paired");
  await vm.runInContext("refreshDesktopAppearance()", ui.context);
  assert.equal(calls.filter(({ url }) => url === "/api/wallpaper").length, 1);
  revision = "b".repeat(64);
  await vm.runInContext("refreshDesktopAppearance()", ui.context);
  assert.equal(calls.filter(({ url }) => url === "/api/wallpaper").length, 2);
  const dimming = ui.elements.get("#background-dimming");
  dimming.value = "80";
  dimming.listeners.input();
  assert.equal(ui.context.document.documentElement.style.properties["--wallpaper-dim"], "0.8");
  toggle.checked = false;
  toggle.listeners.change();
  assert.equal(ui.classes.has("has-wallpaper"), false);
  assert.equal(revoked.length, 2);
});

test("appearance rejects CSS-shaped colors and oversized wallpaper without blocking app controls", async () => {
  const ui = createUi(new Map(), { fetch: async (url) => {
    if (url === "/api/wallpaper") return {
      ok: true, headers: { get() { return "image/jpeg"; } },
      async blob() { return { size: 2 * 1024 * 1024 }; }
    };
    return { ok: true, async json() {
      return { colors: { background: "url(https://example.invalid)", foreground: "#ffffff", accent: "#ffffff" }, wallpaper: "a".repeat(64) };
    } };
  } });
  vm.runInContext('token = "paired"; setConnected(true); appearanceSettings = {theme:true,wallpaper:true,dimming:65}', ui.context);
  await vm.runInContext("refreshDesktopAppearance()", ui.context);
  assert.equal(ui.context.document.documentElement.style.properties["--page-bg"], undefined);
  assert.equal(ui.classes.has("has-wallpaper"), false);
  assert.match(ui.elements.get("#appearance-error").textContent, /invalid desktop theme colors/);
  assert.match(ui.elements.get("#appearance-error").textContent, /too large/);
  assert.equal(ui.elements.get("#apps-section").hidden, false);
});

test("appearance pauses while hidden and ignores pending wallpaper after disabling it", async () => {
  let finish;
  let calls = 0;
  const ui = createUi(new Map(), { fetch: async (url) => {
    calls++;
    if (url === "/api/wallpaper") return {
      ok: true, headers: { get() { return "image/jpeg"; } },
      blob() { return new Promise((resolve) => { finish = resolve; }); }
    };
    return { ok: true, async json() { return { wallpaper: "a".repeat(64) }; } };
  } });
  vm.runInContext('token = "paired"; setConnected(true); appearanceSettings.wallpaper = true', ui.context);
  ui.context.document.hidden = true;
  await vm.runInContext("refreshDesktopAppearance()", ui.context);
  assert.equal(calls, 0);
  ui.context.document.hidden = false;
  vm.runInContext("refreshDesktopAppearance()", ui.context);
  await new Promise((resolve) => setImmediate(resolve));
  ui.elements.get("#use-desktop-wallpaper").checked = false;
  ui.elements.get("#use-desktop-wallpaper").listeners.change();
  finish({ size: 100 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.classes.has("has-wallpaper"), false);
});

test("install prompt is offered only when available and handles cancellation", async () => {
  const ui = createUi();
  const button = ui.elements.get("#install-app");
  assert.equal(button.hidden, true);
  let prevented = false;
  let prompted = 0;
  ui.context.window.listeners.beforeinstallprompt({
    preventDefault() { prevented = true; },
    async prompt() { prompted++; },
    userChoice: Promise.resolve({ outcome: "dismissed" })
  });
  assert.equal(prevented, true);
  assert.equal(button.hidden, false);
  await button.listeners.click();
  assert.equal(prompted, 1);
  assert.equal(button.hidden, true);
  assert.equal(ui.elements.get("#install-status").textContent, "Installation canceled.");
  assert.equal(ui.elements.get("#install-help").hidden, false);
});

test("install button uses native API and handles installed and failed states", async () => {
  let calls = 0;
  const ui = createUi(new Map(), { navigator: { async install() { calls++; } } });
  const button = ui.elements.get("#install-app");
  assert.equal(button.hidden, false);
  await button.listeners.click();
  assert.equal(calls, 1);
  assert.equal(button.hidden, true);
  assert.match(ui.elements.get("#install-status").textContent, /installed or opened/);
  const failure = createUi(new Map(), { navigator: { async install() { throw new Error("failed"); } } });
  await failure.elements.get("#install-app").listeners.click();
  assert.match(failure.elements.get("#install-status").textContent, /could not start/);
  assert.equal(failure.elements.get("#install-app").hidden, false);
  const installed = createUi(new Map(), { standalone: true });
  assert.equal(installed.elements.get("#install-app").hidden, true);
  assert.equal(installed.elements.get("#install-help").hidden, true);
  assert.match(installed.elements.get("#install-status").textContent, /running as an installed app/);
});

test("workspace buttons track desktop changes and switch workspaces", async () => {
  let active = 1;
  const calls = [];
  const ui = createUi(new Map(), {
    fetch: async (url, options) => {
      calls.push(url);
      if (url === "/api/workspaces/2/focus") active = 2;
      return { ok: true, async json() {
        return url === "/api/workspaces"
          ? { active, workspaces: [1, 2, 3].map((id) => ({ id, label: id })) }
          : { ok: true };
      } };
    }
  });
  vm.runInContext('token = "paired"; setConnected(true)', ui.context);
  await vm.runInContext("loadWorkspaces()", ui.context);
  const [first, second] = ui.elements.get("#workspace-buttons").children;
  assert.equal(first.textContent, "1");
  assert.equal(first.attributes["aria-pressed"], "true");
  assert.equal(second.classList.contains("workspace-inactive"), true);
  await second.listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.attributes["aria-pressed"], "true");
  assert.equal(first.attributes["aria-pressed"], "false");
  active = 3;
  await vm.runInContext("loadWorkspaces()", ui.context);
  assert.equal(ui.elements.get("#workspace-buttons").children[2].attributes["aria-pressed"], "true");
  assert.ok(calls.includes("/api/workspaces/2/focus"));
});

test("workspace polling pauses when hidden and errors do not hide apps", async () => {
  let calls = 0;
  const ui = createUi(new Map(), {
    fetch: async () => {
      calls++;
      return { ok: false, async json() { return { error: "Hyprland unavailable" }; } };
    }
  });
  vm.runInContext('token = "paired"; setConnected(true)', ui.context);
  ui.context.document.hidden = true;
  await vm.runInContext("loadWorkspaces()", ui.context);
  assert.equal(calls, 0);
  ui.context.document.hidden = false;
  await vm.runInContext("loadWorkspaces()", ui.context);
  assert.match(ui.elements.get("#workspace-error").textContent, /Hyprland unavailable/);
  assert.equal(ui.elements.get("#apps-section").hidden, false);
  vm.runInContext("setConnected(false)", ui.context);
  await vm.runInContext("loadWorkspaces()", ui.context);
  assert.equal(calls, 1);
});

test("a workspace refresh in flight cannot overwrite a switch", async () => {
  let resolveFirst;
  let calls = 0;
  const ui = createUi(new Map(), {
    fetch: (url) => {
      if (url.endsWith("/focus")) return Promise.resolve({ ok: true, async json() { return {}; } });
      calls++;
      const active = calls === 1 ? 1 : 2;
      const response = { ok: true, async json() {
        return { active, workspaces: [{ id: 1, label: 1 }, { id: 2, label: 2 }] };
      } };
      if (calls === 1) return new Promise((resolve) => { resolveFirst = () => resolve(response); });
      return Promise.resolve(response);
    }
  });
  vm.runInContext('token = "paired"; setConnected(true); loadWorkspaces(); focusWorkspace(2)', ui.context);
  await new Promise((resolve) => setImmediate(resolve));
  resolveFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.elements.get("#workspace-buttons").children[1].attributes["aria-pressed"], "true");
  assert.equal(calls, 2);
});

const apps = [
  { name: "Alpha", selected: false, state: "stopped" },
  { name: "Bravo", selected: true, state: "stopped" },
  { name: "Charlie", selected: false, state: "stopped" },
  { name: "Zulu", selected: true, state: "stopped" }
];

function renderedNames(ui) {
  return ui.elements.get("#apps").children.map((card) =>
    card.children.find((child) => child.className === "app-details").children[0].textContent
  );
}

test("long-press dragging saves shared order without launching and ignores scroll gestures", async () => {
  let ordered = [
    { id: "one.desktop", name: "One", selected: true, state: "stopped" },
    { id: "two.desktop", name: "Two", selected: true, state: "stopped" }
  ];
  const calls = [];
  const ui = createUi(new Map(), {
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === "/api/order") {
        const ids = JSON.parse(options.body).order;
        ordered = ids.map((id) => ordered.find((app) => app.id === id));
      }
      return { ok: true, async json() { return url === "/api/apps" ? { apps: ordered, revision: 1 } : { ok: true }; } };
    }
  });
  await vm.runInContext("loadApps()", ui.context);
  let [first, second] = ui.elements.get("#apps").children;
  const touch = (x, y) => ({ identifier: 4, clientX: x, clientY: y });
  const event = (touches) => ({ touches, changedTouches: [touch(0, 0)], cancelable: true, preventDefault() {} });
  first.listeners.touchstart(event([touch(0, 0)]));
  first.listeners.touchmove(event([touch(0, 20)]));
  ui.runTimers();
  first.listeners.touchend(event([]));
  assert.equal(first.classList.contains("dragging"), false);
  assert.equal(calls.filter(({ url }) => url === "/api/order").length, 0);

  first.listeners.touchstart(event([touch(0, 0)]));
  ui.runTimers();
  assert.equal(first.classList.contains("dragging"), true);
  assert.equal(ui.previews.length, 1);
  assert.equal(ui.previews[0].attributes["aria-hidden"], "true");
  ui.context.document.hit = second;
  first.listeners.touchmove(event([touch(100, 0)]));
  assert.equal(ui.previews[0].style.left, "100px");
  assert.equal(ui.animations.length, 1);
  first.listeners.touchend(event([]));
  assert.equal(ui.previews[0].removed, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(renderedNames(ui), ["Two", "One"]);
  const saved = calls.find(({ url }) => url === "/api/order");
  assert.deepEqual(JSON.parse(saved.options.body), { order: ["two.desktop", "one.desktop"], revision: 1 });
  assert.equal(calls.some(({ url }) => url.endsWith("/launch")), false);
  await first.listeners.click({ preventDefault() {} });
  assert.equal(calls.some(({ url }) => url.endsWith("/launch")), false);
});

test("reduced motion disables card movement animations", () => {
  const ui = createUi(new Map(), { reducedMotion: true });
  ui.context.testApps = [
    { id: "one.desktop", name: "One", selected: true, state: "stopped" },
    { id: "two.desktop", name: "Two", selected: true, state: "stopped" }
  ];
  vm.runInContext("appRevision = 0; renderApps(testApps)", ui.context);
  const [first, second] = ui.elements.get("#apps").children;
  const point = { identifier: 1, clientX: 0, clientY: 0 };
  first.listeners.touchstart({ touches: [point] });
  ui.runTimers();
  ui.context.document.hit = second;
  first.listeners.touchmove({ touches: [point], cancelable: true, preventDefault() {} });
  assert.equal(ui.animations.length, 0);
  first.listeners.touchcancel({ cancelable: true, preventDefault() {} });
  assert.equal(ui.previews[0].removed, true);
});

test("a cancelled drag restores the order without saving", async () => {
  const ui = createUi();
  ui.context.testApps = [
    { id: "one.desktop", name: "One", selected: true, state: "stopped" },
    { id: "two.desktop", name: "Two", selected: true, state: "stopped" }
  ];
  vm.runInContext("appRevision = 0; renderApps(testApps)", ui.context);
  const [first, second] = ui.elements.get("#apps").children;
  const point = { identifier: 1, clientX: 0, clientY: 0 };
  first.listeners.touchstart({ touches: [point] });
  ui.runTimers();
  ui.context.document.hit = second;
  first.listeners.touchmove({ touches: [point], cancelable: true, preventDefault() {} });
  first.listeners.touchcancel({ cancelable: true, preventDefault() {} });
  assert.deepEqual(renderedNames(ui), ["One", "Two"]);
  assert.equal(ui.elements.get("#order-status").textContent, "Move cancelled.");
});

test("a heartbeat refreshes changes made from another phone", async () => {
  let revision = 0;
  let apps = [
    { id: "one.desktop", name: "One", selected: true, state: "stopped" },
    { id: "two.desktop", name: "Two", selected: true, state: "stopped" }
  ];
  const ui = createUi(new Map(), {
    fetch: async (url) => ({
      ok: true,
      async json() { return url === "/api/apps" ? { apps, revision } : { ok: true, revision }; }
    })
  });
  vm.runInContext('token = "paired"', ui.context);
  await vm.runInContext("loadApps()", ui.context);
  apps = [apps[1], apps[0]];
  revision++;
  await vm.runInContext("sendHeartbeat()", ui.context);
  assert.deepEqual(renderedNames(ui), ["Two", "One"]);
});

test("keyboard reordering reports a conflict and restores the server order", async () => {
  const apps = [
    { id: "one.desktop", name: "One", selected: true, state: "stopped" },
    { id: "two.desktop", name: "Two", selected: true, state: "stopped" }
  ];
  const ui = createUi(new Map(), {
    fetch: async (url) => ({
      ok: url !== "/api/order",
      async json() {
        return url === "/api/order" ? { error: "App selection or order changed. Refresh and try again." }
          : { apps, revision: 1 };
      }
    })
  });
  await vm.runInContext("loadApps()", ui.context);
  const first = ui.elements.get("#apps").children[0];
  first.listeners.keydown({ altKey: true, key: "ArrowRight", preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(renderedNames(ui), ["One", "Two"]);
  assert.match(ui.elements.get("#app-error").textContent, /order changed/);
  assert.equal(ui.elements.get("#order-status").textContent, "Card order was not saved.");
});

test("a temporary disconnect recovers the app list without re-pairing", async () => {
  let online = false;
  const ui = createUi(new Map(), {
    fetch: async (url) => {
      if (!online) throw new Error("Network unavailable");
      return {
        ok: true,
        async json() { return url === "/api/apps" ? { apps } : { ok: true }; }
      };
    }
  });
  vm.runInContext('token = "existing-token"; setConnected(true)', ui.context);
  await vm.runInContext("sendHeartbeat()", ui.context);
  assert.equal(ui.elements.get("#app-error").textContent, "Network unavailable");
  online = true;
  await vm.runInContext("sendHeartbeat()", ui.context);
  assert.equal(ui.elements.get("#app-error").textContent, "");
  assert.deepEqual(renderedNames(ui), ["Bravo", "Zulu"]);
  assert.equal(ui.elements.get("#pairing").hidden, true);
});

test("configuration shows added apps first and preserves alphabetical order within each group", () => {
  const ui = createUi();
  ui.context.testApps = apps;
  vm.runInContext("configuring = true; renderApps(testApps)", ui.context);
  assert.deepEqual(renderedNames(ui), ["Bravo", "Zulu", "Alpha", "Charlie"]);
});

test("configuration search filters names and keeps added apps first", () => {
  const ui = createUi();
  ui.context.testApps = [
    { name: "Alpha", selected: false, state: "stopped" },
    { name: "Alpine", selected: true, state: "stopped" },
    { name: "Bravo", selected: true, state: "stopped" }
  ];
  vm.runInContext("configuring = true; renderApps(testApps)", ui.context);
  const search = ui.elements.get("#app-search");
  search.value = " AL ";
  search.listeners.input();
  assert.deepEqual(renderedNames(ui), ["Alpine", "Alpha"]);
  search.value = "missing";
  search.listeners.input();
  assert.equal(ui.elements.get("#apps").children[0].textContent, "No apps match your search.");
  search.value = "";
  search.listeners.input();
  assert.deepEqual(renderedNames(ui), ["Alpine", "Bravo", "Alpha"]);
});

test("search is retained when the app list refreshes after adding an app", async () => {
  const ui = createUi();
  const catalog = [
    { id: "alpha.desktop", name: "Alpha", selected: false, state: "stopped" },
    { id: "bravo.desktop", name: "Bravo", selected: true, state: "stopped" }
  ];
  ui.context.fetch = async (url) => {
    if (url.includes("/favorite")) catalog[0].selected = true;
    return { ok: true, async json() { return url === "/api/apps" ? { apps: catalog } : { ok: true }; } };
  };
  ui.elements.get("#app-search").value = "alp";
  vm.runInContext("configuring = true", ui.context);
  await vm.runInContext("loadApps()", ui.context);
  await vm.runInContext('updateFavorite("alpha.desktop", true)', ui.context);
  assert.equal(ui.elements.get("#app-search").value, "alp");
  assert.deepEqual(renderedNames(ui), ["Alpha"]);
  assert.equal(ui.elements.get("#apps").children[0].children[1].textContent, "Added");
});

test("the launch deck still shows only added apps", () => {
  const ui = createUi();
  ui.context.testApps = apps;
  vm.runInContext("renderApps(testApps)", ui.context);
  assert.deepEqual(renderedNames(ui), ["Bravo", "Zulu"]);
});

test("launch deck cards display icons and send the appropriate action when tapped", async () => {
  const ui = createUi();
  const calls = [];
  ui.context.testApps = [
    { id: "sample.desktop", name: "Sample", selected: true, state: "running", icon: "data:image/png;base64,abc" }
  ];
  ui.context.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, async json() { return url === "/api/apps" ? { apps: [] } : { ok: true }; } };
  };
  vm.runInContext("renderApps(testApps)", ui.context);
  const card = ui.elements.get("#apps").children[0];
  assert.equal(card.type, "button");
  assert.equal(card.className, "deck-card running");
  assert.equal(card.children.length, 2);
  assert.equal(card.children[1].children[1].textContent, "Running");
  assert.equal(card.children[0].children[1].src, "data:image/png;base64,abc");
  await card.listeners.click();
  assert.equal(calls[0].url, "/api/apps/sample.desktop/stop");
});

test("stop confirmation cancels without a request and confirms the named app", async () => {
  const storage = new Map();
  const ui = createUi(storage);
  const toggle = ui.elements.get("#confirm-stop");
  assert.equal(toggle.checked, false);
  toggle.checked = true;
  toggle.listeners.change();
  assert.equal(storage.get("appdeck-confirm-stop"), "true");
  assert.equal(createUi(storage).elements.get("#confirm-stop").checked, true);
  const calls = [];
  ui.context.testApps = [{ id: "sample.desktop", name: "<Sample>", selected: true, state: "running" }];
  ui.context.fetch = async (url) => {
    calls.push(url);
    return { ok: true, async json() { return url === "/api/apps" ? { apps: [] } : {}; } };
  };
  const prompts = [];
  ui.context.window.confirm = (message) => { prompts.push(message); return false; };
  vm.runInContext("renderApps(testApps)", ui.context);
  const card = ui.elements.get("#apps").children[0];
  await card.listeners.click();
  assert.deepEqual(calls, []);
  assert.equal(card.disabled, undefined);
  assert.equal(prompts[0], "Stop <Sample>? Unsaved work may be lost.");
  ui.context.window.confirm = () => true;
  await card.listeners.click();
  assert.equal(calls[0], "/api/apps/sample.desktop/stop");
  toggle.checked = false;
  toggle.listeners.change();
  assert.equal(createUi(storage).elements.get("#confirm-stop").checked, false);
});

test("stop confirmation reports a preference storage failure", () => {
  const ui = createUi();
  ui.context.localStorage.setItem = () => { throw new Error("Storage unavailable"); };
  ui.elements.get("#confirm-stop").checked = true;
  ui.elements.get("#confirm-stop").listeners.change();
  assert.equal(ui.elements.get("#preference-error").hidden, false);
  assert.match(ui.elements.get("#preference-error").textContent, /could not be saved/);
});

test("ready cards launch without confirmation even when stop confirmation is enabled", async () => {
  const ui = createUi();
  vm.runInContext("confirmStop = true", ui.context);
  ui.context.window.confirm = () => { throw new Error("Launch must not prompt"); };
  const calls = [];
  ui.context.testApps = [
    { id: "sample.desktop", name: "Sample", selected: true, state: "stopped" }
  ];
  ui.context.fetch = async (url) => {
    calls.push(url);
    return { ok: true, async json() { return url === "/api/apps" ? { apps: [] } : { ok: true }; } };
  };
  vm.runInContext("renderApps(testApps)", ui.context);
  const card = ui.elements.get("#apps").children[0];
  assert.equal(card.className, "deck-card ready");
  assert.equal(card.children.length, 2);
  assert.equal(card.children[1].children.length, 1);
  assert.equal(card.children[1].children[0].textContent, "Sample");
  await card.listeners.click();
  assert.equal(calls[0], "/api/apps/sample.desktop/launch");
});

test("deck mode persists, restores controls and leaves pairing visible", async () => {
  const storage = new Map();
  const ui = createUi(storage);
  vm.runInContext("setConnected(true)", ui.context);
  const toggle = ui.elements.get("#deck-mode-toggle");
  await toggle.listeners.click();
  assert.equal(toggle.attributes["aria-label"], "Show controls");
  assert.equal(ui.elements.get("#deck-enter-icon").hidden, true);
  assert.equal(ui.elements.get("#deck-exit-icon").hidden, false);
  assert.equal(toggle.attributes["aria-pressed"], "true");
  assert.equal(ui.classes.has("deck-mode"), true);
  assert.equal(storage.get("appdeck-deck-mode"), "true");

  const reloaded = createUi(storage);
  assert.equal(reloaded.classes.has("deck-mode"), false);
  assert.equal(reloaded.elements.get("#pairing").hidden, false);
  vm.runInContext("setConnected(true)", reloaded.context);
  assert.equal(reloaded.classes.has("deck-mode"), true);
  await reloaded.elements.get("#deck-mode-toggle").listeners.click();
  assert.equal(reloaded.classes.has("deck-mode"), false);
  assert.equal(reloaded.elements.get("#deck-mode-toggle").attributes["aria-label"], "Enter Deck mode");
  assert.equal(storage.get("appdeck-deck-mode"), "false");
});

test("configuration changes the gear to a done control", () => {
  const ui = createUi();
  ui.context.fetch = async () => ({ ok: true, async json() { return { apps: [] }; } });
  vm.runInContext("setConnected(true)", ui.context);
  const configure = ui.elements.get("#configure-toggle");
  configure.listeners.click();
  assert.equal(configure.attributes["aria-label"], "Done configuring apps");
  assert.equal(ui.elements.get("#configure-icon").hidden, true);
  assert.equal(ui.elements.get("#configure-done-icon").hidden, false);
  assert.equal(ui.elements.get("#deck-mode-toggle").hidden, true);
  assert.equal(ui.elements.get("#settings").hidden, false);
  assert.equal(ui.elements.get("#app-list-title").hidden, false);
  assert.equal(ui.elements.get("#app-search-group").hidden, false);
  ui.elements.get("#app-search").value = "temporary";
  configure.listeners.click();
  assert.equal(configure.attributes["aria-label"], "Configure apps");
  assert.equal(ui.elements.get("#configure-icon").hidden, false);
  assert.equal(ui.elements.get("#deck-mode-toggle").hidden, false);
  assert.equal(ui.elements.get("#settings").hidden, true);
  assert.equal(ui.elements.get("#app-search-group").hidden, true);
  assert.equal(ui.elements.get("#app-search").value, "");
});

test("card size applies immediately and persists in the browser", () => {
  const storage = new Map();
  const ui = createUi(storage);
  const selector = ui.elements.get("#card-size");
  assert.equal(selector.value, "default");
  for (const size of ["large", "larger", "largest", "default"]) {
    selector.value = size;
    selector.listeners.change();
    assert.equal(ui.elements.get("#apps").dataset.cardSize, size);
    assert.equal(storage.get("appdeck-card-size"), size);
  }
  const widths = [];
  for (const size of ["large", "larger", "largest"]) {
    selector.value = size;
    selector.listeners.change();
    widths.push(parseFloat(ui.elements.get("#apps").style.properties["--card-width"]));
  }
  assert.ok(widths[0] > (278 - 9.6) / 2);
  assert.ok(widths[1] > widths[0] && widths[2] > widths[1]);
  selector.value = "larger";
  selector.listeners.change();
  const reloaded = createUi(storage);
  assert.equal(reloaded.elements.get("#card-size").value, "larger");
  assert.equal(reloaded.elements.get("#apps").dataset.cardSize, "larger");
});

test("invalid saved card sizes fall back to the default", () => {
  const ui = createUi(new Map([["appdeck-card-size", "invalid"]]));
  assert.equal(ui.elements.get("#card-size").value, "default");
  assert.equal(ui.elements.get("#apps").dataset.cardSize, "default");
});

test("full-width setting updates the page and persists across reloads", () => {
  const storage = new Map();
  const ui = createUi(storage);
  const toggle = ui.elements.get("#full-width");
  assert.equal(toggle.checked, false);
  assert.equal(ui.classes.has("full-width"), false);
  toggle.checked = true;
  toggle.listeners.change();
  assert.equal(ui.classes.has("full-width"), true);
  assert.equal(storage.get("appdeck-full-width"), "true");
  const reloaded = createUi(storage);
  assert.equal(reloaded.elements.get("#full-width").checked, true);
  assert.equal(reloaded.classes.has("full-width"), true);
  reloaded.elements.get("#full-width").checked = false;
  reloaded.elements.get("#full-width").listeners.change();
  assert.equal(reloaded.classes.has("full-width"), false);
  assert.equal(storage.get("appdeck-full-width"), "false");
});

test("horizontal card centering preserves card sizing and persists across reloads", () => {
  const storage = new Map();
  const ui = createUi(storage);
  const toggle = ui.elements.get("#center-cards");
  assert.equal(toggle.checked, false);
  toggle.checked = true;
  toggle.listeners.change();
  assert.equal(ui.classes.has("center-cards"), true);
  const cardWidth = parseFloat(ui.elements.get("#apps").style.properties["--card-width"]);
  assert.equal(cardWidth, (278 - 9.6) / 2);
  const reloaded = createUi(storage);
  assert.equal(reloaded.elements.get("#center-cards").checked, true);
  assert.equal(reloaded.classes.has("center-cards"), true);
  const size = ui.elements.get("#card-size");
  size.value = "larger";
  size.listeners.change();
  assert.equal(parseFloat(ui.elements.get("#apps").style.properties["--card-width"]), cardWidth * 1.4);
  toggle.checked = false;
  toggle.listeners.change();
  assert.equal(ui.classes.has("center-cards"), false);
  assert.equal(parseFloat(ui.elements.get("#apps").style.properties["--card-width"]), cardWidth * 1.4);
  size.value = "default";
  size.listeners.change();
  assert.equal(ui.elements.get("#apps").style.properties["--card-width"], undefined);
  assert.equal(storage.get("appdeck-center-cards"), "false");
});

test("horizontal card centering reports a preference storage failure", () => {
  const ui = createUi();
  ui.context.localStorage.setItem = () => { throw new Error("Storage unavailable"); };
  ui.elements.get("#center-cards").checked = true;
  ui.elements.get("#center-cards").listeners.change();
  assert.equal(ui.elements.get("#preference-error").hidden, false);
  assert.match(ui.elements.get("#preference-error").textContent, /centering preference could not be saved/);
});

test("an expired session shows pairing errors even when deck mode is enabled", async () => {
  const ui = createUi(new Map([["appdeck-deck-mode", "true"]]));
  ui.context.window.clearInterval = () => {};
  ui.context.fetch = async () => ({
    ok: false,
    async json() { return { error: "Pairing code required" }; }
  });
  vm.runInContext('token = "expired"; setConnected(true)', ui.context);
  await vm.runInContext("loadApps()", ui.context);
  assert.equal(ui.classes.has("deck-mode"), false);
  assert.equal(ui.elements.get("#pairing").hidden, false);
  assert.equal(ui.elements.get("#pairing-error").textContent, "Pairing code required");
});

test("deck mode button enters and exits fullscreen, including browser-initiated exit", async () => {
  const ui = createUi();
  const document = ui.context.document;
  document.documentElement.requestFullscreen = async () => {
    document.fullscreenElement = document.documentElement;
    document.listeners.fullscreenchange();
  };
  document.exitFullscreen = async () => {
    document.fullscreenElement = null;
    document.listeners.fullscreenchange();
  };
  vm.runInContext("setConnected(true)", ui.context);
  const button = ui.elements.get("#deck-mode-toggle");
  await button.listeners.click();
  assert.equal(document.fullscreenElement, document.documentElement);
  assert.equal(ui.classes.has("deck-mode"), true);
  assert.equal(button.attributes["aria-label"], "Show controls");
  assert.equal(button.attributes["aria-pressed"], "true");
  await button.listeners.click();
  assert.equal(document.fullscreenElement, null);
  assert.equal(ui.classes.has("deck-mode"), false);
  assert.equal(button.attributes["aria-label"], "Enter Deck mode");
  await button.listeners.click();
  document.fullscreenElement = null;
  document.listeners.fullscreenchange();
  assert.equal(ui.classes.has("deck-mode"), false);
  assert.equal(button.attributes["aria-pressed"], "false");
});

test("fullscreen denial leaves deck mode usable and reports the failure", async () => {
  const ui = createUi();
  const document = ui.context.document;
  vm.runInContext("setConnected(true)", ui.context);
  document.documentElement.requestFullscreen = async () => { throw new Error("Denied"); };
  const button = ui.elements.get("#deck-mode-toggle");
  await button.listeners.click();
  assert.equal(ui.classes.has("deck-mode"), true);
  assert.equal(ui.elements.get("#app-error").textContent, "Fullscreen is unavailable; Deck mode is still active.");
  await button.listeners.click();
  document.fullscreenEnabled = false;
  await button.listeners.click();
  assert.equal(ui.classes.has("deck-mode"), true);
  assert.equal(ui.elements.get("#app-error").textContent, "Fullscreen is unavailable; Deck mode is still active.");
});

test("manual pairing exchanges the short code for the bearer token", async () => {
  const storage = new Map();
  const ui = createUi(storage);
  const requests = [];
  ui.elements.get("#pairing-code").value = "0012-3456";
  ui.elements.get("#device-name").value = "My Android";
  ui.context.sessionStorage.setItem = () => {};
  ui.context.window.clearInterval = () => {};
  ui.context.window.setInterval = () => 1;
  ui.context.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      async json() {
        return url === "/api/pair" ? { token: "long-token" } : { apps: [] };
      }
    };
  };
  await vm.runInContext("connect()", ui.context);
  assert.equal(requests[0].url, "/api/pair");
  assert.deepEqual(JSON.parse(requests[0].options.body), { code: "0012-3456", name: "My Android" });
  assert.equal(requests[1].options.headers.Authorization, "Bearer long-token");
  assert.equal(ui.elements.get("#pairing-code").value, "");
  assert.equal(storage.get("appdeck-token"), "long-token");
});

test("saved per-device pairing restores on a new session and clears on revocation", async () => {
  const storage = new Map([["appdeck-token", "device-token"]]);
  const ui = createUi(storage, {
    fetch: async () => ({ ok: false, async json() { return { error: "Pairing code required" }; } })
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.elements.get("#pairing").hidden, false);
  assert.equal(storage.has("appdeck-token"), false);
});

test("insecure HTTP does not transmit a stored token or pairing fragment", () => {
  const calls = [];
  const removed = [];
  const ui = createUi(new Map(), {
    location: { protocol: "http:", hash: "#new-token" },
    sessionStorage: { getItem() { return "old-token"; }, removeItem(key) { removed.push(key); } },
    fetch: (...args) => { calls.push(args); }
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(removed, ["appdeck-token"]);
  assert.match(ui.elements.get("#pairing-error").textContent, /HTTPS/);
});

test("new pairing fragment takes precedence over a previously stored token", async () => {
  const calls = [];
  const sessionStorage = {
    getItem() { return "old-token"; },
    removeItem() {},
    setItem() {}
  };
  createUi(new Map(), {
    location: { protocol: "https:", hash: "#new-token", pathname: "/" },
    sessionStorage,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, async json() { return url === "/api/pair" ? { token: "new-device-token" } : { apps: [] }; } };
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.length > 0);
  const pair = calls.find(({ url }) => url === "/api/pair");
  assert.deepEqual(JSON.parse(pair.options.body), { secret: "new-token", name: "Phone" });
  assert.ok(calls.filter(({ url }) => url !== "/api/pair")
    .every(({ options }) => options.headers.Authorization === "Bearer new-device-token"));
});
