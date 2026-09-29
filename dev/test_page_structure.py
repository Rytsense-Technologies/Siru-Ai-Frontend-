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
            missing |= {f"{script}: {i}" for i in wanted - ids}
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
        self.assertIn("input:{type:'upload', image_b64:imageB64, mime_type:mimeType}", api)
        self.assertNotIn("/v1/concierge/prescriptions/extract", shopping)
        app = (FRONTEND / "app.js").read_text(encoding="utf-8")
        self.assertIn("const photo = photoPending?.file || null;", app)
        self.assertIn("await shoppingSendPhoto(photo);", app)

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

if __name__ == "__main__":
    unittest.main()
