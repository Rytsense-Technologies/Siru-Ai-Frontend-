// The active location is the one the user chose, and the pharmacy is the one
// the user picked:
//   - a typed address is placed on the map by the server's geocoder and saved
//     only once the user confirms the place found (its own coordinates);
//   - nothing found, or the lookup down: nothing saved, never a default place;
//   - the "Nearby pharmacies" screen measures from the active location's own
//     coordinates and never reads the device's GPS behind a typed address;
//   - a new location measures the list again;
//   - a missing GPS permission is said, with a way forward - no location assumed;
//   - an older pharmacy card's Add never adds (its offer is gone).
// The page's own code runs; only the API (geocoder, nearby stores) and the
// browser's geolocation are stood in for.
const { test, expect } = require('@playwright/test');

const ARAKKONAM = {lat: 13.08398, lng: 79.67009, precision: 'town', matched: 'pincode', postcode: '631001',
  label: 'Arakkonam, Arakonam, Ranipet, Tamil Nadu, 631001, India'};
const CHENNAI = {lat: 12.9352, lng: 80.2108, precision: 'locality', matched: 'address', postcode: '600100',
  label: 'Pallikaranai, Chennai, Tamil Nadu, 600100, India'};

let api;  // what the page asked the API, and what it answers

test.beforeEach(async ({ page }) => {
  api = {geocode: [], nearby: [], places: [ARAKKONAM], geocodeStatus: 200};
  const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'};
  await page.route(url => url.pathname.startsWith('/v1/'), async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    if (path === '/v1/pharmacy/geocode') {
      api.geocode.push(request.postDataJSON());
      if (api.geocodeStatus !== 200) {
        return route.fulfill({status: api.geocodeStatus, headers: cors, json: {detail: "Address lookup isn't available right now."}});
      }
      return route.fulfill({headers: cors, json: {places: api.places}});
    }
    if (path === '/v1/pharmacy/stores/nearby') {
      const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'));
      api.nearby.push({lat, lng});
      // Distances are the server's (measured there): a fixed one per origin here.
      const km = lat > 13 ? 62.4 : 0.3;
      return route.fulfill({headers: cors, json: {origin: {lat, lng}, unlocated: 0, stores: [
        {id: 'store-arun', name: 'Arun Medicals', distanceKm: km, etaMin: 'eta' in api ? api.eta : 20, area: 'Chennai',
         address: 'Pallikaranai Main Road, Chennai, 600100', deliversHere: km <= 15, isOpen: true}]}});
    }
    return route.abort();
  });
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  await page.evaluate(() => {
    // The browser's geolocation: every call recorded; answers what the test says.
    window.gpsCalls = 0;
    window.gpsAnswer = {error: 1};  // PERMISSION_DENIED unless a test says otherwise
    navigator.geolocation.getCurrentPosition = (ok, fail) => {
      gpsCalls += 1;
      if (gpsAnswer.error) fail({code: gpsAnswer.error});
      else ok({coords: {latitude: gpsAnswer.lat, longitude: gpsAnswer.lng, accuracy: 20}, timestamp: Date.now()});
    };
    window.signInAs = async id => {
      authSave({access_token: `token-${id}`, expires_at: Date.now() / 1000 + 3600, user: {id, role: 'buyer', name: id}});
      await applySignedInUser();
      // The location prompt opens a moment after sign-in (location-ui.js locationStart): wait for it, then close it.
      for (let i = 0; i < 40 && !locEl.locationDialog.open; i++) await new Promise(resolve => setTimeout(resolve, 50));
      document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    };
  });
});

async function typeAddress(page, address, pincode = '') {
  await page.evaluate(() => locationOpen({manual: true}));
  await page.fill('#locationAddress', address);
  await page.fill('#locationPincode', pincode);
  await page.click('#locationFindBtn');
}

