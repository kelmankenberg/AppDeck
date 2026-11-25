# Changelog

## 0.2.0 - 2026-11-25

- Refreshed the marketplace preview and phone screenshots for workspace
  controls, optional desktop colors, centered cards, and the expanded settings.
- Added optional horizontal card centering, including partially filled rows,
  while preserving card sizes, gaps, and page padding. Verified on the phone.
- Added optional desktop theme colors, desktop wallpaper, and adjustable
  background dimming. The original appearance remains the default; enabled
  desktop appearance follows changes while the phone page is visible. Verified
  colors, wallpaper, and dimming on the phone.
- Added PC-only paired-device listing, names, last-seen activity, and individual
  revocation with separate credentials. Pairings now survive browser relaunches.
  Upgrading from shared credentials requires one-time re-pairing. Verified
  phone re-pairing, naming, and individual disconnect.
- Added an optional browser-saved confirmation before stopping apps to help
  prevent accidental closings.
- Added an installable standalone home-screen app with browser install
  controls and fallback instructions in settings; verified installation and
  standalone launch on Android.
- Added workspace buttons that follow the focused monitor's Omarchy workspace
  bar, switch workspaces, and highlight the active workspace; verified on Android
  in normal and fullscreen modes.
- Smoothed card reordering with a finger-following preview and animated card
  movement, respecting reduced-motion preferences.
- Added long-press card reordering with a shared order across paired phones and
  keyboard support; verified drag, persistence, and shared order on Android.
- Verified Android app control through both LAN HTTPS and Tailscale while
  Docker and Tailscale interfaces were present.
- Kept pairings across service and shell restarts and automatically restored
  the app list after a temporary connection interruption. Verified on Android
  across a shell restart without refreshing or re-pairing.
- Added a confirmed **Disconnect all phones** control that rotates pairing
  credentials by restarting the App Deck service; verified disconnect and
  re-pairing on Android.
- Documented that a paired phone can change the shared app selection and
  launch any discovered desktop app.
- Tested Android LAN reconnection in Brave after toggling Wi-Fi; the existing
  tab reconnected without re-pairing and launched and stopped Foot.
