"use strict";

const pairing = document.querySelector("#pairing");
const pairingForm = document.querySelector("#pairing-form");
const pairingCode = document.querySelector("#pairing-code");
const deviceName = document.querySelector("#device-name");
const pairingError = document.querySelector("#pairing-error");
const appsSection = document.querySelector("#apps-section");
const workspaceButtons = document.querySelector("#workspace-buttons");
const workspaceError = document.querySelector("#workspace-error");
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
const centerCardsToggle = document.querySelector("#center-cards");
const confirmStopToggle = document.querySelector("#confirm-stop");
const installButton = document.querySelector("#install-app");
const installHelp = document.querySelector("#install-help");
const installStatus = document.querySelector("#install-status");
const appListTitle = document.querySelector("#app-list-title");
const appSearchGroup = document.querySelector("#app-search-group");
const appSearch = document.querySelector("#app-search");
const orderStatus = document.querySelector("#order-status");

let token = "";
let pairingSecret = "";
let configuring = false;
let heartbeatTimer = 0;
let workspaceTimer = 0;
let workspaceLoading = false;
let workspaceSwitching = false;
let workspaceGeneration = 0;
let activeWorkspace = null;
let connectionInterrupted = false;
let deckMode = false;
let deckFullscreenActive = false;
let cardSize = "default";
let fullWidth = false;
let centerCards = false;
let confirmStop = false;
let latestApps = [];
let appRevision = null;
let dragState = null;
let savingOrder = false;
let deferredInstallPrompt = null;
let installBusy = false;
let installCompleted = false;
const cardSizes = ["default", "large", "larger", "largest"];
const cardScales = { large: 1.2, larger: 1.4, largest: 1.6 };

try {
  deckMode = localStorage.getItem("appdeck-deck-mode") === "true";
  const savedSize = localStorage.getItem("appdeck-card-size");
  if (cardSizes.includes(savedSize)) cardSize = savedSize;
  fullWidth = localStorage.getItem("appdeck-full-width") === "true";
  centerCards = localStorage.getItem("appdeck-center-cards") === "true";
  confirmStop = localStorage.getItem("appdeck-confirm-stop") === "true";
} catch (error) {
  preferenceError.textContent = "Browser preferences could not be loaded.";
  preferenceError.hidden = false;
}
cardSizeSelect.value = cardSize;
fullWidthToggle.checked = fullWidth;
centerCardsToggle.checked = centerCards;
confirmStopToggle.checked = confirmStop;
document.body.classList.toggle("full-width", fullWidth);
document.body.classList.toggle("center-cards", centerCards);
appsContainer.dataset.cardSize = cardSize;

function applyCardSize() {
  appsContainer.dataset.cardSize = cardSize;
  if (cardSize === "default" && !centerCards) {
    appsContainer.style.removeProperty("--card-width");
    return;
  }
  const width = appsContainer.getBoundingClientRect().width;
  if (width <= 0) return;
  const gap = 0.6 * parseFloat(window.getComputedStyle(document.documentElement).fontSize);
  const columns = Math.max(1, Math.floor((width + gap) / (88 + gap)));
  const defaultWidth = (width - gap * (columns - 1)) / columns;
  const scale = cardSize === "default" ? 1 : cardScales[cardSize];
  appsContainer.style.setProperty("--card-width", `${Math.min(width, defaultWidth * scale)}px`);
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
  else {
    resetDesktopAppearance();
    window.clearInterval(workspaceTimer);
    workspaceTimer = 0;
    workspaceGeneration++;
    workspaceButtons.replaceChildren();
    workspaceError.textContent = "";
    activeWorkspace = null;
  }
}

