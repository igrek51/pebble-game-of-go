"""Minimal KataGo HTTP server for pebble-game-of-go.

Wraps one `katago analysis` process (main net + Human SL net, OnlineGo-style)
and exposes exactly what the watchapp phone side needs:

  GET  /health  -> {"status":"ok","katago":"<version>"} (503 while starting)
  POST /move    -> 10-kyu Human SL move (weighted sample of humanPolicy)
  POST /score   -> stronger-AI score estimate (main net, no SL profile)

Board is fixed 9x9, rules fixed Chinese, komi 7.5 default. All JSON.

POST /move request:
  {"moves": [["B","C4"],["W","Q3"],...], "profile": "rank_12k",
   "komi": 7.5}
  or stones form (no history needed; ko ban not expressible, so the
  client must legality-check the reply):
  {"stones": {"B": ["C4",...], "W": [...]}, "toMove": "B",
   "profile": "rank_12k", "komi": 7.5}
  moves: [color, coord] pairs in game order, coord "pass" allowed.
  Empty moves = empty board, Black to move. profile is REQUIRED: one of
  rank_20k..rank_9d or preaz_20k..preaz_9d (Human SL rank to imitate).

POST /move response:
  {"move": "C3" | "pass", "winrate": 0.45, "scoreLead": -0.3,
   "profile": "rank_10k"}

POST /score request: same board payload as /move.
POST /score response:
  {"currentPlayer": "B", "winrate": 0.45, "scoreLead": -0.3,
   "scoreStdev": 12.0, "ownership": [<81 floats>]}
  winrate/scoreLead are from the side-to-move perspective
  (reportAnalysisWinratesAs = SIDETOMOVE); ownership is row-major from the
  top-left, positive = owned by the side to move.

Config via environment:
  PORT, KATAGO_BIN, MODEL_PATH, HUMAN_MODEL_PATH,
  MOVE_VISITS (8), SCORE_VISITS (150).

Stdlib only. One KataGo process, one query at a time; a second concurrent
request gets 503 {"error":"busy"}.
"""

import json
import os
import random
import re
import subprocess
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SIZE = 9
RULES = "chinese"
COORD_RE = re.compile(r"^[A-HJ][1-9]$")
GTP_LETTERS = "ABCDEFGHJKLMNOPQRST"  # skip I

PORT = int(os.environ.get("PORT", "2718"))
KATAGO_BIN = os.environ.get("KATAGO_BIN", "/opt/katago/katago")
MODEL_PATH = os.environ.get("MODEL_PATH", "/opt/katago/model.bin.gz")
HUMAN_MODEL_PATH = os.environ.get("HUMAN_MODEL_PATH", "/opt/katago/human.bin.gz")
MOVE_VISITS = int(os.environ.get("MOVE_VISITS", "8"))
SCORE_VISITS = int(os.environ.get("SCORE_VISITS", "150"))

RANKS = ([f"rank_{n}k" for n in range(20, 0, -1)] + [f"rank_{n}d" for n in range(1, 10)]
         + [f"preaz_{n}k" for n in range(20, 0, -1)] + [f"preaz_{n}d" for n in range(1, 10)])

CFG_TEMPLATE = """\
logToStderr = true
logSearchInfo = false
logAllRequests = false
logAllResponses = false
reportAnalysisWinratesAs = SIDETOMOVE
maxVisits = 50
numAnalysisThreads = 1
numSearchThreadsPerAnalysisThread = {threads}
nnMaxBatchSize = 8
numNNServerThreadsPerModel = 2
nnCacheSizePowerOfTwo = 20
"""


def idx_to_gtp(i):
    if i == SIZE * SIZE:
        return "pass"
    return f"{GTP_LETTERS[i % SIZE]}{SIZE - (i // SIZE)}"


def validate_coord(p):
    if p != "pass" and not COORD_RE.match(p.upper()):
        raise ValueError(f"bad coordinate: {p!r}")
    return "pass" if p == "pass" else p.upper()


def validate_board(body):
    """Returns (moves, initial_stones, initial_player, komi) or raises ValueError."""
    if not isinstance(body, dict):
        raise ValueError("body must be a JSON object")
    moves = body.get("moves")
    initial_stones = None
    initial_player = None
    if moves is not None:
        if not isinstance(moves, list):
            raise ValueError("moves must be an array of [color, coord] pairs")
        clean = []
        for m in moves:
            if (not isinstance(m, list) or len(m) != 2 or m[0] not in ("B", "W")
                    or not isinstance(m[1], str)):
                raise ValueError(f"bad move pair: {m!r}")
            clean.append([m[0], validate_coord(m[1])])
        moves = clean
    else:
        stones = body.get("stones")
        to_move = body.get("toMove")
        if (not isinstance(stones, dict) or set(stones) != {"B", "W"}
                or to_move not in ("B", "W")):
            raise ValueError('need "moves" or ("stones" {"B","W"} + "toMove")')
        initial_stones = []
        for color in ("B", "W"):
            if not isinstance(stones[color], list):
                raise ValueError(f"stones.{color} must be an array")
            for p in stones[color]:
                if not isinstance(p, str):
                    raise ValueError(f"bad stone: {p!r}")
                initial_stones.append([color, validate_coord(p)])
        moves = []
        initial_player = to_move
    komi = body.get("komi", 7.5)
    if not isinstance(komi, (int, float)) or komi != komi:
        raise ValueError("komi must be a number")
    if abs(komi * 2 - round(komi * 2)) > 1e-9 or abs(komi) > 150:
        raise ValueError("komi must be a half-integer within +-150")
    return moves, initial_stones, initial_player, float(komi)


