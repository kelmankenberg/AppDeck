"use strict";

const pairing = document.querySelector("#pairing");
const pairingForm = document.querySelector("#pairing-form");
const pairingCode = document.querySelector("#pairing-code");
const pairingError = document.querySelector("#pairing-error");
const appsSection = document.querySelector("#apps-section");
const appsContainer = document.querySelector("#apps");
const appsTitle = document.querySelector("#apps-title");
const appsSubtitle = document.querySelector("#apps-subtitle");
const appError = document.querySelector("#app-error");
const configureButton = document.querySelector("#configure-toggle");
const configureIcon = document.querySelector("#configure-icon");
const configureDoneIcon = document.querySelector("#configure-done-icon");
const refreshButton = document.querySelector("#refresh");
const deckModeButton = document.querySelector("#deck-mode-toggle");
const deckEnterIcon = document.querySelector("#deck-enter-icon");
const deckExitIcon = document.querySelector("#deck-exit-icon");
const preferenceError = document.querySelector("#preference-error");
const settings = document.querySelector("#settings");
const cardSizeSelect = document.querySelector("#card-size");
const fullWidthToggle = document.querySelector("#full-width");
const appListTitle = document.querySelector("#app-list-title");
const appSearchGroup = document.querySelector("#app-search-group");
const appSearch = document.querySelector("#app-search");

let token = "";
let configuring = false;
let heartbeatTimer = 0;
let deckMode = false;
let deckFullscreenActive = false;
let cardSize = "default";
let fullWidth = false;
let latestApps = [];
const cardSizes = ["default", "large", "larger", "largest"];
const cardScales = { large: 1.2, larger: 1.4, largest: 1.6 };

try {
  deckMode = localStorage.getItem("appdeck-deck-mode") === "true";
  const savedSize = localStorage.getItem("appdeck-card-size");
  if (cardSizes.includes(savedSize)) cardSize = savedSize;
  fullWidth = localStorage.getItem("appdeck-full-width") === "true";
} catch (error) {
  preferenceError.textContent = "Browser preferences could not be loaded.";
  preferenceError.hidden = false;
}
cardSizeSelect.value = cardSize;
fullWidthToggle.checked = fullWidth;
document.body.classList.toggle("full-width", fullWidth);
appsContainer.dataset.cardSize = cardSize;

function applyCardSize() {
  appsContainer.dataset.cardSize = cardSize;
  if (cardSize === "default") {
    appsContainer.style.removeProperty("--card-width");
    return;
  }
  const width = appsContainer.getBoundingClientRect().width;
  if (width <= 0) return;
  const gap = 0.6 * parseFloat(window.getComputedStyle(document.documentElement).fontSize);
  const columns = Math.max(1, Math.floor((width + gap) / (88 + gap)));
  const defaultWidth = (width - gap * (columns - 1)) / columns;
  appsContainer.style.setProperty("--card-width", `${Math.min(width, defaultWidth * cardScales[cardSize])}px`);
}

function updateDeckMode() {
  document.body.classList.toggle("deck-mode", deckMode && !appsSection.hidden);
  const label = deckMode ? "Show controls" : "Enter Deck mode";
  deckModeButton.setAttribute("aria-label", label);
  deckModeButton.title = label;
  deckModeButton.setAttribute("aria-pressed", String(deckMode));
  deckEnterIcon.hidden = deckMode;
  deckExitIcon.hidden = !deckMode;
  deckModeButton.hidden = configuring;
}

function setDeckMode(enabled) {
  deckMode = enabled;
  updateDeckMode();
  try {
    localStorage.setItem("appdeck-deck-mode", String(deckMode));
    preferenceError.hidden = true;
  } catch (error) {
    preferenceError.textContent = "Deck mode preference could not be saved.";
    preferenceError.hidden = false;
  }
}

function setConnected(value) {
  pairing.hidden = value;
  appsSection.hidden = !value;
  configureButton.hidden = !value;
  updateDeckMode();
  if (value) applyCardSize();
}

function showPairingCodeFromUrl() {
  const fragment = window.location.hash.slice(1);
  if (!fragment) return;
  token = fragment;
  window.history.replaceState(null, "", window.location.pathname);
  connect();
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    },
    cache: "no-store"
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    throw new Error("The PC returned an unreadable response.");
  }
  if (!response.ok) throw new Error(payload.error || "Request failed.");
  return payload;
}