function showPairingCodeFromUrl() {
  const fragment = window.location.hash.slice(1);
  if (!fragment) return;
  pairingSecret = fragment;
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
      card.dataset.appId = app.id;
      card.setAttribute("aria-label", `${app.state === "running" ? "Stop" : "Launch"} ${app.name}`);
      card.setAttribute("aria-describedby", "order-hint");
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
      addReorderHandlers(card);
      card.addEventListener("click", async (event) => {
        if (card.suppressClick || savingOrder) {
          if (event) event.preventDefault();
          card.suppressClick = false;
          return;
        }
        if (app.state === "running" && confirmStop &&
            !window.confirm(`Stop ${app.name}? Unsaved work may be lost.`)) return;
        card.disabled = true;
        await appAction(app.id, app.state === "running" ? "stop" : "launch");
        card.disabled = false;
      });
    }
    appsContainer.append(card);
  }
}

function addReorderHandlers(card) {
  function reducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  }

  function moveCard(x, y) {
    const target = document.elementFromPoint(x, y)?.closest(".deck-card");
    if (!target || target === card || target.parentElement !== appsContainer) return;
    const cards = Array.from(appsContainer.children);
    const positions = cards.map((item) => item.getBoundingClientRect());
    for (const item of cards) item.reorderAnimation?.cancel();
    const after = cards.indexOf(card) < cards.indexOf(target);
    appsContainer.insertBefore(card, after ? target.nextSibling : target);
    if (reducedMotion()) return;
    cards.forEach((item, index) => {
      if (item === card || typeof item.animate !== "function") return;
      const current = item.getBoundingClientRect();
      const dx = positions[index].left - current.left;
      const dy = positions[index].top - current.top;
      if (dx || dy) {
        item.reorderAnimation = item.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
          { duration: 180, easing: "ease-out" }
        );
      }
    });
  }

  function movePreview(state, x, y) {
    if (!state.preview) return;
    state.preview.style.left = `${x - state.offsetX}px`;
    state.preview.style.top = `${y - state.offsetY}px`;
  }

  function autoScroll(state, x, y) {
    state.pointerX = x;
    state.pointerY = y;
    const edge = 48;
    state.scrollSpeed = y < edge ? -12 : y > window.innerHeight - edge ? 12 : 0;
    if (!state.scrollSpeed || state.scrollFrame) return;
    function tick() {
      state.scrollFrame = 0;
      if (dragState !== state || !state.scrollSpeed) return;
      window.scrollBy(0, state.scrollSpeed);
      moveCard(state.pointerX, state.pointerY);
      state.scrollFrame = window.requestAnimationFrame(tick);
    }
    state.scrollFrame = window.requestAnimationFrame(tick);
  }

  function begin(x, y, kind, id) {
    if (dragState || savingOrder || appRevision === null) return;
    const state = { card, x, y, kind, id, active: false, initial: Array.from(appsContainer.children, (item) => item.dataset.appId) };
    dragState = state;
    state.timer = window.setTimeout(() => {
      if (dragState !== state) return;
      state.active = true;
      const bounds = card.getBoundingClientRect();
      state.offsetX = state.x - bounds.left;
      state.offsetY = state.y - bounds.top;
      state.preview = card.cloneNode(true);
      state.preview.classList.add("drag-preview");
      state.preview.setAttribute("aria-hidden", "true");
      state.preview.tabIndex = -1;
      state.preview.style.width = `${bounds.width}px`;
      state.preview.style.height = `${bounds.height}px`;
      movePreview(state, state.x, state.y);
      document.body.append(state.preview);
      card.classList.add("dragging");
      orderStatus.textContent = "Move the card, then release to save its position.";
    }, 500);
  }

  function move(x, y, event) {
    const state = dragState;
    if (!state || state.card !== card) return;
    if (!state.active) {
      if (Math.hypot(x - state.x, y - state.y) > 10) {
        window.clearTimeout(state.timer);
        dragState = null;
      }
      return;
    }
    if (event.cancelable) event.preventDefault();
    movePreview(state, x, y);
    moveCard(x, y);
    autoScroll(state, x, y);
  }

  function finish(event, cancelled = false) {
    const state = dragState;
    if (!state || state.card !== card) return;
    window.clearTimeout(state.timer);
    if (state.scrollFrame) window.cancelAnimationFrame(state.scrollFrame);
    dragState = null;
    if (!state.active) return;
    if (event.cancelable) event.preventDefault();
    state.preview.remove();
    card.classList.remove("dragging");
    card.suppressClick = true;
    window.setTimeout(() => { card.suppressClick = false; }, 500);
    const order = Array.from(appsContainer.children, (item) => item.dataset.appId);
    if (cancelled) {
      orderStatus.textContent = "Move cancelled.";
      renderApps(latestApps);
    } else if (order.some((id, index) => id !== state.initial[index])) {
      saveOrder(order);
    } else {
      orderStatus.textContent = "Card order unchanged.";
    }
  }

  card.addEventListener("contextmenu", (event) => event.preventDefault());
  card.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) {
      if (dragState?.card === card) finish(event, true);
      return;
    }
    const touch = event.touches[0];
    begin(touch.clientX, touch.clientY, "touch", touch.identifier);
  }, { passive: false });
  card.addEventListener("touchmove", (event) => {
    if (dragState?.kind !== "touch" || dragState.card !== card) return;
    if (event.touches.length !== 1) {
      finish(event, true);
      return;
    }
    const touch = Array.from(event.touches).find((item) => item.identifier === dragState.id);
    if (touch) move(touch.clientX, touch.clientY, event);
  }, { passive: false });
  card.addEventListener("touchend", (event) => {
    if (dragState?.kind === "touch" && Array.from(event.changedTouches).some((item) => item.identifier === dragState.id))
      finish(event);
  }, { passive: false });
  card.addEventListener("touchcancel", (event) => finish(event, true));

  card.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    card.setPointerCapture(event.pointerId);
    begin(event.clientX, event.clientY, "mouse", event.pointerId);
  });
  card.addEventListener("pointermove", (event) => {
    if (dragState?.kind === "mouse" && event.pointerId === dragState.id)
      move(event.clientX, event.clientY, event);
  });
  card.addEventListener("pointerup", (event) => {
    if (dragState?.kind === "mouse" && event.pointerId === dragState.id) finish(event);
  });
  card.addEventListener("pointercancel", (event) => finish(event, true));
  card.addEventListener("keydown", (event) => {
    if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key) || savingOrder || appRevision === null) return;
    const cards = Array.from(appsContainer.children);
    const index = cards.indexOf(card);
    const next = index + (event.key === "ArrowLeft" ? -1 : 1);
    if (next < 0 || next >= cards.length) return;
    event.preventDefault();
    const order = cards.map((item) => item.dataset.appId);
    [order[index], order[next]] = [order[next], order[index]];
    saveOrder(order, card.dataset.appId);
  });
}

