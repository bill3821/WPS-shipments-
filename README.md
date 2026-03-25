# 🚛 RouteGuard — Shipment Tracking Dashboard

A locally-hosted, real-time shipment tracking dashboard built for demountable wall companies. Track shipments, monitor route weather, and get severe weather impact assessments for your truck drivers — all from one clean dashboard.

## Features

- **Live Shipment Tracking** — Add, update, and delete shipments with status tracking (Scheduled → Loading → In Transit → Delivered/Delayed)
- **Route Weather Monitoring** — Real-time weather for origin, midpoint, and destination using Open-Meteo (free, no API key needed)
- **Severe Weather Alerts** — Live NWS/NOAA alerts along the route (free, no API key needed)
- **Trucking Impact Assessment** — Automatic risk scoring based on wind, precipitation, ice, visibility, thunderstorms, and active alerts
- **Multi-User Live Sync** — Dashboard auto-refreshes every 10 seconds so everyone on the network sees updates instantly
- **Persistent Storage** — Shipment data saved to a local JSON file — survives server restarts

## Quick Start

### Requirements
- **Node.js 18+** (uses built-in `fetch`)

### Setup

```bash
# 1. Navigate to the project folder
cd shipment-tracker

# 2. Start the server (no npm install needed — zero dependencies!)
node server.js

# 3. Open in your browser
#    http://localhost:3000
```

That's it. No API keys, no npm packages, no config files.

### Access from Other Devices on Your Network

Find your machine's local IP address:
- **Windows:** `ipconfig` → look for IPv4 Address (e.g. `192.168.1.50`)
- **Mac/Linux:** `ifconfig` or `ip addr`

Then share: `http://192.168.1.50:3000` — anyone on the same Wi-Fi/LAN can view and manage shipments.

## How It Works

### Weather APIs (Both Free, No Keys Required)

| API | What It Does | Docs |
|-----|-------------|------|
| [Open-Meteo](https://open-meteo.com/) | Current weather (temp, wind, precip, visibility) at origin, midpoint, and destination | Free for non-commercial use |
| [NWS / NOAA](https://www.weather.gov/documentation/services-web-api) | Active severe weather alerts by zone (tornado warnings, winter storms, floods, etc.) | Completely free, US government open data |

### Trucking Impact Scoring

The dashboard automatically calculates a risk level based on:

| Factor | Threshold | Impact |
|--------|-----------|--------|
| Wind speed | 20+ mph moderate, 30+ strong, 45+ dangerous | Semi trucks can be blown over at 45+ |
| Precipitation | 0.2"+ moderate, 0.5"+ heavy | Hydroplaning risk, reduced traction |
| Freezing rain/ice | Any | Extremely dangerous for semis |
| Snow | Any | Reduced speed, chains required |
| Thunderstorms | Any | Lightning, hail, sudden gusts |
| Visibility | <5 mi reduced, <1 mi dangerous | Fog, whiteout conditions |
| NWS Alerts | Moderate/Severe/Extreme | Official warnings from NOAA |

Risk levels: **LOW** → **MODERATE** → **HIGH** → **SEVERE**

## Project Structure

```
shipment-tracker/
├── server.js          # Node.js server (API + static files)
├── shipments.json     # Auto-created data file
├── public/
│   └── index.html     # Dashboard frontend (single file)
└── README.md
```

## Tips

- **Weather caches for 10 minutes** per route to avoid hammering the APIs
- **Status colors** in the sidebar let you quickly scan which shipments need attention
- **Delete shipments** you no longer need from the detail panel
- The NWS API requires a `User-Agent` header — the server sends one automatically
- For production use at scale, consider adding authentication and a proper database

## License

Free to use for your business. Weather data provided by Open-Meteo and the US National Weather Service.