function addText(parent, tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  parent.append(element);
  return element;
}

function renderApps(apps) {
  latestApps = apps;
  appsContainer.replaceChildren();
  appsContainer.className = configuring ? "apps" : "apps deck";
  const query = configuring ? (appSearch.value || "").trim().toLocaleLowerCase() : "";
  const matches = query
    ? apps.filter((app) => app.name.toLocaleLowerCase().includes(query))
    : apps;
  const selectedApps = matches.filter((app) => app.selected);
  const visibleApps = configuring
    ? selectedApps.concat(matches.filter((app) => !app.selected))
    : selectedApps;
  if (visibleApps.length === 0) {
    addText(
      appsContainer,
      "p",
      "empty",
      configuring
        ? query && apps.length > 0 ? "No apps match your search." : "No launchable desktop apps were found."
        : "Choose apps in Configure to add them here."
    );
    return;
  }

  for (const app of visibleApps) {
    const card = document.createElement(configuring ? "article" : "button");
    card.className = configuring ? "app-card" : `deck-card ${app.state === "running" ? "running" : "ready"}`;

    if (!configuring) {
      card.type = "button";
      card.setAttribute("aria-label", `${app.state === "running" ? "Stop" : "Launch"} ${app.name}`);
      const artwork = document.createElement("span");
      artwork.className = "deck-artwork";
      const fallback = addText(artwork, "span", "deck-fallback", app.name.trim().charAt(0).toUpperCase() || "?");
      if (app.icon) {
        const image = document.createElement("img");
        image.className = "deck-icon";
        image.alt = "";
        image.addEventListener("load", () => { fallback.hidden = true; });
        image.addEventListener("error", () => { image.hidden = true; });
        image.src = app.icon;
        artwork.append(image);
      }
      card.append(artwork);
    }

    const details = document.createElement(configuring ? "div" : "span");
    details.className = "app-details";
    addText(details, configuring ? "h3" : "span", configuring ? "" : "deck-name", app.name);
    if (configuring || app.state === "running")
      addText(details, configuring ? "p" : "span", "app-state", app.state === "running" ? "Running" : "Ready");
    card.append(details);

    if (configuring) {
      const favorite = document.createElement("button");
      favorite.type = "button";
      favorite.className = app.selected ? "selected" : "quiet";
      favorite.textContent = app.selected ? "Added" : "Add";
      favorite.setAttribute("aria-pressed", String(app.selected));
      favorite.addEventListener("click", () => updateFavorite(app.id, !app.selected));
      card.append(favorite);
    } else {
      card.addEventListener("click", async () => {
        card.disabled = true;
        await appAction(app.id, app.state === "running" ? "stop" : "launch");
        card.disabled = false;
      });
    }
    appsContainer.append(card);
  }
}

async function loadApps() {
  appError.textContent = "";
  try {
    const data = await request("/api/apps");
    renderApps(data.apps);
    appError.textContent = data.iconError || "";
  } catch (error) {
    appError.textContent = error.message;
    if (error.message.includes("Pairing code")) {
      token = "";
      sessionStorage.removeItem("appdeck-token");
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = 0;
      pairingError.textContent = error.message;
      setConnected(false);
    }
  }
}

async function sendHeartbeat() {
  if (!token) return;
  try {
    await request("/api/ping", { method: "POST" });
  } catch (error) {
    appError.textContent = error.message;
    if (error.message.includes("Pairing code")) {
      token = "";
      sessionStorage.removeItem("appdeck-token");
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = 0;
      pairingError.textContent = error.message;
      setConnected(false);
    }
  }
}

function startHeartbeat() {
  window.clearInterval(heartbeatTimer);
  sendHeartbeat();
  heartbeatTimer = window.setInterval(sendHeartbeat, 10000);
}

async function connect() {
  pairingError.textContent = "";
  try {
    if (!token) {
      const code = pairingCode.value.trim();
      if (!/^[0-9]{4}-?[0-9]{4}$/.test(code))
        throw new Error("Enter the eight-digit pairing code from the PC.");
      const result = await request("/api/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code })
      });
      token = result.token;
    }
    await request("/api/apps");
    sessionStorage.setItem("appdeck-token", token);
    pairingCode.value = "";
    setConnected(true);
    await loadApps();
    startHeartbeat();
  } catch (error) {
    token = "";
    pairingError.textContent = error.message;
    setConnected(false);
  }
}

