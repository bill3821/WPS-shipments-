const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'shipments.json');

function loadShipments() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('Error loading data:', e); }
  return [];
}
function saveShipments(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
let shipments = loadShipments();

// Nominatim geocoding — handles full street addresses
async function geocode(address) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&addressdetails=1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'RouteGuard-ShipmentTracker/2.0' } });
    const data = await res.json();
    if (data && data.length > 0) {
      const r = data[0];
      const addr = r.address || {};
      const city = addr.city || addr.town || addr.village || addr.county || r.display_name.split(',')[0];
      return { lat: parseFloat(r.lat), lon: parseFloat(r.lon), name: city, state: addr.state || '', fullName: r.display_name };
    }
  } catch (e) { console.error('Geocode error:', address, e.message); }
  // Fallback: Open-Meteo city geocoder
  try {
    const r2 = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(address)}&count=1&language=en&format=json`);
    const d2 = await r2.json();
    if (d2.results?.length > 0) {
      const r = d2.results[0];
      return { lat: r.latitude, lon: r.longitude, name: r.name, state: r.admin1 || '', fullName: `${r.name}, ${r.admin1 || ''}` };
    }
  } catch (e2) { console.error('Fallback geocode error:', e2.message); }
  return null;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getWeatherForPoint(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m,precipitation,visibility,relative_humidity_2m&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.current) {
    const c = data.current;
    return {
      tempF: Math.round(c.temperature_2m), weatherCode: c.weather_code,
      windMph: Math.round(c.wind_speed_10m), gustMph: Math.round(c.wind_gusts_10m || 0),
      precipIn: (c.precipitation || 0).toFixed(2), humidity: Math.round(c.relative_humidity_2m || 0),
      visMiles: c.visibility ? Math.round(c.visibility * 0.000621371) : 'N/A',
      description: weatherCodeToText(c.weather_code)
    };
  }
  return null;
}

function weatherCodeToText(code) {
  const m = { 0:'Clear sky',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',45:'Foggy',48:'Rime fog',
    51:'Light drizzle',53:'Moderate drizzle',55:'Dense drizzle',56:'Freezing drizzle',57:'Freezing drizzle (dense)',
    61:'Slight rain',63:'Moderate rain',65:'Heavy rain',66:'Freezing rain',67:'Heavy freezing rain',
    71:'Light snow',73:'Moderate snow',75:'Heavy snow',77:'Snow grains',80:'Light showers',81:'Moderate showers',
    82:'Violent showers',85:'Light snow showers',86:'Heavy snow showers',
    95:'Thunderstorm',96:'Thunderstorm w/ hail',99:'Severe thunderstorm w/ hail' };
  return m[code] || 'Unknown';
}

async function getNWSAlerts(lat, lon) {
  try {
    const pr = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, {
      headers: { 'User-Agent': 'RouteGuard-ShipmentTracker/2.0 (routeguard@example.com)', 'Accept': 'application/geo+json' }
    });
    if (!pr.ok) return [];
    const pd = await pr.json();
    const zoneId = pd?.properties?.forecastZone?.split('/').pop();
    if (!zoneId) return [];
    const ar = await fetch(`https://api.weather.gov/alerts/active?zone=${zoneId}`, {
      headers: { 'User-Agent': 'RouteGuard-ShipmentTracker/2.0 (routeguard@example.com)' }
    });
    const ad = await ar.json();
    return (ad.features || []).map(f => ({
      event: f.properties.event, severity: f.properties.severity,
      headline: f.properties.headline, description: f.properties.description?.substring(0, 300),
      urgency: f.properties.urgency, areas: f.properties.areaDesc
    }));
  } catch (e) { return []; }
}

async function getRouteWeather(originAddr, destAddr) {
  const originGeo = await geocode(originAddr);
  await delay(1100);
  const destGeo = await geocode(destAddr);
  if (!originGeo || !destGeo) {
    const fail = !originGeo ? `origin ("${originAddr}")` : `destination ("${destAddr}")`;
    return { points: [], alerts: [], impact: { level: 'low', text: `Could not locate ${fail}. Try a more specific address or city/state.` } };
  }

  // 5 waypoints along route
  const waypoints = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    waypoints.push({
      lat: originGeo.lat + t * (destGeo.lat - originGeo.lat),
      lon: originGeo.lon + t * (destGeo.lon - originGeo.lon),
      label: i === 0 ? `${originGeo.name}, ${originGeo.state} (Origin)`
           : i === 4 ? `${destGeo.name}, ${destGeo.state} (Dest.)`
           : `Waypoint ${i} (${Math.round(t*100)}%)`
    });
  }

  const wxResults = await Promise.all(waypoints.map(wp => getWeatherForPoint(wp.lat, wp.lon)));
  const points = waypoints.map((wp, i) => wxResults[i] ? { ...wxResults[i], label: wp.label, lat: wp.lat, lon: wp.lon } : null).filter(Boolean);

  const alertResults = await Promise.all([waypoints[0], waypoints[2], waypoints[4]].map(wp => getNWSAlerts(wp.lat, wp.lon)));
  const seen = new Set();
  const uniqueAlerts = alertResults.flat().filter(a => { const k = a.event+'|'+a.headline; if (seen.has(k)) return false; seen.add(k); return true; });

  return { points, alerts: uniqueAlerts, impact: assessImpact(points, uniqueAlerts) };
}

