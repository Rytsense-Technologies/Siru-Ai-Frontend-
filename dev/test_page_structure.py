"""The pharmacy page's structure (index.html + its CSS and scripts). Standard
library only:

    python -m unittest discover -s dev -p "test_*.py"

  * the conversation is the page: no persistent cart / order panel beside it -
    the cart and checkout are a dialog opened when needed (shopping.js);
  * the Voice ID and Delivery contact panels are gone, with their code and CSS;
  * every element the scripts look up by id is on the page, and every script
    and stylesheet the page loads exists.
"""
from __future__ import annotations

import re
import unittest
from html.parser import HTMLParser
from pathlib import Path

FRONTEND = Path(__file__).resolve().parents[1]


class _Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids: dict[str, list[str]] = {}  # id -> the ids of its enclosing elements
        self.order: list[str] = []  # every id, in document order
        self.tags: dict[str, list[str]] = {}  # id -> the tags (and classes) enclosing it
        self.classes: set[str] = set()
        self.assets: list[str] = []
        self._stack: list[tuple[str, str]] = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        ancestors = [i for _, i in self._stack if i]
        if attrs.get("id"):
            self.ids[attrs["id"]] = ancestors
            self.order.append(attrs["id"])
            self.tags[attrs["id"]] = [t for t, _ in self._stack]
        self.classes.update((attrs.get("class") or "").split())
        if tag == "script" and attrs.get("src"):
            self.assets.append(attrs["src"])
        if tag == "link" and attrs.get("rel") == "stylesheet" and not attrs["href"].startswith("http"):
            self.assets.append(attrs["href"])
        if tag not in ("meta", "link", "input", "img", "br", "hr", "source", "progress"):
            self._stack.append((tag if tag != "header" else f"header.{attrs.get('class', '')}", attrs.get("id", "")))

    def handle_endtag(self, tag):
        while self._stack:
            if self._stack.pop()[0] == tag:
                break


def _page() -> _Page:
    page = _Page()
    page.feed((FRONTEND / "index.html").read_text(encoding="utf-8"))
    return page