async function updateFavorite(id, enabled) {
  try {
    await request(`/api/apps/${encodeURIComponent(id)}/favorite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled })
    });
    await loadApps();
  } catch (error) {
    appError.textContent = error.message;
  }
}

async function appAction(id, action) {
  appError.textContent = "";
  try {
    await request(`/api/apps/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    await loadApps();
  } catch (error) {
    appError.textContent = error.message;
  }
}

pairingForm.addEventListener("submit", (event) => {
  event.preventDefault();
  token = "";
  connect();
});

configureButton.addEventListener("click", () => {
  configuring = !configuring;
  settings.hidden = !configuring;
  appListTitle.hidden = !configuring;
  appSearchGroup.hidden = !configuring;
  if (!configuring) appSearch.value = "";
  updateDeckMode();
  const label = configuring ? "Done configuring apps" : "Configure apps";
  configureButton.setAttribute("aria-label", label);
  configureButton.title = label;
  configureIcon.hidden = configuring;
  configureDoneIcon.hidden = !configuring;
  appsTitle.textContent = configuring ? "Configuration" : "Your apps";
  appsSubtitle.textContent = configuring
    ? "Added apps appear first. Choose apps for your launch deck."
    : "Tap an app to launch or stop it.";
  loadApps();
});

deckModeButton.addEventListener("click", async () => {
  const entering = !deckMode;
  appError.textContent = "";
  setDeckMode(entering);
  deckModeButton.disabled = true;
  try {
    if (entering && !document.fullscreenElement) {
      if (!document.fullscreenEnabled || typeof document.documentElement.requestFullscreen !== "function")
        throw new Error("Fullscreen unavailable");
      await document.documentElement.requestFullscreen();
      deckFullscreenActive = Boolean(document.fullscreenElement);
    } else if (entering) {
      deckFullscreenActive = true;
    } else if (!entering && document.fullscreenElement) {
      await document.exitFullscreen();
    }
  } catch (error) {
    appError.textContent = entering
      ? "Fullscreen is unavailable; Deck mode is still active."
      : "The browser could not exit fullscreen.";
  } finally {
    deckModeButton.disabled = false;
  }
});

refreshButton.addEventListener("click", loadApps);
appSearch.addEventListener("input", () => renderApps(latestApps));

document.addEventListener("fullscreenchange", () => {
  if (document.fullscreenElement) {
    if (deckMode) deckFullscreenActive = true;
  } else if (deckFullscreenActive) {
    deckFullscreenActive = false;
    if (deckMode) setDeckMode(false);
  }
});

cardSizeSelect.addEventListener("change", () => {
  if (!cardSizes.includes(cardSizeSelect.value)) {
    cardSizeSelect.value = cardSize;
    preferenceError.textContent = "Invalid card size.";
    preferenceError.hidden = false;
    return;
  }
  cardSize = cardSizeSelect.value;
  applyCardSize();
  try {
    localStorage.setItem("appdeck-card-size", cardSize);
    preferenceError.hidden = true;
  } catch (error) {
    preferenceError.textContent = "Card size preference could not be saved.";
    preferenceError.hidden = false;
  }
});

fullWidthToggle.addEventListener("change", () => {
  fullWidth = fullWidthToggle.checked;
  document.body.classList.toggle("full-width", fullWidth);
  applyCardSize();
  try {
    localStorage.setItem("appdeck-full-width", String(fullWidth));
    preferenceError.hidden = true;
  } catch (error) {
    preferenceError.textContent = "Full-width preference could not be saved.";
    preferenceError.hidden = false;
  }
});

window.addEventListener("resize", applyCardSize);
if ("ResizeObserver" in window) {
  const cardSizeObserver = new ResizeObserver(applyCardSize);
  cardSizeObserver.observe(appsContainer);
}

if (window.location.protocol !== "https:") {
  sessionStorage.removeItem("appdeck-token");
  pairingError.textContent = "A trusted HTTPS connection is required. See the App Deck setup instructions.";
  pairingForm.querySelector("button").disabled = true;
  setConnected(false);
} else if (window.location.hash) {
  sessionStorage.removeItem("appdeck-token");
  setConnected(false);
  showPairingCodeFromUrl();
} else {
  token = sessionStorage.getItem("appdeck-token") || "";
  if (token) {
    setConnected(true);
    loadApps();
    startHeartbeat();
  } else {
    setConnected(false);
  }
}