function assessImpact(pts, alerts) {
  let score = 0, reasons = [];
  for (const p of pts) {
    if (p.windMph >= 45) { score += 40; reasons.push('dangerous high winds'); }
    else if (p.windMph >= 30) { score += 20; reasons.push('strong winds'); }
    else if (p.windMph >= 20) score += 5;
    if (p.gustMph >= 55) { score += 30; reasons.push('severe gusts'); }
    if (p.precipIn >= 0.5) { score += 25; reasons.push('heavy precipitation'); }
    else if (p.precipIn >= 0.2) score += 10;
    if ([66,67,56,57].includes(p.weatherCode)) { score += 40; reasons.push('freezing rain/ice'); }
    if ([71,73,75,77,85,86].includes(p.weatherCode)) { score += 30; reasons.push('snowfall'); }
    if ([95,96,99].includes(p.weatherCode)) { score += 35; reasons.push('thunderstorms'); }
    if (p.visMiles !== 'N/A' && p.visMiles < 1) { score += 30; reasons.push('very low visibility'); }
    else if (p.visMiles !== 'N/A' && p.visMiles < 5) { score += 10; reasons.push('reduced visibility'); }
    if ([45,48].includes(p.weatherCode)) { score += 15; reasons.push('fog'); }
  }
  for (const a of alerts) {
    if (a.severity === 'Extreme') { score += 50; reasons.push(a.event); }
    else if (a.severity === 'Severe') { score += 35; reasons.push(a.event); }
    else if (a.severity === 'Moderate') score += 15;
  }
  const uniq = [...new Set(reasons)];
  if (score >= 80) return { level: 'severe', text: `Dangerous — consider delaying. ${uniq.join(', ')}.` };
  if (score >= 40) return { level: 'high', text: `Significant delays likely. ${uniq.join(', ')}.` };
  if (score >= 15) return { level: 'moderate', text: `Minor impacts possible. ${uniq.join(', ')}.` };
  return { level: 'low', text: 'Clear conditions — safe for trucking.' };
}

// HTTP SERVER
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    return;
  }
  // Serve static files from public/
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    const ext = path.extname(url.pathname);
    const mimeTypes = { '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.css':'text/css', '.js':'application/javascript', '.ico':'image/x-icon' };
    const filePath = path.join(__dirname, 'public', url.pathname);
    if (fs.existsSync(filePath) && mimeTypes[ext]) {
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] });
      res.end(fs.readFileSync(filePath));
      return;
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/shipments') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(shipments));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/shipments') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const d = JSON.parse(body);
      const shipment = {
        id: 'SHP-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
        trackingNumber: d.trackingNumber || '',
        loadPlanNumber: d.loadPlanNumber || '',
        jobName: d.jobName || '',
        originAddress: d.originAddress || '',
        originCity: d.originCity || '',
        originState: d.originState || '',
        destAddress: d.destAddress || '',
        destCity: d.destCity || '',
        destState: d.destState || '',
        shipDate: d.shipDate || '',
        estArrival: d.estArrival || '',
        status: d.status || 'scheduled',
        driver: d.driver || '',
        driverPhone: d.driverPhone || '',
        carrier: d.carrier || '',
        contactName: d.contactName || '',
        contactPhone: d.contactPhone || '',
        contactEmail: d.contactEmail || '',
        notes: d.notes || '',
        createdAt: new Date().toISOString()
      };
      shipments.push(shipment);
      saveShipments(shipments);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(shipment));
    });
    return;
  }
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/shipments/')) {
    const id = url.pathname.split('/').pop();
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const updates = JSON.parse(body);
      const idx = shipments.findIndex(s => s.id === id);
      if (idx === -1) { res.writeHead(404); res.end('Not found'); return; }
      Object.assign(shipments[idx], updates);
      saveShipments(shipments);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(shipments[idx]));
    });
    return;
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/shipments/')) {
    const id = url.pathname.split('/').pop();
    shipments = shipments.filter(s => s.id !== id);
    saveShipments(shipments);
    res.writeHead(204); res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/weather') {
    const origin = url.searchParams.get('origin');
    const dest = url.searchParams.get('destination');
    if (!origin || !dest) { res.writeHead(400); res.end(JSON.stringify({ error: 'origin and destination required' })); return; }
    try {
      const data = await getRouteWeather(origin, dest);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      console.error('Weather API error:', e);
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  🚛 WPS Shipments — http://localhost:${PORT}\n`);
  console.log('  ✓ Full address geocoding (Nominatim + Open-Meteo fallback)');
  console.log('  ✓ 5-point route weather monitoring (Open-Meteo)');
  console.log('  ✓ NWS/NOAA severe weather alerts');
  console.log('  ✓ Tracking number & carrier fields\n');
});
