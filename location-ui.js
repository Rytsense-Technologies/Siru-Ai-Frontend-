// The location card in the rail and the location dialog (the "blocker"): shown
// after sign-in until the user has a location - their device's, or a typed
// address - and again from "Change". location.js holds the state.
const locEl = Object.fromEntries([
  'locationRow', 'locationRowTitle', 'locationRowLine', 'locationChangeBtn', 'locationDialog', 'locationTitle',
  'locationCloseBtn', 'locationIntro', 'locationStatus', 'locationBlockedHelp', 'locationUseDeviceBtn',
  'locationManualBtn', 'locationManualForm', 'locationLabel', 'locationAddress', 'locationPincode',
  'locationFormError', 'locationFindBtn', 'locationGeocodeResult', 'locationSaved', 'locationRemember',
].map(id => [id, document.getElementById(id)]));

// The user's saved addresses (GET /v1/addresses/me), offered to pick - the
// fallback when the device's location is blocked. Picking one is a choice for
// this tab ("saved address"), never taken as where the user is.
async function locationSavedShow() {
  const box = locEl.locationSaved;
  if (!box || !siruLocation.userId || typeof apiFetch !== 'function') return;
  const userId = siruLocation.userId;
  let saved = [];
  try { saved = (await apiFetch('/v1/addresses/me')).addresses || []; } catch { saved = []; }
  if (siruLocation.userId !== userId) return;
  box.hidden = !saved.length;
  box.replaceChildren(...(saved.length ? [el_('p', 'location-geocode-head', 'Use a saved address')] : []),
    ...saved.map(a => {
      const pick = el_('button', 'ghost-btn location-saved-pick', `${a.label}: ${a.address}`);
      pick.type = 'button';
      pick.onclick = () => {
        locationSave({source: 'saved', lat: a.lat, lng: a.lng, accuracy: null, timestamp: Date.now(), label: a.label,
          address: a.address, pincode: a.pincode || '', mapLabel: a.map_label || '', precision: a.precision || 'area'});
        locationClose();
      };
      return pick;
    }));
}

// A typed address the user ticked "Remember" for: kept on their account.
async function locationRememberSave() {
  const place = siruLocation.place;
  if (!locEl.locationRemember?.checked || !place || place.source !== 'manual') return;
  try {
    await apiFetch('/v1/addresses/me', {method: 'POST', body: JSON.stringify({
      label: place.label === 'Office' ? 'Work' : (place.label || 'Other'), address: place.address,
      pincode: place.pincode || '', lat: place.lat, lng: place.lng, map_label: place.mapLabel || '',
      precision: place.precision || ''})});
    if (typeof addrRefresh === 'function') addrRefresh();
  } catch (err) {
    console.warn('siru: the address could not be saved to your account', err?.status || '');
  }
}

let locationLastPlaceKey = null;

function locationPlaceKey(place) {
  return place ? `${place.source}:${place.lat}:${place.lng}:${place.address}` : '';
}

function locationRender() {
  const {place, loading, error, permission} = siruLocation;
  const {title, line} = locationDescribe(place);
  locEl.locationRowTitle.textContent = title;
  locEl.locationRowLine.textContent = line;

  // Closing is only offered once there is a location to fall back to.
  locEl.locationCloseBtn.hidden = !place;
  locEl.locationTitle.textContent = place ? 'Change delivery location' : 'Set your location to see nearby pharmacies';

  const blocked = permission === 'denied' || error?.code === 'denied';
  const cannot = permission === 'unsupported' || ['unsupported', 'insecure'].includes(error?.code);
  locEl.locationBlockedHelp.hidden = !blocked;
  locEl.locationUseDeviceBtn.hidden = cannot;
  locEl.locationUseDeviceBtn.disabled = loading;
  locEl.locationUseDeviceBtn.textContent = loading ? 'Finding your location…' : blocked ? 'Try again' : 'Use my current location';

  const message = loading ? 'Finding your location…' : error?.message || '';
  locEl.locationStatus.textContent = message;
  locEl.locationStatus.hidden = !message;
  locEl.locationStatus.classList.toggle('location-status-error', Boolean(error) && !loading);

  // A new place re-ranks the shelf from it (the nearest pharmacy per medicine).
  const key = locationPlaceKey(place);
  if (key !== locationLastPlaceKey) {
    const changed = locationLastPlaceKey !== null;
    const lost = Boolean(locationLastPlaceKey) && !place;
    locationLastPlaceKey = key;
    if (changed && pharmacyApi.mode) shoppingLoadCatalog();
    // Still signed in but the location went away (blocked in site settings):
    // ask again. Sign-out clears the user first, so it never lands here.
    if (lost && siruLocation.userId && !locEl.locationDialog.open) locationOpen();
  }
}

function locationOpen({manual = false} = {}) {
  locEl.locationFormError.hidden = true;
  locEl.locationManualForm.hidden = true;
  locationGeocodeClear();
  locationRender();
  if (!locEl.locationDialog.open) locEl.locationDialog.showModal();
  locationSavedShow();
  if (manual) locationManualShow();
}

function locationClose() {
  if (locEl.locationDialog.open) locEl.locationDialog.close();
}

