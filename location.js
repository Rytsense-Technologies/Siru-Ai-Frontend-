// Where the signed-in user is - their device location, or an address they
// typed - for "nearest pharmacy" on the shelf (GET /v1/sandbox/products
// ?nearest=true&lat=&lng=). No DOM here: location-ui.js draws it.
//
// Permission is asked for only when the user taps "Use my current location",
// or read silently when the browser already granted it - never in a loop.
// A denied permission stays denied until the user changes it in the browser;
// the permission's own change event (and coming back to the tab) notices.
//
// Kept per user and per tab (sessionStorage, siru_location_<user>), rounded
// to ~110 m, and forgotten on sign-out. Never sent to the server except as
// the lat/lng of that one catalog request; nothing here is logged.
const LOCATION_TIMEOUT_MS = 10000;
const LOCATION_MAX_AGE_MS = 5 * 60 * 1000;
const LOCATION_DECIMALS = 3;
const LOCATION_ADDRESS_MAX = 200;
const LOCATION_LABELS = ['Home', 'Office', 'Other'];

const siruLocation = {
  // 'unknown' (the browser can't say), 'prompt', 'granted', 'denied', 'unsupported'
  permission: 'unknown',
  loading: false,
  // null, or {code: 'denied'|'unavailable'|'timeout'|'unsupported'|'insecure', message}
  error: null,
  // null, or {source: 'device'|'manual', lat, lng, accuracy, timestamp, label, address, pincode}
  place: null,
  userId: null,
  listeners: new Set(),
  permissionStatus: null,
  request: null,
};

const LOCATION_ERRORS = {
  denied: 'Location access is blocked for this site.',
  unavailable: "Your device couldn't find its location. Check that location services are on.",
  timeout: 'Finding your location took too long. Check that location services are on and try again.',
  unsupported: "This browser can't share your location.",
  insecure: 'Location only works when this page is opened over https:// or from localhost.',
};

function locationKey(userId) { return `siru_location_${userId}`; }
function locationRound(value) {
  const factor = 10 ** LOCATION_DECIMALS;
  return Math.round(value * factor) / factor;
}

function locationSubscribe(listener) {
  siruLocation.listeners.add(listener);
  return () => siruLocation.listeners.delete(listener);
}
function locationNotify() {
  for (const listener of siruLocation.listeners) {
    try { listener(siruLocation); } catch (err) { console.error('location listener failed', err); }
  }
}

function locationValidCoords(lat, lng) {
  // (0,0) is a placeholder (no real fix), never a location.
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    && !(lat === 0 && lng === 0);
}

// What was saved for this user, if it still has the right shape.
function locationValidPlace(place) {
  if (!place || typeof place !== 'object' || !['device', 'manual'].includes(place.source)) return null;
  const hasCoords = place.lat != null && place.lng != null;
  if (hasCoords && !locationValidCoords(place.lat, place.lng)) return null;
  if (place.source === 'device' && !hasCoords) return null;
  if (place.source === 'manual' && !String(place.address || '').trim()) return null;
  return place;
}

function locationError(code) { return {code, message: LOCATION_ERRORS[code]}; }

function locationSupport() {
  if (typeof navigator.geolocation?.getCurrentPosition !== 'function') return 'unsupported';
  if (window.isSecureContext === false) return 'insecure';
  return null;
}

// The signed-in user's saved choice (or none) - called on every sign-in.
function locationLoad(userId) {
  siruLocation.userId = userId || null;
  siruLocation.place = userId ? locationValidPlace(userRead(locationKey(userId), null, sessionStorage)) : null;
  siruLocation.error = null;
  siruLocation.loading = false;
  siruLocation.request = null;
  locationNotify();
  return siruLocation.place;
}

function locationSave(place) {
  const userId = siruLocation.userId;
  if (!userId) return null;
  siruLocation.place = place;
  siruLocation.error = null;
  userWrite(locationKey(userId), place, sessionStorage);
  locationNotify();
  return place;
}

// Sign-out: nothing about where this user was stays in the tab.
function locationForget(userId = siruLocation.userId) {
  if (userId) userForget(locationKey(userId), sessionStorage);
  siruLocation.userId = null;
  siruLocation.place = null;
  siruLocation.error = null;
  siruLocation.loading = false;
  siruLocation.request = null;
  locationNotify();
}

// The browser's permission, without asking for it. Watches for the user
// changing it later (site settings), once per page.
async function locationPermission() {
  const unsupported = locationSupport();
  if (unsupported) {
    siruLocation.permission = 'unsupported';
    return siruLocation.permission;
  }
  if (!navigator.permissions?.query) {
    siruLocation.permission = 'unknown';
    return siruLocation.permission;
  }
  try {
    if (!siruLocation.permissionStatus) {
      siruLocation.permissionStatus = await navigator.permissions.query({name: 'geolocation'});
      siruLocation.permissionStatus.addEventListener?.('change', locationPermissionChanged);
    }
    siruLocation.permission = siruLocation.permissionStatus.state;
  } catch {
    siruLocation.permission = 'unknown';
  }
  return siruLocation.permission;
}