def validate_profile(body):
    profile = body.get("profile")
    if profile not in RANKS:
        raise ValueError("profile is required: one of rank_20k..rank_9d, "
                         "preaz_20k..preaz_9d")
    return profile


class Engine:
    """Owns the katago analysis subprocess. query() is NOT thread-safe."""

    def __init__(self):
        cfg_path = "/tmp/pebble-katago-analysis.cfg"
        threads = os.cpu_count() or 4
        with open(cfg_path, "w") as f:
            f.write(CFG_TEMPLATE.format(threads=threads))
        self.proc = subprocess.Popen(
            [KATAGO_BIN, "analysis", "-config", cfg_path,
             "-model", MODEL_PATH, "-human-model", HUMAN_MODEL_PATH],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, bufsize=1)
        for line in self.proc.stdout:
            if "Started, ready to begin handling requests" in line:
                break
        else:
            raise RuntimeError("katago exited before becoming ready")
        self.version = self._raw({"id": "v", "action": "query_version"}).get(
            "version", "?")
        self.lock = threading.Lock()
        self.ready = True

    def _raw(self, query):
        self.proc.stdin.write(json.dumps(query) + "\n")
        self.proc.stdin.flush()
        qid = query["id"]
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("katago closed stdout")
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if o.get("id") != qid:
                continue
            if "error" in o:
                raise RuntimeError(f"katago: {o['error']}")
            if o.get("isDuringSearch", False):
                continue
            if "turnNumber" in o or "action" in o:
                return o

    def query(self, query):
        return self._raw(query)


ENGINE = None


def sample_human_move(human_policy):
    legal = [(i, v) for i, v in enumerate(human_policy) if v >= 0]
    if not legal:
        raise RuntimeError("humanPolicy had no legal moves")
    total = sum(v for _, v in legal)
    r = random.random() * total
    for i, v in legal:
        r -= v
        if r <= 0:
            return i
    return legal[-1][0]


def handle_move(moves, initial_stones, initial_player, komi, profile):
    query = {
        "id": uuid.uuid4().hex, "moves": moves, "rules": RULES, "komi": komi,
        "boardXSize": SIZE, "boardYSize": SIZE, "maxVisits": MOVE_VISITS,
        "includePolicy": True,
        "overrideSettings": {"humanSLProfile": profile},
    }
    if initial_stones is not None:
        query["initialStones"] = initial_stones
        query["initialPlayer"] = initial_player
    resp = ENGINE.query(query)
    move_infos = resp.get("moveInfos", [])
    root = resp.get("rootInfo", {})
    if move_infos and move_infos[0].get("move", "").lower() == "pass":
        chosen = "pass"
    elif (root.get("winrate", 0.5) < 0.01
          and any(m.get("move", "").lower() == "pass" for m in move_infos)):
        chosen = "pass"
    else:
        hp = resp.get("humanPolicy")
        if not hp:
            raise RuntimeError("no humanPolicy in response")
        chosen = idx_to_gtp(sample_human_move(hp))
    info = next((m for m in move_infos
                 if m.get("move", "").lower() == chosen.lower()), None)
    return {
        "move": chosen,
        "winrate": (info or root).get("winrate", 0.5),
        "scoreLead": (info or root).get("scoreLead", 0.0),
        "profile": profile,
    }


def handle_score(moves, initial_stones, initial_player, komi):
    query = {
        "id": uuid.uuid4().hex, "moves": moves, "rules": RULES, "komi": komi,
        "boardXSize": SIZE, "boardYSize": SIZE, "maxVisits": SCORE_VISITS,
        "includeOwnership": True,
    }
    if initial_stones is not None:
        query["initialStones"] = initial_stones
        query["initialPlayer"] = initial_player
    resp = ENGINE.query(query)
    root = resp.get("rootInfo", {})
    return {
        "currentPlayer": root.get("currentPlayer", "?"),
        "winrate": root.get("winrate", 0.5),
        "scoreLead": root.get("scoreLead", 0.0),
        "scoreStdev": root.get("scoreStdev", 0.0),
        "ownership": resp.get("ownership", []),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "PebbleKataGo/1.0"

    def log_message(self, *args):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            if ENGINE is not None and ENGINE.ready:
                self._send(200, {"status": "ok", "katago": ENGINE.version})
            else:
                self._send(503, {"error": "starting"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path not in ("/move", "/score"):
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > 65536:
            self._send(400, {"error": "body must be 1..65536 bytes of JSON"})
            return
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError:
            self._send(400, {"error": "malformed JSON"})
            return
        try:
            moves, initial_stones, initial_player, komi = validate_board(body)
            profile = validate_profile(body) if self.path == "/move" else None
        except ValueError as e:
            self._send(400, {"error": str(e)})
            return
        if ENGINE is None or not ENGINE.ready:
            self._send(503, {"error": "engine not ready"})
            return
        if not ENGINE.lock.acquire(blocking=False):
            self._send(503, {"error": "busy"})
            return
        try:
            if self.path == "/move":
                self._send(200, handle_move(moves, initial_stones,
                                            initial_player, komi, profile))
            else:
                self._send(200, handle_score(moves, initial_stones,
                                             initial_player, komi))
        except RuntimeError as e:
            msg = str(e)
            self._send(400 if "katago:" in msg else 502, {"error": msg})
        finally:
            ENGINE.lock.release()


def main():
    global ENGINE
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    ENGINE = Engine()  # blocks until katago is ready; /health 503 meanwhile
    print(f"ready on :{PORT} katago={ENGINE.version}", flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
