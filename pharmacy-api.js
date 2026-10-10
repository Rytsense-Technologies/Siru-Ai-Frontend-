// POST /v1/concierge/turn - one turn in, server-sent events out
// (multi_agent_framework/api/routes/concierge.py). Only what the backend
// actually sent is shown: the text and cards it streamed, and at turn_end
// its own trace (route, agent, tools, model calls, latency).
const concierge = {
  // `onStep(step)`: each trace step as it happens (SSE `step`) - the
  // inspector's live view of the turn.
  async turn(body, onStep = null) {
    const token = authToken();
    // No answer, and nothing streamed, for this long (the server's turn budget
    // is 60 s): the turn fails with a message instead of staying busy.
    const controller = new AbortController();
    // Set once the answer streams: a stall then cancels the stream and fails
    // the turn itself - not only the request, whose stream a proxy may leave open.
    let onStall = () => controller.abort();
    let stall = setTimeout(() => onStall(), API_TIMEOUT_MS);
    const stalled = () => {
      clearTimeout(stall);
      stall = setTimeout(() => onStall(), API_TIMEOUT_MS);
    };
    let res;
    try {
      res = await fetch(`${API_BASE}/v1/concierge/turn`, {
        method:'POST', body:JSON.stringify(body), headers:{...apiHeaders(), 'x-siru-trace':'1'}, signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(stall);
      if (err?.name === 'AbortError') throw apiTimeoutError('/v1/concierge/turn');
      throw err;
    }
    if (res.status === 401 && token && token === authToken()) authExpired();
    if (!res.ok || !res.body) {
      clearTimeout(stall);
      let detail = await res.text().catch(() => '');
      try { const data = JSON.parse(detail); detail = typeof data.detail === 'string' ? data.detail : (data.error || res.statusText); } catch {}
      const error = new Error(`${res.status} ${detail || res.statusText}`);
      error.status = res.status;
      error.path = '/v1/concierge/turn';
      throw error;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const answer = {text:'', cards:[], trace:null, traceId:null};
    // Every step streamed so far (SSE `step`, the newest version of each by id):
    // a turn that fails still shows what it did - the timed-out model call too.
    const steps = new Map();
    // What the tools did, as streamed before turn_end (the trace channel):
    // each call's plane (core / ai), input, latency and the tables it read or
    // wrote, and the checkpoint writes - the inspector's Data tab.
    const io = {calls:[], checkpoints:[], data:[]};
    let buffer = '';
    let answered = false;
    let resolveTurn, rejectTurn;
    const done = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    const finish = () => {
      if (answered) return;
      answered = true;
      resolveTurn(answer);
    };
    onStall = () => {
      controller.abort();
      reader.cancel().catch(() => {});
      if (answered) return;
      answered = true;
      rejectTurn(Object.assign(apiTimeoutError('/v1/concierge/turn'), {
        message: 'The answer is taking too long. Check your cart before trying again.', steps: [...steps.values()],
      }));
    };
    const handle = event => {
      if (event.type === 'step') {
        if (!answered && event.step) steps.set(event.step.id ?? steps.size, event.step);
        if (!answered && onStep) { try { onStep(event.step); } catch (err) { console.warn('inspector: live step', err); } }
      } else if (event.type === 'text') answer.text = answer.text ? `${answer.text} ${event.text}` : event.text;
      else if (event.type === 'card' && event.card) answer.cards.push(event.card);
      else if (event.type === 'tool_call' && !answered) {
        io.calls.push({id:event.id, name:event.name, plane:event.plane, by:event.by, args:event.args || {}});
      } else if (event.type === 'tool_result' && !answered) {
        const call = io.calls.find(c => c.id === event.id);
        if (call) Object.assign(call, {ms:event.ms, status:event.status,
          tables_read:event.tables_read || [], tables_written:event.tables_written || [],
          table_planes:event.table_planes || {}});
      } else if (event.type === 'checkpoint' && !answered) {
        io.checkpoints.push({thread:event.thread, store:event.store, tables_written:event.tables_written || []});
      } else if (event.type === 'data' && !answered) {
        // Tables the turn touched outside any tool, as the server observed them.
        io.data.push({tables_read:event.tables_read || [], tables_written:event.tables_written || [],
          table_planes:event.table_planes || {}});
      }
      else if (event.type === 'error') {
        // The backend writes these for the user (concierge.py _turn_error).
        const error = new Error(event.error || 'The assistant could not answer.');
        error.userMessage = true;
        error.code = event.code;
        error.traceId = event.trace_id;
        error.steps = [...steps.values()];
        answered = true;
        rejectTurn(error);
      } else if (event.type === 'turn_end') {
        answer.trace = event.trace ? {...event.trace, trace_id:event.trace_id, llm_calls:event.llm_calls,
          latency_ms:event.latency_ms, model:event.model, io} : null;
        answer.traceId = event.trace_id;
        if (event.route === 'memory_command' && typeof memoryRefresh === 'function') memoryRefresh();
        finish();
      } else if (event.type === 'memory' && event.background && event.op === 'saved' && typeof memoryRefresh === 'function') {
        memoryRefresh();
      } else if (event.type === 'done') {
        answer.traceId = answer.traceId || event.trace_id;
        finish();
      }
    };
    // Read to the end in the background: the answer resolves at turn_end.
    (async () => {
      try {
        while (true) {
          const {value, done: ended} = await reader.read();
          if (ended) break;
          stalled();  // bytes arrived: the stall timer starts again
          buffer += decoder.decode(value, {stream:true});
          let cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = chunk.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
            if (data) {
              try { handle(JSON.parse(data)); } catch (err) { console.warn('concierge: bad event', err); }
            }
          }
        }
        clearTimeout(stall);
        if (!answered) {
          if (answer.text) finish();
          else {
            answered = true;
            const cut = new Error('The answer was cut off. Check your cart before trying again.');
            cut.userMessage = true;
            rejectTurn(cut);
          }
        }
      } catch (err) {
        clearTimeout(stall);
        if (!answered) {
          answered = true;
          rejectTurn(err?.name === 'AbortError' ? Object.assign(apiTimeoutError('/v1/concierge/turn'), {
            message: 'The answer is taking too long. Check your cart before trying again.', steps: [...steps.values()],
          }) : err);
        }
      }
    })();
    return done;
  },
};

// Use the existing agents' catalog and cart. Never infer mutations from prose.
const pharmacyApi = {
  mode: null,
  products: [],
  readSequence: 0,
  async catalog() {
    // The shelf and cart must be the same catalog/cart used by the agents.
    try {
      // Each medicine once, from the pharmacy an add would use (the nearest) -
      // measured from the location the user chose (location.js), if any.
      const products = await apiFetch(`/v1/pharmacy/products?nearest=true${locationCatalogQuery()}`);
      this.mode = 'sandbox';
      const illustrations = {dolo:'dolo',crocin:'crocin',cetirizine:'cetirizine',betadine:'betadine',electral:'electral'};
      this.products = products.map(p => {
        const brand = Object.keys(illustrations).find(name => p.name.toLowerCase().startsWith(name));
        return {id:p.id, name:p.name, pack_size:p.unit || '', price_paise:p.pricePaise,
          store_id:p.storeId, store_name:p.storeName || '',
          image_url:p.imageUrl || (brand ? `images/${illustrations[brand]}.svg` : 'images/medicine.svg')};
      });
      const featured = Object.keys(illustrations).map(name => this.products.find(p => p.name.toLowerCase().startsWith(name))).filter(Boolean);
      return [...featured, ...this.products.filter(p => !featured.includes(p))].slice(0,5);
    } catch (error) {
      if (error.status === 404) error.message = 'The configured API has no pharmacy routes (/v1/pharmacy) - check the API address; an older backend needs updating.';
      throw error;
    }
  },
  normalizeCart(cart, version) {
    if (!Array.isArray(cart.items)) throw new Error('The backend returned an invalid cart.');
    const items = cart.items.map(item => {
      // The same medicine from another pharmacy has another id: fall back to its name.
      const product = this.products.find(p => p.id === item.item_id) || this.products.find(p => p.name === item.name);
      const price = item.unit_price_paise ?? product?.price_paise ?? null;
      return {id:item.item_id, name:item.name || product?.name || 'Medicine',
        qty:item.qty, price_paise:price, line_total_paise:price == null ? null : price * item.qty,
        image_url:item.image_url || product?.image_url || 'images/medicine.svg',
        pack_size:item.unit || product?.pack_size || ''};
    });
    return {items, version, storeId:cart.storeId ?? null, total_paise:items.some(i => i.line_total_paise == null) ? null : items.reduce((n,i) => n+i.line_total_paise,0)};
  },
  async state() {
    if (this.mode !== 'sandbox') throw new Error('Connect to the pharmacy first.');
    const sequence = ++this.readSequence;
    const cart = await apiFetch(`/v1/pharmacy/cart/${encodeURIComponent(getUserId())}`);
    return {cart:this.normalizeCart(cart, sequence), results:[]};
  },
  // The cart plus the server's bill (present_bill: subtotal, delivery, total,
  // coins available) for the chat's bill card. An API image built before the
  // bill route answers 404: then the card shows the items and subtotal only.
  async bill() {
    if (this.mode !== 'sandbox') throw new Error('Connect to the pharmacy first.');
    const sequence = ++this.readSequence;
    const user = encodeURIComponent(getUserId());
    try {
      const data = await apiFetch(`/v1/pharmacy/cart/${user}/bill`);
      // The user's own delivery location when they set one; else the server's.
      return {cart:this.normalizeCart(data.cart, sequence), storeId:data.cart.storeId, bill:data.bill,
        address:locationBillAddress() || data.delivery?.address || ''};
    } catch (error) {
      if (error.status !== 404) throw error;
      const cart = await apiFetch(`/v1/pharmacy/cart/${user}`);
      return {cart:this.normalizeCart(cart, sequence), storeId:cart.storeId, bill:null, address:''};
    }
  },
  async select(productId, qty) {
    // Selection is UI context. Explicit voice commands use the product name.
  },
  async command(text, commandId, onStep = null) {
    if (this.mode !== 'sandbox') throw new Error('Connect to the pharmacy first.');
    const userId = getUserId();
    const sessionId = shoppingSessionId;
    // The conversation so far, oldest first: each turn's message and reply
    // (not this one), and messages outside turns (the greeting). Cards and
    // bills have no text.
    const history = userHistory(userId).filter(m => m.id !== commandId).flatMap(m => m.type === 'turn'
      ? [m.user && {role:'user', content:m.user}, m.reply && m.status === 'answered' && {role:'assistant', content:m.reply}]
      : [typeof m.text === 'string' && m.text && m.kind !== 'greeting' && {role:m.role, content:m.text}]).filter(Boolean).slice(-12);
    // Keep the original user bubble; only resolve an explicit UI reference in
    // the text request. The existing agent owns add/delete/order/refill intent.
    const selected = this.products.find(p => p.id === shop.selected);
    const input = selected && /^(?:i want|add) this medicine[.!]?$/i.test(text.trim())
      ? `Add ${shop.quantity} packs of ${selected.name} to cart` : text;
    // The live concierge turn (POST /v1/concierge/turn): the real graph,
    // streamed as it runs. The turn is answered at turn_end; the stream then
    // stays open for the background memory save, which only refreshes the
    // Memory tab.
    const location = locationTurnContext();
    // Whether a location went with the turn - never the coordinates themselves.
    if (location?.lat != null) console.info('siru: turn sent with location');
    else console.info('siru: turn sent without coordinates - nearest-pharmacy answers will ask for a location');
    const turn = await concierge.turn({
      session_id:sessionId, user_id:userId, channel:'chat',
      input:{type:'text', text:input}, history, context:{location},
    }, onStep);
    return {command_id:commandId, user_id:userId, session_id:sessionId, source:'text', text,
      message:turn.text || 'The assistant returned no response. Check your cart before trying again.',
      trace:turn.trace, cards:turn.cards};
  },
  // A photo (a prescription or a medicine's pack) as a streamed turn
  // (POST /v1/concierge/turn, input.type "upload"): read by the vision model
  // on the server, the medicines read clearly are looked up in the catalog,
  // and the turn's trace - tools, tables - reaches the inspector like any turn.
  // `text`: what was typed with the photo ("order these from Apollo") - the same turn, so the
  // server reads the request with the prescription it is about.
  async photo(imageB64, mimeType, onStep = null, text = '') {
    if (this.mode !== 'sandbox') throw new Error('Connect to the pharmacy first.');
    const input = {type:'upload', image_b64:imageB64, mime_type:mimeType};
    if (text) input.text = text;
    const turn = await concierge.turn({
      session_id:shoppingEnsureSession(), user_id:getUserId(), channel:'chat',
      input, history:[], context:{location:locationTurnContext()},
    }, onStep);
    return {message:turn.text || "The photo couldn't be read. Please try again.", trace:turn.trace, cards:turn.cards};
  },
  // What Siru remembers about the signed-in user (GET /v1/memory/me). Per
  // user, not per session: a new chat session doesn't change it.
  async memory() {
    return apiFetch('/v1/memory/me');
  },
  // Voice ID (speaker verification). The recording is sent once as raw PCM
  // and turned into a voiceprint on the server; it is never stored here.
  async voiceProfile() {
    return apiFetch('/v1/voice/profile');
  },
  async enrolVoice(pcmBuffer, sampleRate) {
    return apiFetch(`/v1/voice/profile?consent=true&sample_rate=${sampleRate}`, {
      method: 'POST', body: pcmBuffer, headers: {'Content-Type': 'application/octet-stream'},
    });
  },
  async deleteVoiceProfile() {
    return apiFetch('/v1/voice/profile', {method: 'DELETE'});
  },
  // Turns remembering on or off for the signed-in user (the consent switch).
  async setMemoryConsent(enabled) {
    return apiFetch('/v1/memory/me/consent', {method: 'PUT', body: JSON.stringify({enabled})});
  },
  // Forgets everything this app keeps about the signed-in user (DELETE /v1/memory/me).
  async forgetEverything() {
    return apiFetch('/v1/memory/me', {method: 'DELETE'});
  },
  // Forgets one remembered fact (the Memory tab's bin icon).
  async forgetMemory(id) {
    return apiFetch(`/v1/memory/me/${encodeURIComponent(id)}`, {method: 'DELETE'});
  },
  // The signed-in user's orders, newest first (the rows list_orders reads).
  async orders() {
    return apiFetch(`/v1/pharmacy/orders/${encodeURIComponent(getUserId())}`);
  },
  imageFor(name) {
    return this.products.find(p => p.name === name)?.image_url || 'images/medicine.svg';
  },
};

// A failure as the user should read it: never an address, status code, stack
// or server internals. The technical detail goes to the console instead.
function pharmacyError(error) {
  const status = error?.status;
  console.warn('siru: request failed', status || '', error?.path || '', error?.message || error);
  if (error?.userMessage) return error.message;  // written for the user (the stream's error event)
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'This account is not allowed to do that.';
  if (status === 404) return 'The requested service is temporarily unavailable.';
  if (status === 429) return 'Siru is busy right now. Please try again in a moment.';
  if (status === 400 || status === 409 || status === 410) {
    const detail = String(error.message || '').replace(/^\d{3}\s*/, '').trim();
    return detail && detail.length < 200 ? detail : 'That request could not be completed.';
  }
  if (status === 422) return 'That request could not be understood. Please check it and try again.';
  return 'Service is temporarily unavailable. Please try again.';
}