function locationPermissionChanged() {
  siruLocation.permission = siruLocation.permissionStatus?.state || 'unknown';
  // Blocked after the fact: a device location may no longer be the user's wish.
  if (siruLocation.permission === 'denied' && siruLocation.place?.source === 'device') {
    if (siruLocation.userId) userForget(locationKey(siruLocation.userId), sessionStorage);
    siruLocation.place = null;
    siruLocation.error = locationError('denied');
  }
  if (siruLocation.permission === 'granted' && siruLocation.error?.code === 'denied') siruLocation.error = null;
  locationNotify();
}

function locationFromPosition(position) {
  const {latitude, longitude, accuracy} = position.coords;
  if (!locationValidCoords(latitude, longitude)) throw locationError('unavailable');
  const place = {
    source: 'device', lat: locationRound(latitude), lng: locationRound(longitude),
    accuracy: Number.isFinite(accuracy) ? Math.round(accuracy) : null,
    timestamp: Number.isFinite(position.timestamp) ? position.timestamp : Date.now(),
    label: 'Current location', address: '', pincode: '',
  };
  // That a location arrived and how precise it is - never the coordinates
  // (the console is visible to anyone at the screen, and to extensions).
  console.info('siru: browser location received', {accuracy_m: place.accuracy, at: new Date(place.timestamp).toISOString()});
  return place;
}

// The device's position: asks for permission if the browser hasn't decided.
// One request at a time; a second tap waits for the first.
function locationRequestCurrent() {
  if (siruLocation.request) return siruLocation.request;
  const unsupported = locationSupport();
  if (unsupported) {
    siruLocation.permission = 'unsupported';
    siruLocation.error = locationError(unsupported);
    locationNotify();
    return Promise.resolve(null);
  }
  const userId = siruLocation.userId;
  siruLocation.loading = true;
  siruLocation.error = null;
  locationNotify();
  siruLocation.request = new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      position => {
        let place = null;
        try { place = locationFromPosition(position); } catch (err) { siruLocation.error = err; }
        resolve(place);
      },
      failure => {
        // PERMISSION_DENIED 1, POSITION_UNAVAILABLE 2, TIMEOUT 3
        const code = {1: 'denied', 2: 'unavailable', 3: 'timeout'}[failure?.code] || 'unavailable';
        if (code === 'denied') siruLocation.permission = 'denied';
        siruLocation.error = locationError(code);
        resolve(null);
      },
      {enableHighAccuracy: false, timeout: LOCATION_TIMEOUT_MS, maximumAge: LOCATION_MAX_AGE_MS},
    );
  }).then(place => {
    siruLocation.request = null;
    siruLocation.loading = false;
    // Signed out (or another user signed in) while the device was looking.
    if (siruLocation.userId !== userId) return null;
    if (place) {
      siruLocation.permission = 'granted';
      return locationSave(place);
    }
    locationNotify();
    return null;
  });
  return siruLocation.request;
}

// A typed address. Returns an error message, or null when saved.
function locationSetManual({label, address, pincode}) {
  const text = String(address || '').trim().replace(/\s+/g, ' ');
  const pin = String(pincode || '').trim();
  if (!text) return 'Enter the address to deliver to.';
  if (text.length > LOCATION_ADDRESS_MAX) return `Keep the address under ${LOCATION_ADDRESS_MAX} characters.`;
  if (pin && !/^\d{6}$/.test(pin)) return 'A pincode is 6 digits.';
  locationSave({
    source: 'manual', lat: null, lng: null, accuracy: null, timestamp: Date.now(),
    label: LOCATION_LABELS.includes(label) ? label : 'Other', address: text, pincode: pin,
  });
  return null;
}

// Extra query for the catalog: the chosen coordinates, if there are any.
function locationCatalogQuery() {
  const place = siruLocation.place;
  if (!place || place.lat == null || place.lng == null) return '';
  return `&lat=${encodeURIComponent(place.lat)}&lng=${encodeURIComponent(place.lng)}`;
}

// The chosen place for a chat turn (POST /v1/concierge/turn context.location):
// the rounded coordinates the "nearest pharmacy" answers are measured from,
// or a typed address without coordinates. null = no location chosen.
function locationTurnContext() {
  const place = siruLocation.place;
  if (!place) return null;
  if (place.lat == null || place.lng == null) return {source: place.source, address: place.address || ''};
  return {source: place.source, lat: place.lat, lng: place.lng, accuracy_m: place.accuracy ?? null,
    timestamp: place.timestamp ? new Date(place.timestamp).toISOString() : null};
}

// {title, line} for showing the chosen place.
function locationDescribe(place = siruLocation.place) {
  if (!place) return {title: 'No location set', line: 'Set where to deliver to see the nearest pharmacies.'};
  if (place.source === 'device') {
    const accuracy = place.accuracy ? ` · accurate to ~${place.accuracy < 1000 ? `${place.accuracy} m` : `${Math.round(place.accuracy / 100) / 10} km`}` : '';
    return {title: place.label || 'Current location', line: `From your device${accuracy}`};
  }
  return {title: place.label || 'Address', line: [place.address, place.pincode].filter(Boolean).join(' – ')};
}

// A reload of a signed-in tab: the shelf's first load already measures from
// the saved choice (location-ui.js locationStart runs later, on sign-in).
if (currentUserId) locationLoad(currentUserId);

// The address for the bill card: the user's own choice when there is one.
function locationBillAddress() {
  const place = siruLocation.place;
  if (!place) return '';
  if (place.source === 'manual') return [place.address, place.pincode].filter(Boolean).join(' – ');
  return 'Your current location';
}