test('a typed Arakkonam address is placed on the map, confirmed, and saved with its own coordinates', async ({ page }) => {
  await page.evaluate(() => signInAs('buyer-a'));
  await typeAddress(page, '#1/15, Gandhi Road, Palanipet, Arakkonam', '631001');
  const result = page.locator('#locationGeocodeResult');
  await expect(result).toBeVisible();
  await expect(result).toContainText('Arakkonam, Arakonam, Ranipet, Tamil Nadu, 631001, India');
  await expect(result).toContainText('Placed at the town centre - distances are approximate.');  // how precise, said
  expect(await page.evaluate(() => siruLocation.place)).toBeNull();  // nothing saved before confirming
  await result.getByRole('button', {name: 'Use this place'}).click();
  const place = await page.evaluate(() => siruLocation.place);
  expect(place).toMatchObject({source: 'manual', lat: 13.084, lng: 79.67, address: '#1/15, Gandhi Road, Palanipet, Arakkonam',
    pincode: '631001', precision: 'town'});
  expect(api.geocode).toEqual([{address: '#1/15, Gandhi Road, Palanipet, Arakkonam', pincode: '631001'}]);
  await expect(page.locator('#locationRowLine')).toContainText('Gandhi Road, Palanipet, Arakkonam – 631001 · approximate');
  // The chat turn carries those coordinates - not a device fix, not a default.
  expect(await page.evaluate(() => locationTurnContext())).toMatchObject({source: 'manual', lat: 13.084, lng: 79.67});
  expect(await page.evaluate(() => gpsCalls)).toBe(0);
});

test('an address the map doesn\'t know, or a lookup that fails, saves nothing', async ({ page }) => {
  await page.evaluate(() => signInAs('buyer-a'));
  api.places = [];
  await typeAddress(page, 'Nowhere Street, Atlantis');
  await expect(page.locator('#locationFormError')).toContainText("couldn't find this address on the map");
  expect(await page.evaluate(() => siruLocation.place)).toBeNull();
  api.geocodeStatus = 503;
  await page.click('#locationFindBtn');
  await expect(page.locator('#locationFormError')).toContainText("Address lookup isn't available right now");
  expect(await page.evaluate(() => [siruLocation.place, gpsCalls])).toEqual([null, 0]);
});

test('the nearby screen measures from the confirmed address and never reads GPS behind it', async ({ page }) => {
  await page.evaluate(() => signInAs('buyer-a'));
  await typeAddress(page, '#1/15, Gandhi Road, Palanipet, Arakkonam', '631001');
  await page.locator('#locationGeocodeResult').getByRole('button', {name: 'Use this place'}).click();
  await page.click('#shopNearbyBtn');
  await expect(page.locator('#shopBody')).toContainText('Arun Medicals');
  await expect(page.locator('#shopBody')).toContainText('62.4 km away (straight line)');  // the server's distance from Arakkonam - not a road distance
  await expect(page.locator('#shopSub')).toContainText('Measured from Home: #1/15, Gandhi Road, Palanipet, Arakkonam');
  expect(api.nearby).toEqual([{lat: 13.084, lng: 79.67}]);
  expect(await page.evaluate(() => gpsCalls)).toBe(0);
});

test('a new location measures the open list again', async ({ page }) => {
  await page.evaluate(() => signInAs('buyer-a'));
  await typeAddress(page, '#1/15, Gandhi Road, Palanipet, Arakkonam', '631001');
  await page.locator('#locationGeocodeResult').getByRole('button', {name: 'Use this place'}).click();
  await page.click('#shopNearbyBtn');
  await expect(page.locator('#shopBody')).toContainText('62.4 km away');
  // Another confirmed address while the list is open (as "Use my current location" there would).
  await page.evaluate(place => locationSetManual({label: 'Office', address: 'Pallikaranai Main Road, Chennai', pincode: '600100'}, place), CHENNAI);
  await expect(page.locator('#shopBody')).toContainText('0.3 km away');
  expect(api.nearby).toEqual([{lat: 13.084, lng: 79.67}, {lat: 12.935, lng: 80.211}]);
});

test('an address saved without map coordinates is never measured with the device GPS', async ({ page }) => {
  await page.evaluate(() => signInAs('buyer-a'));
  // An address saved by an older version (no coordinates).
  await page.evaluate(() => locationSave({source: 'manual', lat: null, lng: null, accuracy: null, timestamp: Date.now(),
    label: 'Home', address: '#1/15, Gandhi Road, Palanipet', pincode: ''}));
  await expect(page.locator('#locationRowLine')).toContainText('not on the map yet');
  await page.click('#shopNearbyBtn');
  await expect(page.locator('#shopBody')).toContainText('Confirm your address on the map');
  expect(await page.evaluate(() => gpsCalls)).toBe(0);
  expect(api.nearby).toEqual([]);
  expect(await page.evaluate(() => siruLocation.place.address)).toBe('#1/15, Gandhi Road, Palanipet');  // kept, not replaced
});

