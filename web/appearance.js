"use strict";

const followDesktopTheme = document.querySelector("#follow-desktop-theme");
const useDesktopWallpaper = document.querySelector("#use-desktop-wallpaper");
const backgroundDimming = document.querySelector("#background-dimming");
const dimmingValue = document.querySelector("#dimming-value");
const appearanceError = document.querySelector("#appearance-error");
let appearanceSettings = { theme: false, wallpaper: false, dimming: 65 };
let appearanceGeneration = 0;
let appearanceLoading = false;
let wallpaperUrl = "";
let wallpaperRevision = "";
let appliedThemeProperties = [];

try {
  const saved = localStorage.getItem("appdeck-appearance");
  if (saved) {
    const value = JSON.parse(saved);
    if (!value || typeof value.theme !== "boolean" || typeof value.wallpaper !== "boolean" ||
        !Number.isInteger(value.dimming) || value.dimming < 0 || value.dimming > 100) {
      throw new Error("Invalid appearance settings");
    }
    appearanceSettings = value;
  }
} catch (error) {
  appearanceError.textContent = "Appearance preferences could not be loaded.";
  appearanceError.hidden = false;
}

function syncAppearanceControls() {
  followDesktopTheme.checked = appearanceSettings.theme;
  useDesktopWallpaper.checked = appearanceSettings.wallpaper;
  backgroundDimming.value = String(appearanceSettings.dimming);
  backgroundDimming.disabled = !appearanceSettings.wallpaper;
  dimmingValue.textContent = `${appearanceSettings.dimming}%`;
  document.documentElement.style.setProperty("--wallpaper-dim", String(appearanceSettings.dimming / 100));
}

function resetDesktopColors() {
  for (const property of appliedThemeProperties) document.documentElement.style.removeProperty(property);
  appliedThemeProperties = [];
}

function clearDesktopWallpaper() {
  document.body.classList.toggle("has-wallpaper", false);
  document.documentElement.style.removeProperty("--desktop-wallpaper");
  if (wallpaperUrl) URL.revokeObjectURL(wallpaperUrl);
  wallpaperUrl = "";
  wallpaperRevision = "";
}

function resetDesktopAppearance() {
  appearanceGeneration++;
  resetDesktopColors();
  clearDesktopWallpaper();
}

