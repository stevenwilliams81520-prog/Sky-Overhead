# Sky Overhead – iPhone app

The same app as the Google Apps Script version, packaged with Capacitor so the
motion sensors, camera and live GPS work. Apps Script stays as the server.

## One-time setup
1. In Apps Script, replace Code.gs with the new one, then
   Deploy → Manage deployments → ✏️ → Version: New version → Deploy.
   "Who has access" must be **Anyone**. Copy the Web app URL (ends in /exec).
2. Paste that URL into `src/app-config.js`.
3. In App Store Connect, create the app with bundle ID `com.stevenwilliams.skyoverhead`
   (or change it in `capacitor.config.json` and `codemagic.yaml` to one you prefer).
   Put its Apple ID number in `codemagic.yaml` (APP_STORE_APPLE_ID).
4. Push this folder to GitHub and run the "Sky Overhead iOS" workflow in Codemagic.
   It builds and sends the app to TestFlight.

## Updating later
Copy the latest Index.html and StarData.html from Apps Script into `src/`, push, and build again.

## Files
- `src/` – the Apps Script page files, plus app-config.js (your server URL)
- `build-www.js` – turns src into the app's `www` folder
- `assets/icon-only.png`, `assets/splash.png` – app icon and launch screen (Codemagic makes all the sizes)
- `codemagic.yaml` – the cloud build for TestFlight