async function locationUseDevice() {
  // Blocked: the browser won't ask again, but the user may have just allowed it.
  await locationPermission();
  if (siruLocation.permission === 'denied') {
    siruLocation.error = locationError('denied');
    locationRender();
    return;
  }
  const place = await locationRequestCurrent();
  if (place) locationClose();
}

// On every sign-in: the user's saved choice, a silent read when the browser
// already allows it, or the dialog. Never a permission prompt by itself.
async function locationStart(userId) {
  locationClose();
  locationLastPlaceKey = null;
  if (!locationLoad(userId)) {
    const permission = await locationPermission();
    if (siruLocation.userId !== userId) return;
    if (permission === 'granted' && await locationRequestCurrent()) return;
    if (siruLocation.userId !== userId) return;
    locationOpen();
  }
  locationRender();
}

function locationEnd(userId) {
  locationClose();
  locationForget(userId);
  locationLastPlaceKey = null;
}

locationSubscribe(locationRender);
locEl.locationChangeBtn.onclick = locationOpen;
locEl.locationCloseBtn.onclick = locationClose;
locEl.locationUseDeviceBtn.onclick = locationUseDevice;
function locationManualShow() {
  locEl.locationManualForm.hidden = false;
  const place = siruLocation.place;
  if (place?.source === 'manual') {
    locEl.locationLabel.value = place.label;
    locEl.locationAddress.value = place.address;
    locEl.locationPincode.value = place.pincode;
  }
  locEl.locationAddress.focus();
}
locEl.locationManualBtn.onclick = locationManualShow;

function locationFormError(message) {
  locEl.locationFormError.textContent = message || '';
  locEl.locationFormError.hidden = !message;
}

function locationGeocodeClear() {
  locEl.locationGeocodeResult.replaceChildren();
  locEl.locationGeocodeResult.hidden = true;
}

// The places found for the typed address, for the user to confirm one -
// nothing is saved until they do. Editing the address forgets them.
function locationGeocodeShow(fields, places) {
  const box = locEl.locationGeocodeResult;
  const list = el_('div', 'location-geocode-list');
  list.setAttribute('role', 'radiogroup');
  list.setAttribute('aria-label', 'Places found for this address');
  places.forEach((place, i) => {
    const option = el_('label', 'location-geocode-option');
    const radio = el_('input');
    radio.type = 'radio';
    radio.name = 'locationGeocodePick';
    radio.value = String(i);
    radio.checked = i === 0;
    const text = el_('span', 'location-geocode-text');
    text.append(el_('strong', '', place.label));
    const note = locationPrecisionNote(place.precision);
    if (note) text.append(el_('span', 'muted small', note));
    option.append(radio, text);
    list.append(option);
  });
  const use = el_('button', 'location-geocode-use', places.length > 1 ? 'Use the selected place' : 'Use this place');
  use.type = 'button';
  use.onclick = () => {
    const picked = list.querySelector('input[name="locationGeocodePick"]:checked');
    const error = locationSetManual(fields, places[Number(picked?.value || 0)]);
    locationFormError(error);
    if (!error) {
      locationRememberSave();
      locationGeocodeClear();
      locationClose();
    }
  };
  box.replaceChildren(
    el_('p', 'location-geocode-head', places.length > 1 ? 'Which of these is it?' : 'Is this the place?'), list, use,
    el_('p', 'muted small', "Not it? Change the address (add the area, city or pincode) and press Find on map again."));
  box.hidden = false;
  use.focus();
}

locEl.locationManualForm.addEventListener('submit', async event => {
  event.preventDefault();
  const fields = {
    label: locEl.locationLabel.value, address: locEl.locationAddress.value, pincode: locEl.locationPincode.value,
  };
  const invalid = locationAddressError(fields);
  locationFormError(invalid);
  locationGeocodeClear();
  if (invalid) return;
  const userId = siruLocation.userId;
  locEl.locationFindBtn.disabled = true;
  locEl.locationFindBtn.textContent = 'Finding it on the map…';
  let places = null;
  try {
    places = await locationGeocode(fields);
  } catch (err) {
    // The lookup failed: said so - nothing saved, no place assumed.
    locationFormError(err?.status === 503
      ? "Address lookup isn't available right now. Use your current location, or try again shortly."
      : `Couldn't look up the address. ${typeof pharmacyError === 'function' ? pharmacyError(err) : ''}`.trim());
  } finally {
    locEl.locationFindBtn.disabled = false;
    locEl.locationFindBtn.textContent = 'Find on map';
  }
  if (places === null || siruLocation.userId !== userId) return;
  if (!places.length) {
    locationFormError("We couldn't find this address on the map. Check the spelling or add the 6-digit pincode - "
      + 'or use your current location.');
    return;
  }
  locationGeocodeShow(fields, places);
});
for (const input of [locEl.locationAddress, locEl.locationPincode]) input.addEventListener('input', locationGeocodeClear);
// Esc must not skip past a required location.
locEl.locationDialog.addEventListener('cancel', event => { if (!siruLocation.place) event.preventDefault(); });
// Back from the browser's site settings: read the permission again (no prompt).
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !locEl.locationDialog.open || !siruLocation.userId) return;
  const before = siruLocation.permission;
  if (await locationPermission() !== before) locationRender();
});