async function saveOrder(order, focusId) {
  savingOrder = true;
  orderStatus.textContent = "Saving card order…";
  let errorMessage = "";
  try {
    await request("/api/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order, revision: appRevision })
    });
  } catch (error) {
    errorMessage = error.message;
  } finally {
    savingOrder = false;
  }
  await loadApps();
  if (errorMessage) {
    appError.textContent = errorMessage;
    orderStatus.textContent = "Card order was not saved.";
  } else {
    orderStatus.textContent = "Card order saved.";
  }
  const card = Array.from(appsContainer.children).find((item) => item.dataset.appId === focusId);
  if (card) card.focus({ preventScroll: true });
}

async function loadApps() {
  if (dragState || savingOrder) return;
  appError.textContent = "";
  try {
    const data = await request("/api/apps");
    if (dragState || savingOrder) return;
    appRevision = Number.isInteger(data.revision) ? data.revision : null;
    renderApps(data.apps);
    appError.textContent = data.iconError || "";
  } catch (error) {
    appError.textContent = error.message;
    if (error.message.includes("Pairing code")) {
      token = "";
      clearSavedPairing();
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = 0;
      pairingError.textContent = error.message;
      setConnected(false);
    } else {
      connectionInterrupted = true;
    }
  }
}

async function sendHeartbeat() {
  if (!token) return;
  try {
    const data = await request("/api/ping", { method: "POST" });
    if (connectionInterrupted || (Number.isInteger(data.revision) && data.revision !== appRevision)) {
      connectionInterrupted = false;
      await loadApps();
    }
    refreshDesktopAppearance();
  } catch (error) {
    appError.textContent = error.message;
    if (error.message.includes("Pairing code")) {
      token = "";
      clearSavedPairing();
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = 0;
      pairingError.textContent = error.message;
      setConnected(false);
    } else {
      connectionInterrupted = true;
    }
  }
}

