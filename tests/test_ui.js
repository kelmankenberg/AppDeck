"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createUi(storage = new Map(), options = {}) {
  function element() {
    return {
      children: [],
      listeners: {},
      attributes: {},
      dataset: {},
      style: {
        properties: {},
        setProperty(name, value) { this.properties[name] = value; },
        removeProperty(name) { delete this.properties[name]; }
      },
      getBoundingClientRect() { return { width: 278 }; },
      append(child) { this.children.push(child); },
      replaceChildren() { this.children = []; },
      addEventListener(event, callback) { this.listeners[event] = callback; },
      setAttribute(name, value) { this.attributes[name] = value; },
      querySelector() { return element(); }
    };
  }
  const elements = new Map();
  const classes = new Set();
  const document = {
    fullscreenEnabled: true,
    fullscreenElement: null,
    documentElement: { async requestFullscreen() {} },
    async exitFullscreen() {},
    listeners: {},
    addEventListener(event, callback) { this.listeners[event] = callback; },
    body: { classList: { toggle(name, enabled) {
      if (enabled) classes.add(name);
      else classes.delete(name);
    } } },
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    createElement: element
  };
  const context = vm.createContext({
    document,
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, value); }
    },
    sessionStorage: options.sessionStorage || { getItem() { return null; }, removeItem() {} },
    fetch: options.fetch,
    window: {
      location: options.location || { hash: "", protocol: "https:" },
      history: { replaceState() {} },
      clearInterval() {},
      setInterval() { return 1; },
      addEventListener() {},
      getComputedStyle() { return { fontSize: "16px" }; }
    }
  });
  const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
  vm.runInContext(source, context);
  return { context, elements, classes };
}

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

test("ready cards have ready styling and launch when tapped", async () => {
  const ui = createUi();
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
  const ui = createUi();
  const requests = [];
  ui.elements.get("#pairing-code").value = "0012-3456";
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
  assert.deepEqual(JSON.parse(requests[0].options.body), { code: "0012-3456" });
  assert.equal(requests[1].options.headers.Authorization, "Bearer long-token");
  assert.equal(ui.elements.get("#pairing-code").value, "");
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
      return { ok: true, async json() { return { apps: [] }; } };
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.length > 0);
  assert.ok(calls.every(({ options }) => options.headers.Authorization === "Bearer new-token"));
});
