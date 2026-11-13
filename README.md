# Sky Overhead – iPhone app

Satellites, stars, Sun & Moon, tides and lightning, with Sky view (point the
phone at the sky). Standalone: everything runs on the phone, no Apps Script needed.

## Build
1. Push this folder to GitHub.
2. Run the "Sky Overhead iOS" workflow in Codemagic. It builds the app and sends it to TestFlight.

## Files
- `src/Index.html`, `src/StarData.html` – the app's page and star catalogue
- `src/local-server.js` – fetches the data on the phone (CelesTrak, Open-Meteo,
  EUMETSAT, Wikipedia, OpenStreetMap) and keeps it for a while
- `build-www.js` – puts the page, data code and libraries into the `www` folder
- `assets/icon-only.png`, `assets/splash.png` – app icon and launch screen
- `capacitor.config.json` – app name and ID; native HTTP switched on
- `codemagic.yaml` – the cloud build for TestFlight

## Data sources
Satellites: CelesTrak. Tides: Open-Meteo (Météo-France model). Lightning: EUMETSAT.
Encyclopedia: Wikipedia (CC BY-SA). Place names and maps: © OpenStreetMap contributors.
Star catalogue: HYG database via d3-celestial.