function clearSavedPairing() {
  try {
    sessionStorage.removeItem("appdeck-token");
    localStorage.removeItem("appdeck-token");
  } catch (error) {
    preferenceError.textContent = "Saved pairing could not be cleared. Clear this site's browser data before pairing again.";
    preferenceError.hidden = false;
  }
}

function startHeartbeat() {
  window.clearInterval(heartbeatTimer);
  sendHeartbeat();
  heartbeatTimer = window.setInterval(sendHeartbeat, 10000);
  startWorkspaceUpdates();
}

function startWorkspaceUpdates() {
  window.clearInterval(workspaceTimer);
  workspaceTimer = 0;
  if (!token || appsSection.hidden || document.hidden) return;
  loadWorkspaces();
  workspaceTimer = window.setInterval(loadWorkspaces, 2000);
}

async function loadWorkspaces() {
  if (!token || appsSection.hidden || document.hidden || workspaceLoading || workspaceSwitching) return;
  workspaceLoading = true;
  const generation = workspaceGeneration;
  try {
    const data = await request("/api/workspaces");
    if (generation !== workspaceGeneration || !token || appsSection.hidden || document.hidden) return;
    if (!Array.isArray(data.workspaces) || data.workspaces.length > 256 ||
        !Number.isInteger(data.active) || !data.workspaces.every((item) =>
          Number.isInteger(item.id) && item.id > 0 && item.id <= 1000000 &&
          Number.isInteger(item.label) && item.label === item.id % 10)) {
      throw new Error("The PC returned invalid workspace data.");
    }
    const ids = data.workspaces.map((item) => String(item.id));
    const existing = Array.from(workspaceButtons.children);
    if (ids.length !== existing.length || ids.some((id, index) => existing[index].dataset.workspaceId !== id)) {
      workspaceButtons.replaceChildren();
      for (const item of data.workspaces) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.workspaceId = String(item.id);
        button.textContent = String(item.label);
        button.setAttribute("aria-label", `Workspace ${item.label}`);
        button.addEventListener("click", () => focusWorkspace(item.id));
        workspaceButtons.append(button);
      }
    }
    activeWorkspace = data.active;
    for (const button of workspaceButtons.children) {
      const active = Number(button.dataset.workspaceId) === activeWorkspace;
      button.classList.toggle("workspace-inactive", !active);
      button.setAttribute("aria-pressed", String(active));
    }
    workspaceError.textContent = "";
  } catch (error) {
    if (generation !== workspaceGeneration || !token || appsSection.hidden) return;
    workspaceButtons.replaceChildren();
    activeWorkspace = null;
    workspaceError.textContent = `Workspaces unavailable: ${error.message}`;
  } finally {
    workspaceLoading = false;
    if (generation !== workspaceGeneration && !workspaceSwitching) loadWorkspaces();
  }
}

async function focusWorkspace(id) {
  if (workspaceSwitching || id === activeWorkspace) return;
  workspaceSwitching = true;
  workspaceGeneration++;
  workspaceError.textContent = "";
  try {
    await request(`/api/workspaces/${id}/focus`, { method: "POST" });
  } catch (error) {
    workspaceError.textContent = `Could not switch workspace: ${error.message}`;
    workspaceSwitching = false;
    return;
  }
  workspaceSwitching = false;
  loadWorkspaces();
}

