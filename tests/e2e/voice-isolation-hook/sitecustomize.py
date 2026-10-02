"""TEST-ONLY: the voice worker side of tests/e2e/06-voice-isolation.e2e.cjs.

Never part of the app: run-voice-isolation.ps1 puts this directory on the
voice worker's PYTHONPATH for that test run only (Python imports sitecustomize
at start-up), with SIRU_E2E_GATE_DIR set. Without that variable it does nothing.

Loaded into the voice worker process (and its job processes) via PYTHONPATH,
and only when SIRU_E2E_GATE_DIR is set. It wraps livekit.rtc's
LocalParticipant.publish_data - the exact point where the worker hands a
message to LiveKit - to:
  * log every app message on the "siru.turn" topic (type, turn id, the
    destination identity, the sender) to <gate>/worker-publish.jsonl;
  * hold a turn.result addressed to a user while <gate>/hold-<user> exists,
    until <gate>/release-<user> appears - then call the REAL publish_data,
    so the real message goes through the real LiveKit server.
Nothing else is changed: no check is skipped, no message is altered.
"""
import json
import os
import time

GATE = os.environ.get("SIRU_E2E_GATE_DIR")

if GATE:
    try:
        import asyncio

        from livekit import rtc

        _real_publish_data = rtc.LocalParticipant.publish_data

        def _log(event, **fields):
            with open(os.path.join(GATE, "worker-publish.jsonl"), "a", encoding="utf-8") as out:
                out.write(json.dumps({"t": round(time.time(), 3), "pid": os.getpid(), "event": event, **fields}) + "\n")

        async def publish_data(self, payload, *args, **kwargs):
            if kwargs.get("topic") != "siru.turn":
                return await _real_publish_data(self, payload, *args, **kwargs)
            try:
                raw = payload if isinstance(payload, str) else bytes(payload).decode("utf-8")
                message = json.loads(raw)
                info = {"type": message.get("type"), "turn_id": message.get("turn_id"),
                        "user_text": message.get("user_text"), "reply": (message.get("reply") or "")[:120] or None}
            except Exception:
                info = {"type": "?"}
            info = {k: v for k, v in info.items() if v is not None}
            destination = list(kwargs.get("destination_identities") or [])
            base = {"sender": getattr(self, "identity", None), "destination": destination, **info}
            _log("publish_requested", **base)
            if info.get("type") == "turn.result":
                for user in destination:
                    if os.path.exists(os.path.join(GATE, f"hold-{user}")):
                        _log("held", **base)
                        waited = 0.0
                        while not os.path.exists(os.path.join(GATE, f"release-{user}")) and waited < 900:
                            await asyncio.sleep(0.25)
                            waited += 0.25
                        _log("released", waited_s=waited, **base)
            try:
                result = await _real_publish_data(self, payload, *args, **kwargs)
            except Exception as error:
                _log("publish_failed", error=repr(error), **base)
                raise
            _log("published", **base)
            return result

        rtc.LocalParticipant.publish_data = publish_data
        _log("hook_installed", argv=" ".join(__import__("sys").argv)[:200])
    except Exception as error:  # never break the worker because of the test hook
        try:
            with open(os.path.join(GATE, "worker-publish.jsonl"), "a", encoding="utf-8") as out:
                out.write(json.dumps({"event": "hook_failed", "error": repr(error)}) + "\n")
        except Exception:
            pass
