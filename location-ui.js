// The location card in the rail and the location dialog (the "blocker"): shown
// after sign-in until the user has a location - their device's, or a typed
// address - and again from "Change". location.js holds the state.
const locEl = Object.fromEntries([
  'locationRow', 'locationRowTitle', 'locationRowLine', 'locationChangeBtn', 'locationDialog', 'locationTitle',
  'locationCloseBtn', 'locationIntro', 'locationStatus', 'locationBlockedHelp', 'locationUseDeviceBtn',
  'locationManualBtn', 'locationManualForm', 'locationLabel', 'locationAddress', 'locationPincode',
  'locationFormError',
].map(id => [id, document.getElementById(id)]));

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

function locationOpen() {
  locEl.locationFormError.hidden = true;
  locEl.locationManualForm.hidden = true;
  locationRender();
  if (!locEl.locationDialog.open) locEl.locationDialog.showModal();
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
locEl.locationManualBtn.onclick = () => {
  locEl.locationManualForm.hidden = false;
  const place = siruLocation.place;
  if (place?.source === 'manual') {
    locEl.locationLabel.value = place.label;
    locEl.locationAddress.value = place.address;
    locEl.locationPincode.value = place.pincode;
  }
  locEl.locationAddress.focus();
};
locEl.locationManualForm.addEventListener('submit', event => {
  event.preventDefault();
  const error = locationSetManual({
    label: locEl.locationLabel.value, address: locEl.locationAddress.value, pincode: locEl.locationPincode.value,
  });
  locEl.locationFormError.textContent = error || '';
  locEl.locationFormError.hidden = !error;
  if (!error) locationClose();
});
// Esc must not skip past a required location.
locEl.locationDialog.addEventListener('cancel', event => { if (!siruLocation.place) event.preventDefault(); });
// Back from the browser's site settings: read the permission again (no prompt).
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !locEl.locationDialog.open || !siruLocation.userId) return;
  const before = siruLocation.permission;
  if (await locationPermission() !== before) locationRender();
});
