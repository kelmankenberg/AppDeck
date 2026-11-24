# App Deck

Launch and manage selected Omarchy applications from a phone on the same trusted
private network.

App Deck is an Omarchy Quattro bar plugin with a small local Python service and
a mobile-friendly browser interface. On the phone, use **Configure** to choose
installed desktop apps, then tap a card to launch or stop an App Deck-managed
instance.

Use **Deck mode** to hide the header and controls and request fullscreen.
**Show controls** restores them and exits fullscreen; the browser's exit
gesture also leaves Deck mode. Browsers require a fresh tap for fullscreen
after a page reload, even when Deck mode is remembered. Configuration also
offers four card sizes, a full-width option, and links to report bugs or request
features on GitHub.
Display preferences are saved in that browser.

## Development

The service uses Python 3 and the standard library. `qrencode` is optional; when
installed, App Deck shows a QR code that opens the phone page and supplies the
pairing code. Without it, enter the displayed address and pairing code manually.
App icons use PyGObject, GTK 4 and GdkPixbuf when available; missing icons fall
back to an initial.

Run the focused service tests with:

```sh
python3 -m unittest discover -s tests
```

Validate the plugin from an Omarchy Quattro system with:

```sh
omarchy plugin validate .
```

## Security and behavior

- The service binds to a private IPv4 address on TCP port `8765`. It does
  not listen on every interface or expose a shell endpoint.
- Manual pairing uses an eight-digit code, with a global limit of five failed
  attempts per five minutes. It exchanges the code for the same random per-run
  bearer token used by QR pairing. Both change when the service restarts. The
  API only accepts configured desktop-app IDs and launch/stop actions.
- This initial browser version uses HTTP. Use it only on a trusted private
  network; do not port-forward the service or use it on public/shared Wi-Fi.
  Other devices on that network may be able to observe traffic.
- App Deck launches the selected desktop entry's `Exec` command without a
  shell. Stop targets only the process group App Deck started. Apps that hand
  off to a pre-existing single-instance process may not be trackable or
  stoppable through App Deck.
- The selected app IDs are stored in
  `~/.config/appdeck/apps.json`. Tracked process IDs are stored in
  `~/.local/state/appdeck/runs.json` so a shell reload can retain stop controls.

The plugin has not been published to the Omarchy marketplace.