test('a blocked GPS permission is said, with a way forward - no location assumed', async ({ page }) => {
  await page.evaluate(() => signInAs('buyer-a'));
  await page.click('#shopNearbyBtn');
  await expect(page.locator('#shopBody')).toContainText('Set your delivery location');
  expect(await page.evaluate(() => gpsCalls)).toBe(0);  // not even asked until the user taps
  await page.locator('#shopBody').getByRole('button', {name: 'Use my current location'}).click();
  await expect(page.locator('#shopBody')).toContainText('Location is blocked for this site');
  await expect(page.locator('#shopBody').getByRole('button', {name: 'Enter an address'})).toBeVisible();
  expect(await page.evaluate(() => [gpsCalls, siruLocation.place])).toEqual([1, null]);
  expect(api.nearby).toEqual([]);
});

test('another user on the device never gets this user\'s location', async ({ page }) => {
  await page.evaluate(() => signInAs('buyer-a'));
  await typeAddress(page, '#1/15, Gandhi Road, Palanipet, Arakkonam', '631001');
  await page.locator('#locationGeocodeResult').getByRole('button', {name: 'Use this place'}).click();
  await page.evaluate(async () => { try { await signOut(); } catch {} });  // the real sign-out
  await page.evaluate(() => signInAs('buyer-b'));
  expect(await page.evaluate(() => [siruLocation.userId, siruLocation.place])).toEqual(['buyer-b', null]);
});

test('only the latest pharmacy card adds - an older one\'s offer is gone', async ({ page }) => {
  await page.evaluate(() => signInAs('buyer-a'));
  const sent = await page.evaluate(() => {
    window.sentCommands = [];
    window.shoppingSubmit = async text => { sentCommands.push(text); };
    const card = name => ({kind: 'pharmacy_offer', pharmacy: {name, distanceKm: 0.3},
      product: {id: `dolo-${name}`, name: 'Dolo 650', pricePaise: 3360, inStock: true}, alternatives: []});
    for (const name of ['Arun Medicals', 'Jeeva Medicals']) shopEl.chatMessages.append(shoppingOfferCard(card(name), Date.now()));
    const [older, latest] = shopEl.chatMessages.querySelectorAll('.offer-card .card-action');
    older.click();
    latest.click();
    return {commands: sentCommands, olderDisabled: older.disabled, eyebrow: shopEl.chatMessages.querySelector('.offer-card .card-eyebrow').textContent};
  });
  expect(sent.commands).toEqual(['Add it to my cart']);  // the latest offer, as "yes" - not "Add Dolo 650" re-picked
  expect(sent.olderDisabled).toBe(true);
  expect(sent.eyebrow).toBe('Your pharmacy');
});

// Missing values are "—" in their place - never invented, never "null"/"undefined"/"0 km"
// (the store's delivery time and delivery charge are the client database's own).
test('a pharmacy without a recorded delivery time keeps its row and shows a dash', async ({ page }) => {
  api.eta = null;
  await page.evaluate(() => signInAs('buyer-a'));
  await typeAddress(page, '#1/15, Gandhi Road, Palanipet, Arakkonam', '631001');
  await page.locator('#locationGeocodeResult').getByRole('button', {name: 'Use this place'}).click();
  await page.click('#shopNearbyBtn');
  const body = page.locator('#shopBody');
  await expect(body).toContainText('Arun Medicals');
  await expect(body).toContainText('62.4 km away (straight line) · delivery time —');
  for (const bad of ['null', 'undefined', 'NaN', '~0 min']) await expect(body).not.toContainText(bad);
});

test('a delivery charge the pharmacy does not record is a dash, never "Free" or a made-up fee', async ({ page }) => {
  const text = await page.evaluate(() => {
    const items = [{name: 'Cetirizine 10 mg', qty: 1, price_paise: 2200, line_paise: 2200, pack: '10 tablets'}];
    cartBillRender({items, store: 'Arun Medicals', subtotal_paise: 2200, delivery_paise: null, total_paise: 2200});
    const known = shoppingBillCard({items, store: 'Arun Medicals', subtotal_paise: 2200, delivery_paise: 0, total_paise: 2200});
    const unknown = shoppingBillCard({items, store: 'Arun Medicals', subtotal_paise: 2200, delivery_paise: null, total_paise: 2200});
    return {cart: shopEl.cartBill.textContent, known: known.textContent, unknown: unknown.textContent};
  });
  expect(text.cart).toContain('Delivery—');
  expect(text.unknown).toContain('Delivery—');
  expect(text.known).toContain('DeliveryFree');
  for (const said of [text.cart, text.unknown]) {
    expect(said).not.toContain('Free');
    expect(said).not.toContain('₹30');
    expect(said).not.toContain('null');
  }
});