function colorChannels(color) {
  return [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
}

function mixColors(first, second, amount) {
  const other = colorChannels(second);
  return "#" + colorChannels(first).map((value, index) =>
    Math.round(value * (1 - amount) + other[index] * amount).toString(16).padStart(2, "0")).join("");
}

function luminance(color) {
  const channels = colorChannels(color).map((value) => {
    const level = value / 255;
    return level <= 0.04045 ? level / 12.92 : ((level + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function readableColor(background, preferred) {
  const light = luminance(background);
  const text = luminance(preferred);
  if ((Math.max(light, text) + 0.05) / (Math.min(light, text) + 0.05) >= 4.5) return preferred;
  return light > 0.179 ? "#000000" : "#ffffff";
}

function applyDesktopColors(colors) {
  const keys = ["background", "foreground", "accent", "lighter_background", "dark_background", "selection", "red", "green"];
  if (!colors || !["background", "foreground", "accent"].every((key) => typeof colors[key] === "string") ||
      !keys.every((key) => colors[key] === undefined || /^#[0-9a-f]{6}$/i.test(colors[key]))) {
    throw new Error("The PC returned invalid desktop theme colors.");
  }
  const bg = colors.background;
  const fg = readableColor(bg, colors.foreground);
  const surface = colors.lighter_background || mixColors(bg, fg, 0.05);
  const surfaceText = readableColor(surface, fg);
  const input = colors.dark_background || bg;
  const border = mixColors(bg, fg, 0.3);
  const selected = colors.selection || mixColors(bg, colors.accent, 0.3);
  const running = mixColors(surface, colors.accent, 0.15);
  const danger = readableColor(surface, colors.red || "#e67e80");
  const properties = {
    "--page-bg": bg, "--page-top": surface, "--text": surfaceText,
    "--accent": colors.accent, "--on-accent": readableColor(colors.accent, bg),
    "--surface": surface, "--control": surface, "--quiet-text": surfaceText,
    "--border": border, "--panel-border": border,
    "--muted": surfaceText, "--label": surfaceText,
    "--input-bg": input, "--input-text": readableColor(input, fg),
    "--danger": danger, "--stop-bg": colors.red || colors.accent,
    "--stop-text": readableColor(colors.red || colors.accent, bg),
    "--selected-bg": selected, "--selected-text": readableColor(selected, fg),
    "--card-border": border, "--card-start": surface, "--card-end": bg,
    "--running-start": running, "--running-end": bg,
    "--running-text": readableColor(bg, colors.accent),
    "--card-overlay": bg, "--state-text": surfaceText,
    "--color-scheme": luminance(bg) > 0.179 ? "light" : "dark"
  };
  resetDesktopColors();
  for (const [key, value] of Object.entries(properties)) document.documentElement.style.setProperty(key, value);
  appliedThemeProperties = Object.keys(properties);
}

async function refreshDesktopAppearance() {
  if (!token || appsSection.hidden || document.hidden || appearanceLoading ||
      (!appearanceSettings.theme && !appearanceSettings.wallpaper)) return;
  appearanceLoading = true;
  const generation = appearanceGeneration;
  const current = () => generation === appearanceGeneration && token && !appsSection.hidden && !document.hidden;
  const errors = [];
  try {
    const data = await request("/api/appearance");
    if (!current()) return;
    if (appearanceSettings.theme) {
      try {
        if (!data.colors) throw new Error(data.colorError || "Desktop theme colors are unavailable.");
        applyDesktopColors(data.colors);
      } catch (error) {
        resetDesktopColors();
        errors.push(error.message);
      }
    }
    if (appearanceSettings.wallpaper) {
      try {
        if (typeof data.wallpaper !== "string" || !/^[a-f0-9]{64}$/.test(data.wallpaper)) {
          throw new Error(data.wallpaperError || "Desktop wallpaper is unavailable.");
        }
        if (data.wallpaper !== wallpaperRevision) {
          const response = await fetch("/api/wallpaper", {
            headers: { Authorization: `Bearer ${token}` }, cache: "no-store"
          });
          if (!response.ok) {
            const result = await response.json();
            throw new Error(result.error || "Desktop wallpaper could not be loaded.");
          }
          if (response.headers.get("Content-Type") !== "image/jpeg") throw new Error("Invalid desktop wallpaper response.");
          const blob = await response.blob();
          if (!current()) return;
          if (!blob.size || blob.size > 1024 * 1024) throw new Error("Desktop wallpaper preview is too large or empty.");
          clearDesktopWallpaper();
          wallpaperUrl = URL.createObjectURL(blob);
          wallpaperRevision = data.wallpaper;
          document.documentElement.style.setProperty("--desktop-wallpaper", `url("${wallpaperUrl}")`);
          document.body.classList.toggle("has-wallpaper", true);
        }
      } catch (error) {
        if (!current()) return;
        clearDesktopWallpaper();
        errors.push(error.message);
      }
    }
    appearanceError.textContent = errors.join(" ");
    appearanceError.hidden = errors.length === 0;
  } catch (error) {
    if (!current()) return;
    resetDesktopColors();
    clearDesktopWallpaper();
    appearanceError.textContent = `Desktop appearance unavailable: ${error.message}`;
    appearanceError.hidden = false;
  } finally {
    appearanceLoading = false;
    if (generation !== appearanceGeneration) refreshDesktopAppearance();
  }
}

function saveAppearanceSettings() {
  appearanceSettings = {
    theme: followDesktopTheme.checked,
    wallpaper: useDesktopWallpaper.checked,
    dimming: Math.max(0, Math.min(100, Number(backgroundDimming.value) || 0))
  };
  appearanceGeneration++;
  syncAppearanceControls();
  if (!appearanceSettings.theme) resetDesktopColors();
  if (!appearanceSettings.wallpaper) clearDesktopWallpaper();
  appearanceError.textContent = "";
  appearanceError.hidden = true;
  try {
    localStorage.setItem("appdeck-appearance", JSON.stringify(appearanceSettings));
  } catch (error) {
    preferenceError.textContent = "Appearance preferences could not be saved.";
    preferenceError.hidden = false;
  }
  refreshDesktopAppearance();
}

followDesktopTheme.addEventListener("change", saveAppearanceSettings);
useDesktopWallpaper.addEventListener("change", saveAppearanceSettings);
backgroundDimming.addEventListener("input", () => {
  document.documentElement.style.setProperty("--wallpaper-dim", String(Number(backgroundDimming.value) / 100));
  dimmingValue.textContent = `${backgroundDimming.value}%`;
});
backgroundDimming.addEventListener("change", saveAppearanceSettings);
syncAppearanceControls();