class PageStructureTest(unittest.TestCase):
    def test_no_persistent_cart_or_order_panel_beside_the_conversation(self):
        page = _page()
        self.assertNotIn("rail", page.classes)
        self.assertNotIn("cart-card", page.classes)
        for element in ("cartItems", "cartTotal", "placeOrderBtn", "clearCartBtn", "cartOrdersBtn", "cartConfirm"):
            self.assertIn("cartDialog", page.ids[element], f"{element} must be inside the cart dialog")
        # Location | Nearby pharmacies | Cart | Orders, one compact row of chips.
        for chip in ("locationRow", "shopNearbyBtn", "cartBtn", "ordersBtn"):
            self.assertIn("contextRow", page.ids[chip], f"{chip} belongs in the context row")
        self.assertIn("cartCount", page.ids)

    def test_the_context_row_is_in_the_top_bar_between_the_bell_and_the_profile(self):
        page = _page()
        self.assertIn("header.topbar", page.tags["contextRow"])
        self.assertNotIn("appView", page.ids["contextRow"])  # not also under the conversation
        self.assertEqual(page.order.count("contextRow"), 1)
        order = page.order
        self.assertLess(order.index("notifBell"), order.index("contextRow"))
        self.assertLess(order.index("contextRow"), order.index("userMenu"))

    def test_the_header_keeps_tool_calls_memory_and_the_bell(self):
        page = _page()
        for control in ("activityBtn", "activityCountTop", "memoryBtn", "memoryCountTop", "notifBell"):
            self.assertIn(control, page.ids)
        css = "".join(p.read_text(encoding="utf-8") for p in FRONTEND.glob("*.css"))
        self.assertNotRegex(css, r"\.activity-btn span\s*\{\s*display:\s*none")  # labels and icons stay visible

    def test_the_memory_tab_keeps_cart_orders_and_personal_memory_apart(self):
        page = _page()
        for section in ("memoryCart", "memoryOrders", "memoryList", "stmSummary"):
            self.assertIn("memoryTab", page.ids[section])

    def test_the_voice_id_and_delivery_contact_panels_are_gone(self):
        page = _page()
        for gone in ("voiceIdEnrol", "voiceIdStatus", "voiceIdDelete", "emailInput", "phoneInput",
                     "saveEmailBtn", "savePhoneBtn", "testSmsBtn", "emailChannelPill", "phoneChannelPill"):
            self.assertNotIn(gone, page.ids)
        self.assertFalse((FRONTEND / "voiceid.js").exists())
        self.assertFalse(any("voiceid" in asset for asset in page.assets))
        scripts = "".join(p.read_text(encoding="utf-8") for p in FRONTEND.glob("*.js"))
        for gone in ("voiceIdRefresh", "refreshContactStatus", "setChannelPill", "emailInput", "testSmsBtn"):
            self.assertNotIn(gone, scripts)
        css = "".join(p.read_text(encoding="utf-8") for p in FRONTEND.glob("*.css"))
        for gone in (".rail", "--rail", ".voiceid-", ".channels-row", ".shop-entry", ".info-grid", ".pay-btn"):
            self.assertNotIn(gone, css)

    def test_every_asset_the_page_loads_exists(self):
        for asset in _page().assets:
            if asset.startswith(("http://", "https://")):
                continue  # the LiveKit client, from its CDN
            self.assertTrue((FRONTEND / asset.split("?")[0]).is_file(), asset)

    def test_no_two_page_scripts_declare_the_same_top_level_name(self):
        """Classic scripts share one global scope: a second `const X` stops
        that whole script from loading (node --check can't see it)."""
        declared: dict[str, list[str]] = {}
        for asset in _page().assets:
            if asset.startswith(("http://", "https://")) or not asset.split("?")[0].endswith(".js"):
                continue
            text = (FRONTEND / asset.split("?")[0]).read_text(encoding="utf-8")
            for name in re.findall(r"^(?:const|let|var|class|function|async function)\s+([A-Za-z_$][\w$]*)", text, flags=re.M):
                declared.setdefault(name, []).append(asset)
        self.assertEqual({name: files for name, files in declared.items() if len(files) > 1}, {})

    def test_every_id_the_scripts_look_up_is_on_the_page(self):
        ids = set(_page().ids)
        missing = set()
        for script in ("shopping.js", "app.js", "user-menu.js", "location-ui.js", "memory.js", "shop-flow.js",
                       "merchant.js"):
            text = (FRONTEND / script).read_text(encoding="utf-8")
            wanted = set(re.findall(r"getElementById\(['\"]([A-Za-z][\w-]*)['\"]\)", text))
            # shopping.js / location-ui.js list their ids in an array
            for block in re.findall(r"Object\.fromEntries\(\[(.*?)\]\.map", text, flags=re.S):
                wanted |= set(re.findall(r"['\"]([A-Za-z][\w-]*)['\"]", block))
            # An element the script creates itself and looks up again to replace it (merchant.js
            # "#merchantStorePicker", built at run time per store list) is not the page's to declare.
            created = set(re.findall(r"\.id\s*=\s*['\"]([A-Za-z][\w-]*)['\"]", text))
            missing |= {f"{script}: {i}" for i in wanted - ids - created}
        # Known and older than this test: app.js's unused "demo panel" code
        # (loadProducts - never called) still looks up #productList.
        self.assertEqual(missing - {"app.js: productList"}, set())

    def test_the_merchant_assistant_has_a_microphone_on_the_same_voice_path(self):
        page = _page()
        self.assertIn("merchantForm", page.ids["merchantMicBtn"])
        merchant = (FRONTEND / "merchant.js").read_text(encoding="utf-8")
        app = (FRONTEND / "app.js").read_text(encoding="utf-8")
        # One call path: merchant.js starts app.js's voice session, no second LiveKit client of its own.
        self.assertIn("startVoiceSession()", merchant)
        self.assertNotIn("LivekitClient", merchant)
        self.assertIn("merchantVoiceSurface", app)

    def test_cart_and_order_windows_open_only_when_asked(self):
        """A cart or order answer is a chat card; the Cart / Orders window
        opens on an explicit "open" (the open_view card) or a button click."""
        shopping = (FRONTEND / "shopping.js").read_text(encoding="utf-8")
        for automatic in ("cartDialogShow({note: 'Your cart changed", "cartDialogShow({note: 'Check it, then confirm",
                          "      orderDialogShow(snapshot);"):
            self.assertNotIn(automatic, shopping)
        self.assertIn("card?.kind === 'open_view'", shopping)
        for kind in ("cart_summary:", "order_list:", "open_view:"):
            self.assertIn(kind, shopping)

    def test_a_stalled_request_or_stream_ends_the_turn_instead_of_hanging(self):
        """A hung request (a stalled connection) must not leave the chat busy
        for good: requests time out, and a stream that goes quiet is cancelled
        and the turn fails with a message (seen live: a 45 s turn)."""
        app = (FRONTEND / "app.js").read_text(encoding="utf-8")
        api = (FRONTEND / "pharmacy-api.js").read_text(encoding="utf-8")
        self.assertIn("const API_TIMEOUT_MS", app)
        self.assertIn("new AbortController()", app)
        self.assertIn("signal: controller.signal", api)
        self.assertIn("reader.cancel()", api)
        self.assertIn("stalled();", api)
        page = _page()
        self.assertIn("askInput", page.ids)
        html = (FRONTEND / "index.html").read_text(encoding="utf-8")
        self.assertRegex(html, r'id="askInput"[^>]*maxlength="2000"')

    def test_the_local_merchant_sign_in_lists_the_databases_merchants(self):
        """Local development only: the merchant sign-in's stores come from the
        API (GET /v1/auth/demo-merchants - the client database's owners); none
        is written into the page or the scripts."""
        page = _page()
        for element in ("demoMerchants", "demoMerchantsNote", "demoMerchantSelect", "demoMerchantBtn",
                        "demoMerchantError"):
            self.assertIn(element, page.ids)
        html = (FRONTEND / "index.html").read_text(encoding="utf-8")
        self.assertRegex(html, r'<details id="demoMerchants"[^>]*\bhidden\b')  # shown only when the API has it
        menu = (FRONTEND / "user-menu.js").read_text(encoding="utf-8")
        self.assertIn("/v1/auth/demo-merchants`", menu)
        self.assertIn("/v1/auth/demo-merchants/login", menu)
        self.assertIn("if (res.status === 404) return;", menu)
        # Never on the customer sign-in: only the merchant entry page (/?merchant) lists merchants.
        self.assertIn("const MERCHANT_ENTRY = new URLSearchParams(location.search).has('merchant');", menu)
        self.assertIn("if (!box || !MERCHANT_ENTRY) return;", menu)
        store_name = re.compile(r"""['"`](?:[A-Z][a-z]+ )+(?:Pharmacy|Medicals|Medical|Chemists?)['"`]""")
        for script in FRONTEND.glob("*.js"):
            self.assertEqual(store_name.findall(script.read_text(encoding="utf-8")), [], script.name)

    def test_the_profile_menu_closes_like_a_menu(self):
        """The profile menu is a <details>: it stayed open over the page. It
        closes on a click elsewhere and on Escape - and never runs off a
        small screen."""
        menu = (FRONTEND / "user-menu.js").read_text(encoding="utf-8")
        self.assertIn("!loginEl.userMenu.contains(event.target)) loginEl.userMenu.open = false;", menu)
        self.assertIn("event.key === 'Escape' && loginEl.userMenu.open", menu)
        css = (FRONTEND / "style.css").read_text(encoding="utf-8")
        self.assertIn("width: min(320px, calc(100vw - 24px)); max-height: calc(100vh - 80px); overflow-y: auto;", css)

    def test_there_is_no_language_to_choose(self):
        """Siru answers each message in the language it is written or spoken
        in (backend: supervisor reply_language, voice STT): no assistant
        language selector, no "Replies in ..." line, no saved choice, and no
        chosen language sent with a chat turn or a voice session."""
        page = _page()
        self.assertNotIn("languageSelect", page.ids)
        html = (FRONTEND / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("Assistant language", html)
        scripts = {p.name: p.read_text(encoding="utf-8") for p in FRONTEND.glob("*.js")}
        for name, source in scripts.items():
            for obsolete in ("ASSISTANT_LANGUAGES", "userLanguage(", "Replies in ", "languageSelect",
                             "preferred_language", "locale:currentProfile", "language_code: language"):
                self.assertNotIn(obsolete, source, f"{name}: {obsolete}")
        self.assertIn("key.startsWith('siru_language_')) localStorage.removeItem(key)", scripts["users.js"])

    def test_conversations_are_kept_per_tab_not_on_the_device(self):
        """Live E2E (12 Oct): the chat (health details too) and the Inspector's
        activity stayed in localStorage after the tab closed. They are kept per
        tab (sessionStorage), like the login token; transcripts an older build
        left in localStorage are removed on load. tests/sign-in-history.spec.cjs
        checks the behaviour in a browser."""
        users = (FRONTEND / "users.js").read_text(encoding="utf-8")
        shopping = (FRONTEND / "shopping.js").read_text(encoding="utf-8")
        for line in ("userRead(`siru_sessions_${id}`, [], sessionStorage)",
                     "userRead(chatKey(id, sessionId), [], sessionStorage)",
                     "userWrite(chatKey(id, sessionId), messages, sessionStorage);",
                     "userDropLegacyTranscripts();"):
            self.assertIn(line, users)
        self.assertIn("const TRANSCRIPT_PREFIXES = ['siru_chat_', 'siru_sessions_', 'siru_activity_'];", users)
        reads = re.findall(r"userRead\(activityKey\(\), \[\][^)]*\)", shopping)
        writes = re.findall(r"userWrite\(activityKey\(\),[^\n]*", shopping)
        self.assertTrue(reads and writes)
        for call in reads + writes:
            self.assertIn("sessionStorage", call, call)

    def test_voice_listens_only_once_the_assistant_has_joined(self):
        """Speech before the voice worker joins the room is heard by nobody:
        the page says it is connecting until the assistant is in the call."""
        app = (FRONTEND / "app.js").read_text(encoding="utf-8")
        self.assertIn('setVoiceStatus(agentJoined ? "Listening - speak anytime" : "Connecting to Siru...");', app)
        self.assertIn('if (micLive && room === voiceRoom && !micMuted) setVoiceStatus("Listening - speak anytime");', app)
        self.assertIn("Microphone permission denied. Allow microphone access in the browser and try again.", app)
        # No assistant in the room (LiveKit dispatches a room once): one automatic retry in a new room.
        self.assertIn("if (!voiceJoinRetried) {", app)
        self.assertIn("voiceLog('assistant not joined - retrying once in a new room');", app)

    def test_the_pharmacy_screens_call_the_production_api_not_the_sandbox(self):
        """/v1/sandbox is development-only on the backend (404 in production:
        "Pharmacy offline"); the products, nearby stores, cart and orders
        screens call /v1/pharmacy."""
        calls = {}
        for script in FRONTEND.glob("*.js"):
            text = script.read_text(encoding="utf-8")
            self.assertNotIn("/v1/sandbox", text, script.name)
            calls[script.name] = text
        joined = "\n".join(calls.values())
        for route in ("/v1/pharmacy/products", "/v1/pharmacy/stores/nearby", "/v1/pharmacy/cart/",
                      "/v1/pharmacy/orders/"):
            self.assertIn(route, joined)


    def test_a_photo_is_previewed_and_sent_only_on_send(self):
        """A pasted (Ctrl+V) or picked photo waits above the input - with a
        remove button - and goes only on Send, as a streamed turn (the
        inspector sees its tools and tables). Unsupported or oversized files
        are refused with a message. It used to go at once, with no preview,
        to a prescription-only endpoint, and a paste did nothing."""
        page = _page()
        for element in ("attachPreview", "attachImg", "attachRemove", "rxFile"):
            self.assertIn(element, page.ids)
        shopping = (FRONTEND / "shopping.js").read_text(encoding="utf-8")
        self.assertIn("el.askInput.addEventListener('paste'", shopping)
        self.assertIn("i.kind === 'file' && i.type.startsWith('image/')", shopping)
        self.assertIn("photoAttach(item.getAsFile())", shopping)
        self.assertIn("rxEl.file.onchange = () => {", shopping)
        self.assertRegex(shopping, r"rxEl\.file\.onchange = \(\) => \{[^}]*photoAttach\(file\);")
        self.assertIn("const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);", shopping)
        self.assertIn("if (!PHOTO_TYPES.has(file.type))", shopping)
        self.assertIn("if (file.size > PHOTO_MAX_BYTES)", shopping)
        self.assertIn("rxEl.remove.onclick = () => { photoClear();", shopping)
        api = (FRONTEND / "pharmacy-api.js").read_text(encoding="utf-8")
        # The photo and the text typed with it ("order these from Apollo") are ONE upload turn: the
        # text rides in the same input, and that input is what the turn sends.
        self.assertIn("const input = {type:'upload', image_b64:imageB64, mime_type:mimeType};", api)
        self.assertIn("if (text) input.text = text;", api)
        self.assertRegex(api, r"async photo\([^)]*text = ''\)[\s\S]*?concierge\.turn\(\{[^}]*\binput, history:\[\]")
        self.assertNotIn("/v1/concierge/prescriptions/extract", shopping)
        self.assertRegex(shopping, r"pharmacyApi\.photo\(image, file\.type, step => \{[\s\S]*?\}, text\);")
        app = (FRONTEND / "app.js").read_text(encoding="utf-8")
        self.assertIn("const photo = photoPending?.file || null;", app)
        # Sent with the photo, the text is not sent again as a turn of its own.
        self.assertRegex(app, r"await shoppingSendPhoto\(photo, userInput\);\s*return;")

    def test_a_confirm_is_a_traced_turn_and_its_outcome_survives_a_reload(self):
        """Confirm / Cancel on a prepared action go as a "tap" turn, so the
        order it writes (this app's own records) shows in the inspector - the
        REST call left no trace. The outcome is kept on the card in the chat's
        history: after a reload a decided card shows it, not live buttons."""
        shopping = (FRONTEND / "shopping.js").read_text(encoding="utf-8")
        self.assertIn("input: {type: 'tap', action_id: card.actionId, decision}", shopping)
        self.assertIn("answer.cards.find(c => c.kind === 'action_result')", shopping)
        self.assertIn("shoppingActivityAdd({id: crypto.randomUUID(), record: {", shopping)
        self.assertEqual(shopping.count("confirmCardSettle(card.actionId, status.textContent);"), 3)
        self.assertIn("if (card.settled) {  // decided earlier in this chat: its outcome, no buttons", shopping)

    def test_a_turn_with_a_failed_step_is_not_called_completed(self):
        """A step the server reported failed (the model unreachable, a tool error) is not a completed turn: the
        activity title says "Finished with problems", live and restored, and the inspector's direct tool row shows
        its failed status - it showed no badge, and the turn read "Completed" (10 Oct)."""
        shopping = (FRONTEND / "shopping.js").read_text(encoding="utf-8")
        self.assertIn("failed ? 'Stopped' : problems ? 'Finished with problems' : 'Completed';", shopping)
        self.assertIn("record.status === 'failed' ? 'Stopped' : problems ? 'Finished with problems' : 'Completed';",
                      shopping)
        self.assertNotIn(".textContent = failed ? 'Stopped' : 'Completed';", shopping)
        self.assertRegex(shopping, r"inspectorRow\('DIRECT', \{[\s\S]{0,200}?failed \? 'error'[\s\S]{0,200}?"
                                   r"failed \? statusBadge\(step\.status\) : null")

    def test_a_step_whose_change_did_not_happen_is_never_a_success(self):
        """The server reports "not_done" (a refused add, a stale confirmation, a save not read back) and
        "partial" (some added, some not) - each shown as such, counted a problem in the turn's title and the
        inspector entry, styled as a warning; never mapped to "success" (10 Oct)."""
        shopping = (FRONTEND / "shopping.js").read_text(encoding="utf-8")
        self.assertIn("not_done: 'not done', partial: 'partial'};", shopping)          # chat activity state
        self.assertIn("not_done: 'not done', partial: 'partly done'};", shopping)      # inspector badge label
        self.assertIn("/state-(failed|timeout|stopped|not-done|partial)/.test(r.className)", shopping)
        self.assertIn("/failed|timeout|stopped|not-done|partial/.test(a.state)", shopping)
        self.assertIn("['error', 'timeout', 'not_done', 'partial'].includes(step.status)", shopping)
        self.assertIn("['not done', 'partly done'].includes(label) ? 'warn'", shopping)
        css = (FRONTEND / "dashboard.css").read_text(encoding="utf-8")
        self.assertIn(".state-not-done .activity-mark::before, .state-partial .activity-mark::before", css)
        self.assertIn(".trace-status.status-warn {", css)

    def test_the_cart_steppers_change_that_line_by_its_id(self):
        """−, + and Remove change THIS line through PUT /cart/items/{id} (the server re-reads stock and price
        when it goes up) - not a typed command by name, which changed the first of two same-named lines."""
        shopping = (FRONTEND / "shopping.js").read_text(encoding="utf-8")
        self.assertIn("button.onclick = () => shoppingCartSetQty(item.id, Number(item.qty) + delta);", shopping)
        self.assertIn("remove.onclick = () => shoppingCartSetQty(item.id, 0);", shopping)
        self.assertRegex(shopping, r"/v1/pharmacy/cart/\$\{user\}/items/\$\{encodeURIComponent\(String\(itemId\)\)\}`")
        self.assertNotIn("shoppingSubmit(`Remove ${name}`)", shopping)
        self.assertNotIn("`Add one more ${name} to my cart`", shopping)

    def test_the_shop_pages_pharmacy_pick_reaches_the_server(self):
        """The pharmacy picked on the shop page is posted (this chat's session, the user's location) before its
        shelf is shown, and its shelf is read afresh; a refused pick is said and nothing is selected."""
        flow = (FRONTEND / "shop-flow.js").read_text(encoding="utf-8")
        self.assertIn("async function shopFlowSelect(store) {", flow)
        self.assertRegex(flow, r"apiFetch\(`/v1/pharmacy/selection/\$\{user\}`, \{\s*method: 'POST'")
        # The chat's own session (created now if need be) - never a stand-in the chat's turns don't use.
        self.assertIn("session_id: shoppingEnsureSession(),", flow)
        self.assertNotIn("'shop')", flow)
        self.assertIn("shopFlow.shelfCache.delete(store.id);", flow)
        self.assertRegex(flow, r"catch \(error\) \{[\s\S]{0,200}?shoppingNotice\(`Couldn't select[\s\S]{0,80}?return;")

    def test_a_repriced_cart_never_keeps_the_old_total(self):
        """The cached bill is keyed by each line's price too, and a line's price never comes from another
        pharmacy's shelf."""
        shopping = (FRONTEND / "shopping.js").read_text(encoding="utf-8")
        self.assertIn("`${item.id}:${item.qty}:${item.price_paise ?? ''}`", shopping)
        api = (FRONTEND / "pharmacy-api.js").read_text(encoding="utf-8")
        # main's rule: a line's price only from its exact listing (the name may lend a picture, never a price).
        self.assertIn("const price = item.unit_price_paise ?? exact?.price_paise ?? null;", api)
        self.assertNotIn("?? product?.price_paise", api)

    def test_every_asset_has_one_version_and_it_was_bumped(self):
        """One version for every stylesheet and script, so a deployed browser loads the new shopping.js."""
        import re

        page = (FRONTEND / "index.html").read_text(encoding="utf-8")
        versions = set(re.findall(r'\.(?:js|css)\?v=(\d+)"', page))
        self.assertEqual(versions, {"75"})   # one past main's v=74 - never a downgrade
        self.assertIn('<script src="memory.js?v=75"></script>', page)
        self.assertIn('<script src="version.js?v=75"></script>', page)

    def test_a_refill_schedule_asked_for_in_chat_shows_its_interval_not_an_order(self):
        """A schedule asked for in chat ("refill Telma 40 every month", 12 Oct) has no order, tablets or dose:
        its interval and next refill are shown - never "order null" / "runs out around null"."""
        memory = (FRONTEND / "memory.js").read_text(encoding="utf-8")
        self.assertIn("if (schedule.interval) {", memory)
        self.assertIn("every === 1 ? `Every ${unit}` : `Every ${every} ${unit}s`", memory)
        self.assertIn("row.append(el_('p', 'muted small', `Next refill: ${est.next_refill_date}.`));", memory)
        self.assertLess(memory.index("if (schedule.interval) {"), memory.index("order ${schedule.order_id}"))

    def test_the_merchant_dashboard_requests_the_backends_own_routes(self):
        """The six sections are read from GET /v1/merchant/{section} - the backend's routes (api/routes/merchant.py)
        on the configured API origin, with the signed-in token (apiFetch). A 404 there with {"code": "no_store"} is
        the client database saying this account's id owns no store (12 Oct: every section 404 for a merchant whose
        configured id owns no store) - said on the page, never a wrong URL."""
        import re

        merchant = (FRONTEND / "merchant.js").read_text(encoding="utf-8")
        self.assertIn("apiFetch(`/v1/merchant/${section}${query}`)", merchant)
        self.assertIn("apiFetch('/v1/merchant/me/stores')", merchant)
        # The views' sections, the overview's panels (['Today', 'dashboard'], ...) and the catalog's own read.
        sections = (set(re.findall(r"section: '([a-z-]+)'", merchant))
                    | set(re.findall(r"\['[A-Z][^']*', '([a-z-]+)'\]", merchant))
                    | set(re.findall(r"merchantFetch\('([a-z-]+)'", merchant)))
        self.assertEqual(sections, {"dashboard", "earnings", "orders", "top-items", "low-stock", "catalog"})
        # Never a merchant path without the API's version prefix.
        self.assertIsNone(re.search(r"[`'\"]/merchant/", merchant))
        self.assertIn("no_store: 'No store registered for this account.',", merchant)

    def test_a_merchant_without_a_store_is_told_what_to_do(self):
        """12 Oct, production: "Welcome, <store>" over six "no store" panels - the heading is the account's configured
        name, the 404 is the client database saying its id owns no store. The page notice says both and the next step,
        for the overview and for each section view; nothing is estimated."""
        merchant = (FRONTEND / "merchant.js").read_text(encoding="utf-8")
        self.assertIn("no_store: 'This sign-in is not linked to a store owner yet - ask your Siru administrator to link "
                      "it to your store.',", merchant)
        self.assertEqual(merchant.count("merchantNotice(notConnected ? merchantPageNotice(notConnected.error) : '')"), 1)
        self.assertEqual(merchant.count("? merchantPageNotice(result.error) : ''"), 1)
        self.assertNotIn("Nothing on this page is estimated.` : ''", merchant)  # no notice skips the action line

if __name__ == "__main__":
    unittest.main()