async function connect() {
  pairingError.textContent = "";
  try {
    if (!token) {
      const code = (pairingCode.value || "").trim();
      if (!pairingSecret && !/^[0-9]{4}-?[0-9]{4}$/.test(code))
        throw new Error("Enter the eight-digit pairing code from the PC.");
      const result = await request("/api/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(pairingSecret ? { secret: pairingSecret } : { code }), name: (deviceName.value || "").trim() || "Phone" })
      });
      token = result.token;
      pairingSecret = "";
    }
    await request("/api/apps");
    sessionStorage.setItem("appdeck-token", token);
    try {
      localStorage.setItem("appdeck-token", token);
    } catch (error) {
      preferenceError.textContent = "Pairing could not be saved for future visits. Keep this session open or pair again next time.";
      preferenceError.hidden = false;
    }
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
    : "Tap to launch or stop. Hold and drag to reorder.";
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

function updateInstallButton() {
  const installed = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  installButton.hidden = installed || installCompleted || (!deferredInstallPrompt && typeof navigator.install !== "function");
  installHelp.hidden = installed;
  if (installed) installStatus.textContent = "App Deck is running as an installed app.";
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallButton();
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  installCompleted = true;
  installButton.hidden = true;
  installStatus.textContent = "App Deck was installed. Open it from your home screen and pair if prompted.";
});

installButton.addEventListener("click", async () => {
  if (installBusy) return;
  installBusy = true;
  const prompt = deferredInstallPrompt;
  deferredInstallPrompt = null;
  try {
    if (typeof navigator.install === "function") {
      await navigator.install();
      installCompleted = true;
      installStatus.textContent = "App Deck was installed or opened. Pair if prompted.";
    } else if (prompt) {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      installStatus.textContent = choice.outcome === "accepted"
        ? "Installation accepted. Open App Deck from your home screen and pair if prompted."
        : "Installation canceled.";
    }
  } catch (error) {
    installStatus.textContent = error.name === "AbortError"
      ? "Installation was canceled or could not complete."
      : "Installation could not start. Use your browser's installation menu.";
  } finally {
    installBusy = false;
    updateInstallButton();
  }
});

updateInstallButton();

document.addEventListener("fullscreenchange", () => {
  if (document.fullscreenElement) {
    if (deckMode) deckFullscreenActive = true;
  } else if (deckFullscreenActive) {
    deckFullscreenActive = false;
    if (deckMode) setDeckMode(false);
  }
});

document.addEventListener("visibilitychange", () => {
  startWorkspaceUpdates();
  if (document.hidden) appearanceGeneration++;
  else refreshDesktopAppearance();
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

centerCardsToggle.addEventListener("change", () => {
  centerCards = centerCardsToggle.checked;
  document.body.classList.toggle("center-cards", centerCards);
  applyCardSize();
  try {
    localStorage.setItem("appdeck-center-cards", String(centerCards));
    preferenceError.hidden = true;
  } catch (error) {
    preferenceError.textContent = "Card centering preference could not be saved.";
    preferenceError.hidden = false;
  }
});

confirmStopToggle.addEventListener("change", () => {
  confirmStop = confirmStopToggle.checked;
  try {
    localStorage.setItem("appdeck-confirm-stop", String(confirmStop));
    preferenceError.hidden = true;
  } catch (error) {
    preferenceError.textContent = "Stop confirmation preference could not be saved.";
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
  try {
    token = localStorage.getItem("appdeck-token") || sessionStorage.getItem("appdeck-token") || "";
  } catch (error) {
    token = sessionStorage.getItem("appdeck-token") || "";
    preferenceError.textContent = "Saved pairing could not be loaded.";
    preferenceError.hidden = false;
  }
  if (token) {
    setConnected(true);
    loadApps();
    startHeartbeat();
  } else {
    setConnected(false);
  }
}
