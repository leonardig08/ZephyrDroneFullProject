"""
ZephyrDrone Python Middleware
Connette al Kotlin WebSocket server sul controller DJI,
riceve telemetria + video e li espone via FastAPI a client web.
"""

import asyncio
import base64
import json
import math
import time
import sqlite3
import traceback
import socket
import subprocess
from collections import defaultdict, deque
from contextlib import suppress
from pathlib import Path
from typing import Optional, Literal
from uuid import uuid4

import httpx
import uvicorn
import websockets
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

# ─────────────────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────────────────

RECONNECT_DELAY = 3.0       # secondi tra i tentativi
SETTINGS_PATH = Path(__file__).with_name("network_settings.json")
HOME_POINT_PATH = Path(__file__).with_name("home_point.json")
DB_PATH = Path(__file__).with_name("zephyr_ops.db")
MISSION_PRESETS_PATH = Path(__file__).with_name("mission_presets.json")
MOCK_CONFIG_PATH = Path(__file__).with_name("mock_drone.conf")
MOCK_FRAME_DIR = Path(__file__).with_name("mock_frames")
LOG_ROWS_MAX = 20000
LOG_PRUNE_BATCH = 1000
DRONE_TEST_NO_RETRY = False

DEFAULT_MOCK_CONFIG = {
    "enabled": False,
    "start": {
        "lat": 44 + 22 / 60 + 42.0 / 3600,
        "lon": 7 + 31 / 60 + 37.2 / 3600,
    },
    "telemetry_hz": 90,
}


def load_mock_config() -> dict:
    if not MOCK_CONFIG_PATH.exists():
        MOCK_CONFIG_PATH.write_text(json.dumps(DEFAULT_MOCK_CONFIG, indent=2), encoding="utf-8")
        return dict(DEFAULT_MOCK_CONFIG)
    try:
        loaded = json.loads(MOCK_CONFIG_PATH.read_text(encoding="utf-8-sig"))
        if not isinstance(loaded, dict):
            raise ValueError("mock config must be a JSON object")
        config = dict(DEFAULT_MOCK_CONFIG)
        start = dict(DEFAULT_MOCK_CONFIG["start"])
        if isinstance(loaded.get("start"), dict):
            start.update(loaded["start"])
        config.update({k: v for k, v in loaded.items() if k != "start"})
        config["start"] = start
        return config
    except Exception as e:
        print(f"[Config] Impossibile leggere {MOCK_CONFIG_PATH.name}: {e}. Uso default safe OFF.")
        return dict(DEFAULT_MOCK_CONFIG)


MOCK_CONFIG = load_mock_config()
MOCK_DRONE_MODE = bool(MOCK_CONFIG.get("enabled", False))
MOCK_START_LAT = float(MOCK_CONFIG.get("start", {}).get("lat", DEFAULT_MOCK_CONFIG["start"]["lat"]))
MOCK_START_LON = float(MOCK_CONFIG.get("start", {}).get("lon", DEFAULT_MOCK_CONFIG["start"]["lon"]))
MOCK_TELEMETRY_HZ = max(90, min(120, int(MOCK_CONFIG.get("telemetry_hz", DEFAULT_MOCK_CONFIG["telemetry_hz"]))))
TELEMETRY_BROADCAST_HZ = 90
TELEMETRY_BROADCAST_INTERVAL_S = 1.0 / TELEMETRY_BROADCAST_HZ

DEFAULT_NETWORK_SETTINGS = {
    "kotlin_host": "10.101.30.88",
    "kotlin_port": 8081,
    "go2rtc_url": "http://127.0.0.1:1984",
}

KOTLIN_HOST = DEFAULT_NETWORK_SETTINGS["kotlin_host"]
KOTLIN_PORT = DEFAULT_NETWORK_SETTINGS["kotlin_port"]
KOTLIN_WS_URL = f"ws://{KOTLIN_HOST}:{KOTLIN_PORT}/ws/drone"
GO2RTC_URL = DEFAULT_NETWORK_SETTINGS["go2rtc_url"]
sqlite_lock = asyncio.Lock()
mission_presets_lock = asyncio.Lock()
active_mission_history_id: Optional[int] = None
active_mission_uuid: Optional[str] = None
pending_delivery_return_payload: Optional[dict] = None
DRONE_LEASE_TTL_SECONDS = 45.0
CONTROLLED_DRONE_ID = "zephyr-mavic-3t"
CONTROLLED_DRONE_NAME = "Zephyr Mavic 3T"
CONTROLLED_DRONE_MODEL = "DJI Mavic 3T Enterprise"
thermal_spot_inputs: dict[str, dict] = {}


def _build_kotlin_ws_url(host: str, port: int) -> str:
    return f"ws://{host}:{port}/ws/drone"


def _normalize_host(value: str) -> str:
    host = (value or "").strip()
    if "://" in host:
        host = host.split("://", 1)[1]
    host = host.split("/", 1)[0]
    if ":" in host:
        host = host.split(":", 1)[0]
    return host


def _normalize_go2rtc_url(value: str) -> str:
    url = (value or "").strip()
    if not url:
        return DEFAULT_NETWORK_SETTINGS["go2rtc_url"]
    if "://" not in url:
        url = f"http://{url}"
    return url.rstrip("/")


def _host_to_subnet_prefix(host: str) -> Optional[str]:
    parts = (host or "").strip().split(".")
    if len(parts) != 4:
        return None
    try:
        nums = [int(p) for p in parts]
    except Exception:
        return None
    if any(n < 0 or n > 255 for n in nums):
        return None
    return f"{nums[0]}.{nums[1]}.{nums[2]}"


def _guess_local_lan_ip() -> Optional[str]:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


def _to_bool(value, default: bool = True) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    v = str(value).strip().lower()
    if v in {"1", "true", "yes", "on"}:
        return True
    if v in {"0", "false", "no", "off"}:
        return False
    return default


def apply_network_settings(settings: dict):
    global KOTLIN_HOST, KOTLIN_PORT, KOTLIN_WS_URL, GO2RTC_URL
    KOTLIN_HOST = _normalize_host(str(settings.get("kotlin_host", DEFAULT_NETWORK_SETTINGS["kotlin_host"])))
    if not KOTLIN_HOST:
        KOTLIN_HOST = DEFAULT_NETWORK_SETTINGS["kotlin_host"]
    try:
        port = int(settings.get("kotlin_port", DEFAULT_NETWORK_SETTINGS["kotlin_port"]))
    except Exception:
        port = DEFAULT_NETWORK_SETTINGS["kotlin_port"]
    KOTLIN_PORT = max(1, min(65535, port))
    GO2RTC_URL = _normalize_go2rtc_url(str(settings.get("go2rtc_url", DEFAULT_NETWORK_SETTINGS["go2rtc_url"])))
    KOTLIN_WS_URL = _build_kotlin_ws_url(KOTLIN_HOST, KOTLIN_PORT)


def current_network_settings() -> dict:
    return {
        "kotlin_host": KOTLIN_HOST,
        "kotlin_port": KOTLIN_PORT,
        "kotlin_ws_url": KOTLIN_WS_URL,
        "go2rtc_url": GO2RTC_URL,
    }


def load_network_settings():
    data = dict(DEFAULT_NETWORK_SETTINGS)
    if SETTINGS_PATH.exists():
        try:
            loaded = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data.update(loaded)
        except Exception as e:
            print(f"[Config] Impossibile leggere {SETTINGS_PATH.name}: {e}")
    apply_network_settings(data)


def save_network_settings():
    SETTINGS_PATH.write_text(
        json.dumps(
            {
                "kotlin_host": KOTLIN_HOST,
                "kotlin_port": KOTLIN_PORT,
                "go2rtc_url": GO2RTC_URL,
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def _load_mission_presets_sync() -> list[dict]:
    if not MISSION_PRESETS_PATH.exists():
        return []
    try:
        raw = json.loads(MISSION_PRESETS_PATH.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return []
        missions = raw.get("missions")
        if not isinstance(missions, list):
            return []
        valid: list[dict] = []
        for item in missions:
            if not isinstance(item, dict):
                continue
            mission_name = str(item.get("mission_name") or "").strip()
            if not mission_name:
                continue
            valid.append(item)
        return valid
    except Exception as e:
        print(f"[Presets] load error: {e}")
        return []


def _save_mission_presets_sync(items: list[dict]):
    payload = {"missions": items}
    MISSION_PRESETS_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


async def list_saved_missions() -> list[dict]:
    async with mission_presets_lock:
        items = _load_mission_presets_sync()
    out: list[dict] = []
    for item in items:
        waypoints = item.get("waypoints")
        out.append(
            {
                "mission_name": item.get("mission_name"),
                "preset": item.get("preset"),
                "waypoints_count": len(waypoints) if isinstance(waypoints, list) else 0,
                "updated_at": item.get("updated_at"),
            }
        )
    out.sort(key=lambda x: float(x.get("updated_at") or 0), reverse=True)
    return out


async def get_saved_mission_by_name(mission_name: str) -> Optional[dict]:
    target = (mission_name or "").strip().lower()
    if not target:
        return None
    async with mission_presets_lock:
        items = _load_mission_presets_sync()
    for item in items:
        if str(item.get("mission_name") or "").strip().lower() == target:
            return item
    return None


async def save_mission_preset(payload: dict) -> Optional[dict]:
    mission_name = str(payload.get("mission_name") or "").strip()
    waypoints = payload.get("waypoints")
    if not mission_name or not isinstance(waypoints, list) or len(waypoints) == 0:
        return None
    now = time.time()
    entry = {
        "mission_name": mission_name,
        "preset": str(payload.get("preset") or "custom"),
        "waypoints": waypoints,
        "auto_speed": float(payload.get("auto_speed", 5)),
        "max_speed": float(payload.get("max_speed", 8)),
        "finished_action": str(payload.get("finished_action") or "GO_HOME"),
        "updated_at": now,
    }
    async with mission_presets_lock:
        items = _load_mission_presets_sync()
        replaced = False
        for idx, item in enumerate(items):
            if str(item.get("mission_name") or "").strip().lower() == mission_name.lower():
                entry["created_at"] = float(item.get("created_at", now))
                items[idx] = entry
                replaced = True
                break
        if not replaced:
            entry["created_at"] = now
            items.append(entry)
        _save_mission_presets_sync(items)
    return entry


def _db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_sqlite():
    with _db_connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS mission_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mission_uuid TEXT NOT NULL UNIQUE,
                mission_name TEXT,
                status TEXT NOT NULL,
                started_at REAL NOT NULL,
                ended_at REAL,
                total_waypoints INTEGER NOT NULL DEFAULT 0,
                payload_json TEXT NOT NULL DEFAULT '{}',
                last_state TEXT,
                created_at REAL NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS mission_waypoints (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mission_id INTEGER NOT NULL,
                waypoint_index INTEGER NOT NULL,
                lat REAL NOT NULL,
                lon REAL NOT NULL,
                altitude REAL NOT NULL,
                action TEXT,
                hover_seconds REAL,
                FOREIGN KEY(mission_id) REFERENCES mission_history(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS poi_favorites (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                lat REAL NOT NULL,
                lon REAL NOT NULL,
                altitude REAL NOT NULL DEFAULT 30,
                note TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_waypoints_mission
            ON mission_waypoints(mission_id, waypoint_index)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_mission_started_at
            ON mission_history(started_at DESC)
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS app_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts REAL NOT NULL,
                level TEXT NOT NULL,
                source TEXT NOT NULL,
                message TEXT NOT NULL,
                details_json TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_app_logs_ts
            ON app_logs(ts DESC)
            """
        )


async def log_event(level: str, source: str, message: str, details: Optional[dict] = None):
    ts = time.time()
    level_norm = (level or "INFO").upper()
    source_norm = (source or "app").strip().lower() or "app"
    details_json = None
    if details is not None:
        with suppress(Exception):
            details_json = json.dumps(details, separators=(",", ":"))
    try:
        async with sqlite_lock:
            with _db_connect() as conn:
                conn.execute(
                    """
                    INSERT INTO app_logs (ts, level, source, message, details_json)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (ts, level_norm, source_norm, str(message), details_json),
                )
                rows = conn.execute("SELECT COUNT(1) AS n FROM app_logs").fetchone()
                total = int(rows["n"]) if rows is not None else 0
                if total > LOG_ROWS_MAX:
                    conn.execute(
                        """
                        DELETE FROM app_logs
                        WHERE id IN (
                            SELECT id
                            FROM app_logs
                            ORDER BY ts ASC
                            LIMIT ?
                        )
                        """,
                        (LOG_PRUNE_BATCH,),
                    )
    except Exception as e:
        print(f"[LogDB] write failed: {e} | {level_norm} {source_norm}: {message}")


async def get_logs(limit: int = 200, level: Optional[str] = None, source: Optional[str] = None) -> list[dict]:
    safe_limit = max(1, min(1000, int(limit)))
    query = "SELECT id, ts, level, source, message, details_json FROM app_logs"
    params: list = []
    filters: list[str] = []
    if level:
        filters.append("level = ?")
        params.append(level.upper())
    if source:
        filters.append("source = ?")
        params.append(source.strip().lower())
    if filters:
        query += " WHERE " + " AND ".join(filters)
    query += " ORDER BY ts DESC LIMIT ?"
    params.append(safe_limit)

    async with sqlite_lock:
        with _db_connect() as conn:
            rows = conn.execute(query, tuple(params)).fetchall()
    out: list[dict] = []
    for r in rows:
        item = dict(r)
        raw_details = item.get("details_json")
        if isinstance(raw_details, str) and raw_details:
            with suppress(Exception):
                item["details"] = json.loads(raw_details)
        out.append(item)
    return out


async def get_db_health_summary() -> dict:
    try:
        async with sqlite_lock:
            with _db_connect() as conn:
                poi_count_row = conn.execute("SELECT COUNT(1) AS n FROM poi_favorites").fetchone()
                mission_count_row = conn.execute("SELECT COUNT(1) AS n FROM mission_history").fetchone()
                logs_count_row = conn.execute("SELECT COUNT(1) AS n FROM app_logs").fetchone()
        async with mission_presets_lock:
            preset_count = len(_load_mission_presets_sync())
        return {
            "ok": True,
            "db_path": str(DB_PATH),
            "poi_count": int(poi_count_row["n"]) if poi_count_row is not None else 0,
            "mission_history_count": int(mission_count_row["n"]) if mission_count_row is not None else 0,
            "logs_count": int(logs_count_row["n"]) if logs_count_row is not None else 0,
            "saved_mission_presets_count": preset_count,
        }
    except Exception as e:
        return {
            "ok": False,
            "db_path": str(DB_PATH),
            "error": str(e),
        }


async def discover_kotlin_on_subnet(
    subnet_prefix: str,
    port: int,
    timeout_s: float = 0.8,
    chunk_size: int = 24,
) -> Optional[str]:
    try:
        local_octet = int((_guess_local_lan_ip() or "0.0.0.0").split(".")[3])
    except Exception:
        local_octet = 0

    candidates: list[int] = []
    for d in range(0, 64):
        left = local_octet - d
        right = local_octet + d
        if 1 <= left <= 254:
            candidates.append(left)
        if d != 0 and 1 <= right <= 254:
            candidates.append(right)
    for i in range(1, 255):
        if i not in candidates:
            candidates.append(i)

    timeout = httpx.Timeout(timeout_s, connect=timeout_s, read=timeout_s, write=timeout_s)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for i in range(0, len(candidates), chunk_size):
            chunk = candidates[i:i + chunk_size]

            async def probe(octet: int) -> Optional[str]:
                ip = f"{subnet_prefix}.{octet}"
                try:
                    resp = await client.get(f"http://{ip}:{port}/status")
                    if resp.status_code != 200:
                        return None
                    data = resp.json()
                    if isinstance(data, dict) and str(data.get("status", "")).lower() == "ok":
                        return ip
                except Exception:
                    return None
                return None

            results = await asyncio.gather(*[probe(o) for o in chunk], return_exceptions=False)
            found = next((r for r in results if r), None)
            if found:
                return found
    return None


async def probe_kotlin_status(host: str, port: int, timeout_s: float = 0.9) -> bool:
    ip = _normalize_host(host)
    if not ip:
        return False
    timeout = httpx.Timeout(timeout_s, connect=timeout_s, read=timeout_s, write=timeout_s)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(f"http://{ip}:{port}/status")
        if resp.status_code != 200:
            return False
        data = resp.json()
        if not isinstance(data, dict):
            return False
        return str(data.get("status", "")).lower() == "ok"
    except Exception:
        return False


async def ensure_kotlin_target_on_startup() -> dict:
    host = KOTLIN_HOST
    port = KOTLIN_PORT
    if await probe_kotlin_status(host, port):
        await log_event("INFO", "config", "startup kotlin target reachable", {"kotlin_host": host, "kotlin_port": port})
        return {"reachable": True, "discovered": False, "kotlin_host": host, "kotlin_port": port}

    subnet_prefix = _host_to_subnet_prefix(host) or ""
    if not subnet_prefix:
        local_ip = _guess_local_lan_ip() or ""
        subnet_prefix = _host_to_subnet_prefix(local_ip) or ""
    if not subnet_prefix:
        await log_event(
            "WARN",
            "config",
            "startup kotlin target unreachable and subnet unavailable",
            {"kotlin_host": host, "kotlin_port": port},
        )
        return {"reachable": False, "discovered": False, "kotlin_host": host, "kotlin_port": port}

    found_ip = await discover_kotlin_on_subnet(subnet_prefix=subnet_prefix, port=port)
    if not found_ip:
        await log_event(
            "WARN",
            "config",
            "startup kotlin discovery failed",
            {"kotlin_host": host, "kotlin_port": port, "subnet_prefix": subnet_prefix},
        )
        return {"reachable": False, "discovered": False, "kotlin_host": host, "kotlin_port": port, "subnet_prefix": subnet_prefix}

    apply_network_settings({"kotlin_host": found_ip, "kotlin_port": port, "go2rtc_url": GO2RTC_URL})
    save_network_settings()
    await log_event(
        "INFO",
        "config",
        "startup kotlin target auto-discovered and applied",
        {"old_kotlin_host": host, "new_kotlin_host": found_ip, "kotlin_port": port, "subnet_prefix": subnet_prefix},
    )
    return {
        "reachable": True,
        "discovered": True,
        "kotlin_host": found_ip,
        "kotlin_port": port,
        "subnet_prefix": subnet_prefix,
    }


async def create_mission_history_entry(payload: dict) -> Optional[int]:
    mission_uuid = str(uuid4())
    mission_name = str(payload.get("mission_name") or f"mission-{mission_uuid[:8]}")
    waypoints = payload.get("waypoints") or []
    now = time.time()
    try:
        async with sqlite_lock:
            with _db_connect() as conn:
                cur = conn.execute(
                    """
                    INSERT INTO mission_history (
                        mission_uuid, mission_name, status, started_at, total_waypoints, payload_json, last_state, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        mission_uuid,
                        mission_name,
                        "SENT",
                        now,
                        len(waypoints),
                        json.dumps(payload, separators=(",", ":")),
                        "SENT",
                        now,
                    ),
                )
                mission_id = int(cur.lastrowid)
                for idx, wp in enumerate(waypoints):
                    conn.execute(
                        """
                        INSERT INTO mission_waypoints (
                            mission_id, waypoint_index, lat, lon, altitude, action, hover_seconds
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            mission_id,
                            idx,
                            float(wp.get("lat")),
                            float(wp.get("lon")),
                            float(wp.get("altitude", 30)),
                            str(wp.get("action", "NONE")),
                            float(wp.get("hover_seconds", 0) or 0),
                        ),
                    )
                return mission_id
    except Exception as e:
        print(f"[SQLite] create mission history failed: {e}")
        return None


async def update_active_mission_state(state: str):
    global active_mission_history_id
    if active_mission_history_id is None:
        return
    state_norm = (state or "").upper() or "UNKNOWN"
    terminal_states = {"FINISHED", "STOPPED", "FAILED", "ABORTED", "ERROR", "IDLE", "READY"}
    ended_at = time.time() if state_norm in terminal_states else None
    status = state_norm
    try:
        async with sqlite_lock:
            with _db_connect() as conn:
                if ended_at is None:
                    conn.execute(
                        "UPDATE mission_history SET status = ?, last_state = ? WHERE id = ?",
                        (status, state_norm, active_mission_history_id),
                    )
                else:
                    conn.execute(
                        "UPDATE mission_history SET status = ?, last_state = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ?",
                        (status, state_norm, ended_at, active_mission_history_id),
                    )
    except Exception as e:
        print(f"[SQLite] update mission state failed: {e}")
    if ended_at is not None:
        active_mission_history_id = None


async def get_mission_history(limit: int = 50) -> list[dict]:
    safe_limit = max(1, min(200, int(limit)))
    async with sqlite_lock:
        with _db_connect() as conn:
            rows = conn.execute(
                """
                SELECT id, mission_uuid, mission_name, status, started_at, ended_at, total_waypoints, last_state
                FROM mission_history
                ORDER BY started_at DESC
                LIMIT ?
                """,
                (safe_limit,),
            ).fetchall()
    return [dict(r) for r in rows]


async def get_mission_waypoints(mission_id: int) -> list[dict]:
    async with sqlite_lock:
        with _db_connect() as conn:
            rows = conn.execute(
                """
                SELECT waypoint_index, lat, lon, altitude, action, hover_seconds
                FROM mission_waypoints
                WHERE mission_id = ?
                ORDER BY waypoint_index ASC
                """,
                (mission_id,),
            ).fetchall()
    return [dict(r) for r in rows]


async def get_mission_by_id(mission_id: int) -> Optional[dict]:
    async with sqlite_lock:
        with _db_connect() as conn:
            row = conn.execute(
                """
                SELECT id, mission_uuid, mission_name, status, started_at, ended_at, total_waypoints, last_state
                FROM mission_history
                WHERE id = ?
                """,
                (mission_id,),
            ).fetchone()
    return dict(row) if row else None


async def list_poi() -> list[dict]:
    async with sqlite_lock:
        with _db_connect() as conn:
            rows = conn.execute(
                """
                SELECT id, name, lat, lon, altitude, note, created_at, updated_at
                FROM poi_favorites
                ORDER BY updated_at DESC
                """
            ).fetchall()
    return [dict(r) for r in rows]


async def create_poi(payload: dict) -> Optional[dict]:
    now = time.time()
    try:
        name = str(payload.get("name", "")).strip()
        lat = float(payload.get("lat"))
        lon = float(payload.get("lon"))
        altitude = float(payload.get("altitude", 30))
        note = str(payload.get("note") or "").strip() or None
        if not name:
            return None
    except Exception:
        return None
    async with sqlite_lock:
        with _db_connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO poi_favorites (name, lat, lon, altitude, note, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (name, lat, lon, altitude, note, now, now),
            )
            poi_id = int(cur.lastrowid)
            row = conn.execute(
                "SELECT id, name, lat, lon, altitude, note, created_at, updated_at FROM poi_favorites WHERE id = ?",
                (poi_id,),
            ).fetchone()
    return dict(row) if row else None


async def update_poi(poi_id: int, payload: dict) -> Optional[dict]:
    async with sqlite_lock:
        with _db_connect() as conn:
            current = conn.execute(
                "SELECT id, name, lat, lon, altitude, note FROM poi_favorites WHERE id = ?",
                (poi_id,),
            ).fetchone()
            if current is None:
                return None
            try:
                name = str(payload.get("name", current["name"])).strip()
                lat = float(payload.get("lat", current["lat"]))
                lon = float(payload.get("lon", current["lon"]))
                altitude = float(payload.get("altitude", current["altitude"]))
                note_raw = payload.get("note", current["note"])
                note = str(note_raw).strip() if note_raw is not None else None
                note = note or None
                if not name:
                    return None
            except Exception:
                return None
            conn.execute(
                """
                UPDATE poi_favorites
                SET name = ?, lat = ?, lon = ?, altitude = ?, note = ?, updated_at = ?
                WHERE id = ?
                """,
                (name, lat, lon, altitude, note, time.time(), poi_id),
            )
            row = conn.execute(
                "SELECT id, name, lat, lon, altitude, note, created_at, updated_at FROM poi_favorites WHERE id = ?",
                (poi_id,),
            ).fetchone()
    return dict(row) if row else None


async def delete_poi(poi_id: int) -> bool:
    async with sqlite_lock:
        with _db_connect() as conn:
            cur = conn.execute("DELETE FROM poi_favorites WHERE id = ?", (poi_id,))
            return int(cur.rowcount) > 0


load_network_settings()
init_sqlite()

# ─────────────────────────────────────────────────────────────────────────────
# STATO GLOBALE (in-memory, aggiornato in real-time)
# ─────────────────────────────────────────────────────────────────────────────

class DroneReservationManager:
    def __init__(self):
        self._holder: Optional[dict] = None
        self._queue: list[dict] = []

    def _now(self) -> float:
        return time.time()

    def _cleanup(self):
        now = self._now()
        if self._holder and float(self._holder.get("expires_at", 0)) <= now:
            self._holder = None
        self._queue = [item for item in self._queue if float(item.get("expires_at", 0)) > now]
        if self._holder is None and self._queue:
            self._holder = self._queue.pop(0)
            self._holder["reserved_at"] = now
            self._holder["expires_at"] = now + DRONE_LEASE_TTL_SECONDS

    def reserve(self, operator_id: str, operator_name: str, client_host: str = "") -> dict:
        operator_id = (operator_id or "").strip()
        operator_name = (operator_name or "").strip() or "Operatore"
        if not operator_id:
            return {"ok": False, "reserved": False, "error": "operator_id mancante", **self.snapshot()}
        self._cleanup()
        now = self._now()
        if self._holder is None or self._holder.get("operator_id") == operator_id:
            reserved_at = self._holder.get("reserved_at", now) if self._holder else now
            self._holder = {
                "operator_id": operator_id,
                "operator_name": operator_name,
                "client_host": client_host,
                "reserved_at": reserved_at,
                "expires_at": now + DRONE_LEASE_TTL_SECONDS,
            }
            self._queue = [item for item in self._queue if item.get("operator_id") != operator_id]
            return {"ok": True, "reserved": True, "queue_position": 0, **self.snapshot()}

        queued = next((item for item in self._queue if item.get("operator_id") == operator_id), None)
        if queued is None:
            queued = {
                "operator_id": operator_id,
                "operator_name": operator_name,
                "client_host": client_host,
                "reserved_at": now,
                "expires_at": now + DRONE_LEASE_TTL_SECONDS * 2,
            }
            self._queue.append(queued)
        else:
            queued["operator_name"] = operator_name
            queued["client_host"] = client_host
            queued["expires_at"] = now + DRONE_LEASE_TTL_SECONDS * 2
        return {
            "ok": True,
            "reserved": False,
            "queued": True,
            "queue_position": 1 + self._queue.index(queued),
            **self.snapshot(),
        }

    def heartbeat(self, operator_id: str) -> dict:
        operator_id = (operator_id or "").strip()
        self._cleanup()
        now = self._now()
        if self._holder and self._holder.get("operator_id") == operator_id:
            self._holder["expires_at"] = now + DRONE_LEASE_TTL_SECONDS
            return {"ok": True, "reserved": True, "queue_position": 0, **self.snapshot()}
        for idx, item in enumerate(self._queue):
            if item.get("operator_id") == operator_id:
                item["expires_at"] = now + DRONE_LEASE_TTL_SECONDS * 2
                return {"ok": True, "reserved": False, "queued": True, "queue_position": idx + 1, **self.snapshot()}
        return {"ok": False, "reserved": False, "error": "operatore non in controllo/coda", **self.snapshot()}

    def release(self, operator_id: str) -> dict:
        operator_id = (operator_id or "").strip()
        self._cleanup()
        released = False
        if self._holder and self._holder.get("operator_id") == operator_id:
            self._holder = None
            released = True
        old_len = len(self._queue)
        self._queue = [item for item in self._queue if item.get("operator_id") != operator_id]
        released = released or old_len != len(self._queue)
        self._cleanup()
        return {"ok": released, "released": released, **self.snapshot()}

    def can_control(self, operator_id: Optional[str]) -> bool:
        self._cleanup()
        if self._holder is None:
            return True
        return bool(operator_id and self._holder.get("operator_id") == operator_id)

    def heartbeat_if_holder(self, operator_id: Optional[str]):
        if operator_id and self._holder and self._holder.get("operator_id") == operator_id:
            self._holder["expires_at"] = self._now() + DRONE_LEASE_TTL_SECONDS

    def snapshot(self) -> dict:
        self._cleanup()
        now = self._now()
        holder = dict(self._holder) if self._holder else None
        if holder:
            holder["ttl_seconds"] = max(0, round(float(holder["expires_at"]) - now, 1))
        queue = []
        for idx, item in enumerate(self._queue):
            queued = dict(item)
            queued["position"] = idx + 1
            queued["ttl_seconds"] = max(0, round(float(queued["expires_at"]) - now, 1))
            queue.append(queued)
        return {
            "drone": {
                "id": CONTROLLED_DRONE_ID,
                "name": CONTROLLED_DRONE_NAME,
                "model": CONTROLLED_DRONE_MODEL,
                "connected": drone_state.connected if "drone_state" in globals() else False,
                "product_name": drone_state.product_name if "drone_state" in globals() else None,
            },
            "reservation": {
                "held": holder is not None,
                "holder": holder,
                "queue": queue,
                "queue_length": len(queue),
                "lease_ttl_seconds": DRONE_LEASE_TTL_SECONDS,
            },
        }


drone_reservations = DroneReservationManager()


def _operator_id_from_request(request: Request) -> Optional[str]:
    return request.headers.get("x-operator-id") or request.query_params.get("operator_id")


async def command_blocked_response(request: Request) -> Optional[dict]:
    operator_id = _operator_id_from_request(request)
    if drone_reservations.can_control(operator_id):
        drone_reservations.heartbeat_if_holder(operator_id)
        return None
    snap = drone_reservations.snapshot()
    return {
        "sent": False,
        "reserved": False,
        "error": "Drone occupato da un altro operatore",
        "reservation": snap["reservation"],
        "drone": snap["drone"],
    }


class DroneState:
    def __init__(self):
        self.connected: bool = False
        self.product_name: Optional[str] = None
        self.home_lat: Optional[float] = None
        self.home_lon: Optional[float] = None

        # Telemetria
        self.latitude: Optional[float] = None
        self.longitude: Optional[float] = None
        self.altitude: Optional[float] = None
        self.pitch: Optional[float] = None
        self.roll: Optional[float] = None
        self.yaw: Optional[float] = None
        self.velocity_x: Optional[float] = None
        self.velocity_y: Optional[float] = None
        self.velocity_z: Optional[float] = None
        self.gimbal_pitch: Optional[float] = None
        self.gimbal_roll: Optional[float] = None
        self.gimbal_yaw: Optional[float] = None
        self.gimbal_yaw_relative: Optional[float] = None
        self.is_flying: bool = False
        self.gps_signal: Optional[int] = None

        # Batteria
        self.battery_percent: Optional[int] = None
        self.battery_temp: Optional[float] = None

        # Missione
        self.mission_state: Optional[str] = None
        self.mission_waypoint: Optional[int] = None
        self.mission_name: Optional[str] = None
        self.mission_wayline_id: Optional[int] = None
        self.delivery_waiting_operator: bool = False
        self.delivery_pending_return: bool = False
        self.delivery_split_waypoint_index: Optional[int] = None

        # Atterraggio
        self.landing_confirmation_needed: bool = False

        # Storico posizioni per trail 3D (max 200 punti)
        self.position_history: deque = deque(maxlen=200)


        self.last_update: float = 0.0

    def to_dict(self) -> dict:
        return {
            "connected": self.connected,
            "product_name": self.product_name,
            "current_camera": current_camera_mode,
            "home": {
                "lat": self.home_lat,
                "lon": self.home_lon,
            },
            "telemetry": {
                "latitude": self.latitude,
                "longitude": self.longitude,
                "altitude": self.altitude,
                "pitch": self.pitch,
                "roll": self.roll,
                "yaw": self.yaw,
                "velocity_x": self.velocity_x,
                "velocity_y": self.velocity_y,
                "velocity_z": self.velocity_z,
                "gimbal_pitch": self.gimbal_pitch,
                "gimbal_roll": self.gimbal_roll,
                "gimbal_yaw": self.gimbal_yaw,
                "gimbal_yaw_relative": self.gimbal_yaw_relative,
                "is_flying": self.is_flying,
                "gps_signal": self.gps_signal,
            },
            "battery": {
                "percent": self.battery_percent,
                "temperature": self.battery_temp,
            },
            "mission": {
                "state": self.mission_state,
                "waypoint_index": self.mission_waypoint,
                "mission_name": self.mission_name,
                "wayline_id": self.mission_wayline_id,
            },
            "delivery": {
                "waiting_operator": self.delivery_waiting_operator,
                "pending_return": self.delivery_pending_return,
                "split_waypoint_index": self.delivery_split_waypoint_index,
            },
            "landing_confirmation_needed": self.landing_confirmation_needed,
            "reservation": drone_reservations.snapshot()["reservation"],
            "position_history": list(self.position_history)[-50:],  # ultimi 50 punti
            "last_update": self.last_update,
        }


drone_state = DroneState()


def save_home_point():
    HOME_POINT_PATH.write_text(
        json.dumps(
            {
                "lat": drone_state.home_lat,
                "lon": drone_state.home_lon,
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def load_home_point():
    if not HOME_POINT_PATH.exists():
        return
    try:
        data = json.loads(HOME_POINT_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            lat = data.get("lat")
            lon = data.get("lon")
            if lat is not None and lon is not None:
                drone_state.home_lat = float(lat)
                drone_state.home_lon = float(lon)
    except Exception as e:
        print(f"[Config] Impossibile leggere {HOME_POINT_PATH.name}: {e}")


def set_home_point(lat: float, lon: float):
    drone_state.home_lat = float(lat)
    drone_state.home_lon = float(lon)
    save_home_point()


load_home_point()

# ─────────────────────────────────────────────────────────────────────────────
# BROKER: raccoglie client WebSocket Python (browser)
# ─────────────────────────────────────────────────────────────────────────────

class ClientBroker:
    """Gestisce i client WebSocket browser che si collegano a FastAPI."""

    def __init__(self):
        self.telemetry_clients: dict[WebSocket, "TelemetryClient"] = {}
        self._lock = asyncio.Lock()

    async def add_telemetry(self, ws: WebSocket):
        client = TelemetryClient(ws, self)
        async with self._lock:
            self.telemetry_clients[ws] = client

    async def remove_telemetry(self, ws: WebSocket):
        client = None
        async with self._lock:
            client = self.telemetry_clients.pop(ws, None)
        if client is not None:
            await client.close()

    async def broadcast_telemetry(self, data: dict):
        msg = json.dumps(data, separators=(",", ":"))
        async with self._lock:
            clients = list(self.telemetry_clients.values())
        for client in clients:
            client.publish(msg)


class TelemetryClient:
    """Sender dedicato per client: coda max=1 (latest-wins)."""

    def __init__(self, ws: WebSocket, broker: ClientBroker):
        self.ws = ws
        self.broker = broker
        self.queue: asyncio.Queue[str] = asyncio.Queue(maxsize=1)
        self.sender_task = asyncio.create_task(self._sender_loop())

    def publish(self, payload: str):
        if self.queue.full():
            with suppress(asyncio.QueueEmpty):
                self.queue.get_nowait()
        with suppress(asyncio.QueueFull):
            self.queue.put_nowait(payload)

    async def _sender_loop(self):
        try:
            while True:
                payload = await self.queue.get()
                await self.ws.send_text(payload)
        except Exception:
            await self.broker.remove_telemetry(self.ws)

    async def close(self):
        self.sender_task.cancel()
        if asyncio.current_task() is self.sender_task:
            return
        with suppress(asyncio.CancelledError):
            await self.sender_task




broker = ClientBroker()
MOBILE_UA_HINTS = ("android", "iphone", "ipad", "mobile", "expo", "okhttp")


def is_mobile_user_agent(user_agent: str) -> bool:
    ua = (user_agent or "").lower()
    return any(h in ua for h in MOBILE_UA_HINTS)

# ─────────────────────────────────────────────────────────────────────────────
# KOTLIN WS BRIDGE (background task)
# ─────────────────────────────────────────────────────────────────────────────

kotlin_ws: Optional[websockets.WebSocketClientProtocol] = None
kotlin_ws_lock = asyncio.Lock()
pending_ack_waiters: dict[str, deque[asyncio.Future]] = defaultdict(deque)
go2rtc_client: Optional[httpx.AsyncClient] = None
go2rtc_process: Optional[subprocess.Popen] = None
go2rtc_log_task: Optional[asyncio.Task] = None
go2rtc_log_tail: deque[str] = deque(maxlen=120)
terrain_cache: dict[str, Optional[float]] = {}
current_camera_mode = "WIDE"
mock_mission_task: Optional[asyncio.Task] = None
mock_paused = asyncio.Event()
mock_paused.set()
last_telemetry_broadcast_perf = 0.0


class PresetRuntime:
    def __init__(self):
        self.active_preset: Optional[str] = None
        self.phase: str = "idle"
        self.message: str = ""
        self.updated_at: float = 0.0
        self.delivery_waiting_operator: bool = False
        self.delivery_return_authorized = asyncio.Event()
        self.delivery_task: Optional[asyncio.Task] = None

    def set(self, phase: str, message: str = ""):
        self.phase = phase
        self.message = message
        self.updated_at = time.time()

    def to_dict(self) -> dict:
        return {
            "active_preset": self.active_preset,
            "phase": self.phase,
            "message": self.message,
            "delivery_waiting_operator": self.delivery_waiting_operator,
            "updated_at": self.updated_at,
        }


preset_runtime = PresetRuntime()


def find_go2rtc_executable() -> Optional[Path]:
    base_dir = Path(__file__).resolve().parent
    candidates = [
        base_dir / "go2rtc" / "go2rtc.exe",
        base_dir / "go2rtc" / "go2rtc",
        base_dir.parent / "go2rtc" / "go2rtc.exe",
        base_dir.parent / "go2rtc" / "go2rtc",
        base_dir / "go2rtc.exe",
        base_dir / "go2rtc",
        base_dir.parent / "go2rtc.exe",
        base_dir.parent / "go2rtc",
    ]
    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


def find_go2rtc_config(exe: Path) -> Optional[Path]:
    candidates = [
        exe.parent / "go2rtc.yaml",
        exe.parent / "go2rtc.yml",
        Path(__file__).resolve().parent / "go2rtc.yaml",
        Path(__file__).resolve().parent / "go2rtc.yml",
    ]
    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


def _go2rtc_log(line: str):
    cleaned = line.strip()
    if not cleaned:
        return
    stamp = time.strftime("%H:%M:%S")
    entry = f"{stamp} {cleaned}"
    go2rtc_log_tail.append(entry)
    print(f"[go2rtc] {cleaned}")


async def _pump_go2rtc_output(proc: subprocess.Popen):
    stream = proc.stdout
    if stream is None:
        return
    loop = asyncio.get_running_loop()
    try:
        while True:
            line = await loop.run_in_executor(None, stream.readline)
            if not line:
                break
            _go2rtc_log(str(line).rstrip())
    except asyncio.CancelledError:
        raise
    except Exception as e:
        _go2rtc_log(f"log pump failed: {e}")


async def check_go2rtc_health(source: str = "startup") -> dict:
    client = go2rtc_client
    close_after = False
    if client is None:
        client = httpx.AsyncClient(timeout=4.0)
        close_after = True
    try:
        result: dict = {
            "url": GO2RTC_URL,
            "source": source,
            "process_running": go2rtc_process is not None and go2rtc_process.poll() is None,
        }
        exe = find_go2rtc_executable()
        config = find_go2rtc_config(exe) if exe is not None else None
        result["exe"] = str(exe) if exe else None
        result["config"] = str(config) if config else None
        if config is not None:
            with suppress(Exception):
                config_text = config.read_text(encoding="utf-8-sig")
                result["config_mentions_kotlin_host"] = KOTLIN_HOST in config_text
                if KOTLIN_HOST not in config_text:
                    result["config_warning"] = f"go2rtc config may still point to an old RTSP IP; current Kotlin host is {KOTLIN_HOST}"
        try:
            streams = await client.get(f"{GO2RTC_URL}/api/streams", timeout=4.0)
            result["streams_status"] = streams.status_code
            result["streams_preview"] = streams.text[:900]
        except Exception as e:
            result["streams_error"] = str(e)
        try:
            frame = await client.get(f"{GO2RTC_URL}/api/frame.jpeg?src=dji", timeout=5.0)
            result["frame_status"] = frame.status_code
            result["frame_content_type"] = frame.headers.get("content-type")
            result["frame_bytes"] = len(frame.content)
        except Exception as e:
            result["frame_error"] = str(e)
        await log_event("INFO", "go2rtc", "go2rtc health check", result)
        print(f"[go2rtc] Health {source}: {result}")
        return result
    finally:
        if close_after:
            await client.aclose()


async def start_go2rtc_process():
    global go2rtc_process, go2rtc_log_task
    if go2rtc_process is not None and go2rtc_process.poll() is None:
        await check_go2rtc_health("already_running")
        return
    exe = find_go2rtc_executable()
    if exe is None:
        await log_event(
            "WARN",
            "go2rtc",
            "go2rtc executable not found",
            {"searched": [str(Path(__file__).resolve().parent), str(Path(__file__).resolve().parent.parent)]},
        )
        print("[go2rtc] Eseguibile non trovato: metti go2rtc.exe nella cartella ZephyrDronePythonMiddleware o nella root progetto")
        return
    creationflags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0
    config = find_go2rtc_config(exe)
    cmd = [str(exe)]
    if config is not None:
        cmd.append(config.name if config.parent == exe.parent else str(config))
    try:
        config_text = None
        if config is not None:
            with suppress(Exception):
                config_text = config.read_text(encoding="utf-8-sig")
        await log_event(
            "INFO",
            "go2rtc",
            "go2rtc start requested",
            {
                "exe": str(exe),
                "cwd": str(exe.parent),
                "config": str(config) if config else None,
                "go2rtc_url": GO2RTC_URL,
                "kotlin_host": KOTLIN_HOST,
                "config_preview": config_text[:1200] if config_text else None,
            },
        )
        print(f"[go2rtc] Start request exe={exe} cwd={exe.parent} config={config} api={GO2RTC_URL} kotlin={KOTLIN_HOST}:{KOTLIN_PORT}")
        go2rtc_process = subprocess.Popen(
            cmd,
            cwd=str(exe.parent),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=creationflags,
        )
        go2rtc_log_task = asyncio.create_task(_pump_go2rtc_output(go2rtc_process))
        await log_event("INFO", "go2rtc", "go2rtc process started", {"cmd": cmd, "pid": go2rtc_process.pid})
        print(f"[go2rtc] Avviato: {' '.join(cmd)} (pid={go2rtc_process.pid})")
        await asyncio.sleep(1.2)
        if go2rtc_process.poll() is not None:
            await log_event(
                "ERROR",
                "go2rtc",
                "go2rtc exited immediately",
                {"pid": go2rtc_process.pid, "exit_code": go2rtc_process.poll(), "tail": list(go2rtc_log_tail)[-30:]},
            )
            print(f"[go2rtc] Uscito subito con codice {go2rtc_process.poll()}")
        await check_go2rtc_health("startup")
    except Exception as e:
        go2rtc_process = None
        await log_event("ERROR", "go2rtc", "go2rtc start failed", {"exe": str(exe), "error": str(e)})
        print(f"[go2rtc] Avvio fallito: {e}")


async def stop_go2rtc_process():
    global go2rtc_process, go2rtc_log_task
    if go2rtc_log_task is not None:
        go2rtc_log_task.cancel()
        with suppress(asyncio.CancelledError):
            await go2rtc_log_task
        go2rtc_log_task = None
    proc = go2rtc_process
    go2rtc_process = None
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.terminate()
        with suppress(Exception):
            proc.wait(timeout=3)
        if proc.poll() is None:
            proc.kill()
        await log_event("INFO", "go2rtc", "go2rtc process stopped", {"pid": proc.pid})
    except Exception as e:
        await log_event("WARN", "go2rtc", "go2rtc stop failed", {"pid": proc.pid, "error": str(e)})


def _mock_init_state():
    drone_state.connected = True
    drone_state.product_name = "Zephyr Mock Drone"
    drone_state.latitude = MOCK_START_LAT
    drone_state.longitude = MOCK_START_LON
    drone_state.altitude = 0.0
    drone_state.pitch = 0.0
    drone_state.roll = 0.0
    drone_state.yaw = 18.0
    drone_state.velocity_x = 0.0
    drone_state.velocity_y = 0.0
    drone_state.velocity_z = 0.0
    drone_state.gimbal_pitch = -12.0
    drone_state.gimbal_roll = 0.0
    drone_state.gimbal_yaw = 0.0
    drone_state.gimbal_yaw_relative = 0.0
    drone_state.is_flying = False
    drone_state.gps_signal = 5
    drone_state.battery_percent = 87
    drone_state.battery_temp = 28.5
    drone_state.mission_state = "READY"
    drone_state.home_lat = drone_state.home_lat if drone_state.home_lat is not None else MOCK_START_LAT
    drone_state.home_lon = drone_state.home_lon if drone_state.home_lon is not None else MOCK_START_LON
    drone_state.last_update = time.time()
    drone_state.position_history.append({"lat": MOCK_START_LAT, "lon": MOCK_START_LON, "alt": 0.0, "t": drone_state.last_update})


async def _mock_broadcast(event_type: str = "state_snapshot"):
    drone_state.last_update = time.time()
    await broker.broadcast_telemetry({
        "type": event_type,
        "state_snapshot": drone_state.to_dict(),
    })


def _mock_clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _mock_smoothstep(t: float) -> float:
    t = _mock_clamp(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _mock_set_velocity(prev_lat: float, prev_lon: float, prev_alt: float, dt: float):
    lat = float(drone_state.latitude or prev_lat)
    lon = float(drone_state.longitude or prev_lon)
    alt = float(drone_state.altitude or prev_alt)
    drone_state.velocity_x = (lat - prev_lat) * 111_320 / max(dt, 0.001)
    drone_state.velocity_y = (lon - prev_lon) * 111_320 / max(dt, 0.001)
    drone_state.velocity_z = (alt - prev_alt) / max(dt, 0.001)


async def _mock_move_to(lat: float, lon: float, alt: float, speed_mps: float = 9.0):
    prev_lat = float(drone_state.latitude or MOCK_START_LAT)
    prev_lon = float(drone_state.longitude or MOCK_START_LON)
    prev_alt = float(drone_state.altitude or 0)
    lat_scale = 111_320
    lon_scale = 111_320 * max(0.2, abs(math.cos(math.radians(prev_lat))))
    planar_m = (((lat - prev_lat) * lat_scale) ** 2 + ((lon - prev_lon) * lon_scale) ** 2) ** 0.5
    alt_m = abs(alt - prev_alt)
    duration = max(1.0, min(18.0, max(planar_m / max(speed_mps, 1.0), alt_m / 3.0)))
    dt = 1.0 / MOCK_TELEMETRY_HZ
    steps = max(MOCK_TELEMETRY_HZ, int(duration * MOCK_TELEMETRY_HZ))
    next_tick = time.perf_counter()
    prev_vx = float(drone_state.velocity_x or 0)
    prev_vy = float(drone_state.velocity_y or 0)
    prev_vz = float(drone_state.velocity_z or 0)
    for i in range(1, steps + 1):
        await mock_paused.wait()
        raw_t = i / steps
        t = _mock_smoothstep(raw_t)
        old_lat = float(drone_state.latitude or prev_lat)
        old_lon = float(drone_state.longitude or prev_lon)
        old_alt = float(drone_state.altitude or prev_alt)
        drone_state.latitude = prev_lat + (lat - prev_lat) * t
        drone_state.longitude = prev_lon + (lon - prev_lon) * t
        drone_state.altitude = prev_alt + (alt - prev_alt) * t
        _mock_set_velocity(old_lat, old_lon, old_alt, dt)
        vx = float(drone_state.velocity_x or 0)
        vy = float(drone_state.velocity_y or 0)
        vz = float(drone_state.velocity_z or 0)
        ax = (vx - prev_vx) / dt
        ay = (vy - prev_vy) / dt
        az = (vz - prev_vz) / dt
        horizontal_speed = (vx * vx + vy * vy) ** 0.5
        if horizontal_speed > 0.2:
            drone_state.yaw = (math.degrees(math.atan2(vy, vx)) + 360) % 360
        accel = (ax * ax + ay * ay) ** 0.5
        accel_sign = 1 if raw_t < 0.5 else -1
        drone_state.pitch = _mock_clamp(-(horizontal_speed / max(speed_mps, 1.0)) * 7.0 + accel_sign * min(accel / 9.81, 1.0) * -2.5, -15.0, 8.0)
        drone_state.roll = _mock_clamp((ay / 9.81) * 4.5, -12.0, 12.0)
        drone_state.velocity_z = vz + _mock_clamp(az * 0.02, -0.4, 0.4)
        prev_vx, prev_vy, prev_vz = vx, vy, vz
        drone_state.position_history.append({"lat": drone_state.latitude, "lon": drone_state.longitude, "alt": drone_state.altitude, "t": time.time()})
        next_tick += dt
        await asyncio.sleep(max(0.0, next_tick - time.perf_counter()))


async def _mock_takeoff(target_alt: float = 12.0):
    drone_state.connected = True
    drone_state.is_flying = True
    drone_state.mission_state = "TAKING_OFF"
    await _mock_broadcast("mission_state")
    await _mock_move_to(float(drone_state.latitude or MOCK_START_LAT), float(drone_state.longitude or MOCK_START_LON), target_alt, 4.0)
    drone_state.mission_state = "READY"
    drone_state.velocity_x = drone_state.velocity_y = drone_state.velocity_z = 0.0
    await _mock_broadcast("mission_state")


async def _mock_land(require_confirmation: bool = True):
    drone_state.mission_state = "LANDING"
    await _mock_broadcast("mission_state")
    await _mock_move_to(float(drone_state.latitude or MOCK_START_LAT), float(drone_state.longitude or MOCK_START_LON), 2.0, 3.0)
    if require_confirmation:
        drone_state.landing_confirmation_needed = True
        await _mock_broadcast("landing_confirmation_needed")
        return
    drone_state.altitude = 0.0
    drone_state.is_flying = False
    drone_state.mission_state = "READY"
    drone_state.landing_confirmation_needed = False
    await _mock_broadcast("mission_state")


async def _mock_run_mission(payload: dict):
    global active_mission_history_id, pending_delivery_return_payload
    waypoints = payload.get("waypoints") if isinstance(payload.get("waypoints"), list) else []
    if not drone_state.is_flying:
        await _mock_takeoff(float(waypoints[0].get("altitude", 12)) if waypoints else 12.0)
    drone_state.mission_state = "EXECUTING"
    drone_state.mission_name = payload.get("mission_name") or "mock-mission"
    await update_active_mission_state("EXECUTING")
    await _mock_broadcast("mission_state")
    for idx, wp in enumerate(waypoints):
        await mock_paused.wait()
        drone_state.mission_waypoint = idx
        await _mock_broadcast("mission_progress")
        await _mock_move_to(float(wp.get("lat")), float(wp.get("lon")), float(wp.get("altitude", 30)), float(payload.get("auto_speed", 7) or 7))
        hover = float(wp.get("hover_seconds", 0) or 0)
        if hover > 0:
            await asyncio.sleep(min(hover, 5.0))
        if str(wp.get("action", "NONE")).upper() == "TAKE_PHOTO":
            await log_event("INFO", "mock", "mock photo captured", {"waypoint_index": idx})
    if str(payload.get("finished_action", "GO_HOME")).upper() == "LAND":
        await _mock_land(require_confirmation=True)
        return
    if pending_delivery_return_payload is not None:
        drone_state.mission_state = "WAITING_OPERATOR"
        drone_state.delivery_waiting_operator = True
        drone_state.delivery_pending_return = True
        await update_active_mission_state("WAITING_OPERATOR")
        await _mock_broadcast("mission_state")
        return
    drone_state.mission_state = "FINISHED"
    drone_state.mission_waypoint = None
    await update_active_mission_state("FINISHED")
    await _mock_broadcast("mission_state")


async def _mock_send(payload: dict) -> bool:
    global mock_mission_task, pending_delivery_return_payload
    t = str(payload.get("type") or "")
    drone_state.connected = True
    if t == "takeoff":
        asyncio.create_task(_mock_takeoff())
    elif t == "land":
        asyncio.create_task(_mock_land(require_confirmation=True))
    elif t == "confirm_landing":
        drone_state.landing_confirmation_needed = False
        drone_state.altitude = 0.0
        drone_state.is_flying = False
        if pending_delivery_return_payload is not None:
            drone_state.mission_state = "WAITING_OPERATOR"
            drone_state.delivery_waiting_operator = True
            drone_state.delivery_pending_return = True
            await update_active_mission_state("WAITING_OPERATOR")
        else:
            drone_state.mission_state = "READY"
        await _mock_broadcast("landing_confirmation_needed")
    elif t == "return_home":
        asyncio.create_task(_mock_move_to(float(drone_state.home_lat or MOCK_START_LAT), float(drone_state.home_lon or MOCK_START_LON), max(float(drone_state.altitude or 12), 12)))
    elif t == "set_home":
        set_home_point(float(payload.get("lat")), float(payload.get("lon")))
        await _mock_broadcast("home_updated")
    elif t == "start_mission":
        if mock_mission_task and not mock_mission_task.done():
            mock_mission_task.cancel()
        mock_paused.set()
        mock_mission_task = asyncio.create_task(_mock_run_mission(dict(payload)))
    elif t == "pause_mission":
        mock_paused.clear()
        drone_state.mission_state = "PAUSED"
        await update_active_mission_state("PAUSED")
        await _mock_broadcast("mission_state")
    elif t == "resume_mission":
        mock_paused.set()
        drone_state.mission_state = "EXECUTING"
        await update_active_mission_state("EXECUTING")
        await _mock_broadcast("mission_state")
    elif t == "stop_mission":
        if mock_mission_task and not mock_mission_task.done():
            mock_mission_task.cancel()
        drone_state.mission_state = "STOPPED"
        drone_state.mission_waypoint = None
        await update_active_mission_state("STOPPED")
        await _mock_broadcast("mission_state")
    elif t == "set_zoom":
        await log_event("INFO", "mock", "mock zoom", {"ratio": payload.get("ratio")})
    elif t == "thermal_spot_measure":
        await log_event("INFO", "mock", "mock thermal spot measure", payload)
    elif t in {"gimbal_rotate_speed", "gimbal_rotate_angle", "gimbal_reset", "switch_camera", "take_photo", "start_recording", "stop_recording"}:
        await log_event("INFO", "mock", f"mock command {t}", payload)
    return True


async def mock_drone_loop():
    _mock_init_state()
    await log_event("INFO", "mock", "mock drone mode started", {"lat": MOCK_START_LAT, "lon": MOCK_START_LON})
    dt = 1.0 / MOCK_TELEMETRY_HZ
    next_tick = time.perf_counter()
    while True:
        await _mock_broadcast("telemetry")
        next_tick += dt
        await asyncio.sleep(max(0.0, next_tick - time.perf_counter()))


async def handle_kotlin_message(raw: str):
    """Parsa un messaggio dal Kotlin server e aggiorna lo stato."""
    global current_camera_mode, last_telemetry_broadcast_perf
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        await log_event("WARN", "bridge", "non-json message from kotlin", {"raw": raw[:300]})
        return

    t = msg.get("type")
    should_broadcast = True

    if t == "connection_changed":
        drone_state.connected = msg.get("connected", False)
        drone_state.product_name = msg.get("product_name")
        if not drone_state.connected:
            drone_state.landing_confirmation_needed = False

    elif t == "telemetry":
        if "latitude"  in msg: drone_state.latitude   = msg["latitude"]
        if "longitude" in msg: drone_state.longitude  = msg["longitude"]
        if "altitude"  in msg: drone_state.altitude   = msg["altitude"]
        if "pitch"     in msg: drone_state.pitch       = msg["pitch"]
        if "roll"      in msg: drone_state.roll        = msg["roll"]
        if "yaw"       in msg: drone_state.yaw         = msg["yaw"]
        if "velocity_x" in msg: drone_state.velocity_x = msg["velocity_x"]
        if "velocity_y" in msg: drone_state.velocity_y = msg["velocity_y"]
        if "velocity_z" in msg: drone_state.velocity_z = msg["velocity_z"]
        if "gimbal_pitch" in msg: drone_state.gimbal_pitch = msg["gimbal_pitch"]
        if "gimbal_roll" in msg: drone_state.gimbal_roll = msg["gimbal_roll"]
        if "gimbal_yaw" in msg: drone_state.gimbal_yaw = msg["gimbal_yaw"]
        if "gimbal_yaw_relative" in msg: drone_state.gimbal_yaw_relative = msg["gimbal_yaw_relative"]
        if "is_flying"  in msg: drone_state.is_flying  = msg["is_flying"]
        if "gps_signal" in msg: drone_state.gps_signal = msg["gps_signal"]

        # Aggiungi al trail 3D se abbiamo posizione + altitudine
        if (
            drone_state.latitude is not None
            and drone_state.longitude is not None
            and drone_state.altitude is not None
        ):
            drone_state.position_history.append({
                "lat": drone_state.latitude,
                "lon": drone_state.longitude,
                "alt": drone_state.altitude,
                "t":   time.time(),
            })
        now_perf = time.perf_counter()
        if now_perf - last_telemetry_broadcast_perf < TELEMETRY_BROADCAST_INTERVAL_S:
            should_broadcast = False
        else:
            last_telemetry_broadcast_perf = now_perf

    elif t == "battery":
        drone_state.battery_percent = msg.get("charge_percent")
        if "temperature" in msg:
            drone_state.battery_temp = msg["temperature"]



    elif t == "mission_state":
        global pending_delivery_return_payload
        incoming_state = str(msg.get("state") or "")
        state_norm = incoming_state.upper() if incoming_state else "UNKNOWN"
        if pending_delivery_return_payload is not None and state_norm in {"FINISHED", "READY", "IDLE"}:
            drone_state.mission_state = "WAITING_OPERATOR"
            drone_state.delivery_waiting_operator = True
            drone_state.delivery_pending_return = True
            await update_active_mission_state("WAITING_OPERATOR")
            should_broadcast = True
        else:
            drone_state.mission_state = msg.get("state")
            await update_active_mission_state(str(drone_state.mission_state or "UNKNOWN"))
        if drone_state.mission_state in {"IDLE", "READY", "FINISHED"}:
            drone_state.mission_waypoint = None
            drone_state.mission_name = None
            drone_state.mission_wayline_id = None

    elif t == "mission_progress":
        drone_state.mission_waypoint = msg.get("waypoint_index")
        drone_state.mission_name = msg.get("mission_name")
        drone_state.mission_wayline_id = msg.get("wayline_id")

    elif t == "landing_confirmation_needed":
        needed = bool(msg.get("needed", False))
        # Dedup: ignora burst di eventi identici (es. true,true,true,...)
        if needed == drone_state.landing_confirmation_needed:
            should_broadcast = False
        else:
            drone_state.landing_confirmation_needed = needed

    elif t == "camera_switch":
        camera = str(msg.get("camera") or "").upper()
        if camera in {"WIDE", "ZOOM", "IR"}:
            current_camera_mode = camera
            msg["camera"] = current_camera_mode
        msg["type"] = "camera_changed"
        await log_event("INFO", "bridge", "camera switch event from kotlin", msg)

    elif t == "ack":
        command = msg.get("command")
        success = bool(msg.get("success", False))
        level = "INFO" if success else "ERROR"
        await log_event(level, "bridge", "ack from kotlin", msg)
        if command:
            waiters = pending_ack_waiters.get(str(command))
            while waiters:
                future = waiters.popleft()
                if not future.done():
                    future.set_result(msg)
                    break
        if not success:
            print(f"[Bridge] Kotlin ack failed command={command} error={msg.get('error')}")

    drone_state.last_update = time.time()
    # Broadcast stato aggiornato a tutti i client telemetria
    if should_broadcast:
        await broker.broadcast_telemetry({**msg, "state_snapshot": drone_state.to_dict()})


async def kotlin_bridge_loop():
    """Si connette al Kotlin WS server e riceve eventi in loop infinito."""
    global kotlin_ws
    if MOCK_DRONE_MODE:
        print("[Bridge] MOCK_DRONE_MODE attivo: bridge Kotlin disabilitato.")
        return
    print(f"[Bridge] Connessione a {KOTLIN_WS_URL} ...")
    await log_event("INFO", "bridge", "bridge loop started", {"target": KOTLIN_WS_URL})
    ever_connected = False

    while True:
        try:
            async with websockets.connect(
                KOTLIN_WS_URL,
                ping_interval=15,
                ping_timeout=30,
                close_timeout=5,
            ) as ws:
                async with kotlin_ws_lock:
                    kotlin_ws = ws
                drone_state.connected = True
                ever_connected = True
                await log_event("INFO", "bridge", "connected to kotlin server", {"target": KOTLIN_WS_URL})
                print("[Bridge] ✅ Connesso al Kotlin server")

                async for raw in ws:
                    await handle_kotlin_message(raw)

        except Exception as e:
            print(f"[Bridge] ⚠️  Disconnesso: {e} — retry in {RECONNECT_DELAY}s")
            await log_event("WARN", "bridge", "bridge disconnected", {"error": str(e), "retry_s": RECONNECT_DELAY})
            if DRONE_TEST_NO_RETRY and not ever_connected:
                await log_event(
                    "WARN",
                    "bridge",
                    "DRONE_TEST_NO_RETRY attivo: nessun retry bridge dopo primo failure",
                    {"target": KOTLIN_WS_URL},
                )
                print("[Bridge] DRONE_TEST_NO_RETRY attivo: stop retry bridge (server continua senza drone).")
                break

        finally:
            async with kotlin_ws_lock:
                kotlin_ws = None
            drone_state.connected = False
            drone_state.landing_confirmation_needed = False
            await broker.broadcast_telemetry({
                "type": "bridge_disconnected",
                "state_snapshot": drone_state.to_dict()
            })

        await asyncio.sleep(RECONNECT_DELAY)


async def send_to_kotlin(payload: dict) -> bool:
    """Invia un comando al Kotlin server. Ritorna True se riuscito."""
    if MOCK_DRONE_MODE:
        return await _mock_send(payload)
    async with kotlin_ws_lock:
        ws = kotlin_ws
    if ws is None:
        await log_event("WARN", "bridge", "send failed: kotlin ws not connected", {"payload_type": payload.get("type")})
        return False
    try:
        await ws.send(json.dumps(payload))
        return True
    except Exception as e:
        print(f"[Bridge] send error: {e}")
        await log_event("ERROR", "bridge", "send_to_kotlin exception", {"error": str(e), "payload_type": payload.get("type")})
        return False


async def send_control_command(payload: dict, wait_ack_s: float = 0.0) -> dict:
    command_type = payload.get("type")
    future: Optional[asyncio.Future] = None
    if wait_ack_s > 0 and command_type:
        future = asyncio.get_running_loop().create_future()
        pending_ack_waiters[str(command_type)].append(future)
    await log_event(
        "INFO",
        "bridge",
        "send command to kotlin",
        {
            "payload": payload,
            "bridge_connected": kotlin_ws is not None,
            "kotlin_ws_url": KOTLIN_WS_URL,
        },
    )
    ok = await send_to_kotlin(payload)
    if not ok:
        if future is not None and not future.done():
            future.cancel()
        await log_event(
            "ERROR",
            "bridge",
            "command not sent to kotlin",
            {"payload_type": command_type, "payload": payload, "bridge_connected": kotlin_ws is not None},
        )
        return {"sent": False, "ack": False, "error": "kotlin ws not connected"}

    if future is None:
        return {"sent": True, "ack": None}

    try:
        ack = await asyncio.wait_for(future, timeout=wait_ack_s)
    except asyncio.TimeoutError:
        await log_event(
            "WARN",
            "bridge",
            "kotlin ack timeout",
            {"payload_type": command_type, "payload": payload, "timeout_s": wait_ack_s},
        )
        return {"sent": True, "ack": False, "error": "timeout attesa ack kotlin"}
    finally:
        if command_type:
            waiters = pending_ack_waiters.get(str(command_type))
            if waiters:
                with suppress(ValueError):
                    waiters.remove(future)

    success = bool(ack.get("success", False))
    extra = {k: v for k, v in ack.items() if k not in {"type", "command", "success", "error"}}
    return {"sent": True, "ack": success, "error": ack.get("error"), **extra}


# ─────────────────────────────────────────────────────────────────────────────
# FASTAPI APP
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(title="ZephyrDrone Python Middleware", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_http_errors(request: Request, call_next):
    try:
        response = await call_next(request)
        if response.status_code >= 500:
            await log_event(
                "ERROR",
                "http",
                "http 5xx response",
                {
                    "path": str(request.url.path),
                    "method": request.method,
                    "status_code": response.status_code,
                },
            )
        return response
    except Exception as e:
        await log_event(
            "ERROR",
            "http",
            "unhandled exception",
            {
                "path": str(request.url.path),
                "method": request.method,
                "error": str(e),
                "traceback": traceback.format_exc(),
            },
        )
        raise


@app.on_event("startup")
async def startup():
    global go2rtc_client
    go2rtc_client = httpx.AsyncClient(timeout=10.0)
    await start_go2rtc_process()
    if MOCK_DRONE_MODE:
        discovery_result = {"mock": True, "kotlin_discovery_skipped": True}
        asyncio.create_task(mock_drone_loop())
    else:
        discovery_result = await ensure_kotlin_target_on_startup()
        asyncio.create_task(kotlin_bridge_loop())
    await log_event(
        "INFO",
        "app",
        "middleware startup",
        {"port": 8000, "mock_drone_mode": MOCK_DRONE_MODE, "kotlin_ws_url": KOTLIN_WS_URL, "kotlin_discovery": discovery_result},
    )
    print("[FastAPI] ZephyrDrone middleware avviato su :8000")


@app.on_event("shutdown")
async def shutdown():
    global go2rtc_client
    await stop_go2rtc_process()
    if go2rtc_client is not None:
        await go2rtc_client.aclose()
        go2rtc_client = None
    await log_event("INFO", "app", "middleware shutdown")


# ─────────────────────────────────────────────────────────────────────────────
# HTTP ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {"service": "ZephyrDrone Middleware", "version": "1.0", "docs": "/docs"}


@app.get("/status")
async def status():
    db = await get_db_health_summary()
    reservation = drone_reservations.snapshot()
    return {
        "status": "ok",
        "service": "ZephyrDrone Middleware",
        "bridge_connected": kotlin_ws is not None,
        "bridge_retry_enabled": not DRONE_TEST_NO_RETRY,
        "drone_test_no_retry": DRONE_TEST_NO_RETRY,
        "mock_drone_mode": MOCK_DRONE_MODE,
        "mock_config": {
            "path": str(MOCK_CONFIG_PATH),
            "enabled": MOCK_DRONE_MODE,
            "start_lat": MOCK_START_LAT,
            "start_lon": MOCK_START_LON,
            "telemetry_hz": MOCK_TELEMETRY_HZ,
        },
        "db": db,
        "drone": drone_state.to_dict(),
        "drones": [reservation["drone"]],
        "reservation": reservation["reservation"],
    }


@app.get("/drones")
async def drones_status():
    snap = drone_reservations.snapshot()
    return {
        "items": [
            {
                **snap["drone"],
                "reservation": snap["reservation"],
            }
        ],
        **snap,
    }


@app.post("/drones/{drone_id}/reserve")
async def reserve_drone(drone_id: str, request: Request, payload: dict):
    if drone_id != CONTROLLED_DRONE_ID:
        return {"ok": False, "reserved": False, "error": "drone non disponibile"}
    operator_id = str(payload.get("operator_id") or request.headers.get("x-operator-id") or "").strip()
    operator_name = str(payload.get("operator_name") or "Operatore").strip()
    client_host = request.client.host if request.client else ""
    res = drone_reservations.reserve(operator_id, operator_name, client_host)
    await broker.broadcast_telemetry({
        "type": "drone_reservation",
        "state_snapshot": drone_state.to_dict(),
    })
    return res


@app.post("/drones/{drone_id}/heartbeat")
async def heartbeat_drone(drone_id: str, request: Request, payload: Optional[dict] = None):
    if drone_id != CONTROLLED_DRONE_ID:
        return {"ok": False, "reserved": False, "error": "drone non disponibile"}
    body = payload or {}
    operator_id = str(body.get("operator_id") or request.headers.get("x-operator-id") or "").strip()
    return drone_reservations.heartbeat(operator_id)


@app.post("/drones/{drone_id}/release")
async def release_drone(drone_id: str, request: Request, payload: Optional[dict] = None):
    if drone_id != CONTROLLED_DRONE_ID:
        return {"ok": False, "released": False, "error": "drone non disponibile"}
    body = payload or {}
    operator_id = str(body.get("operator_id") or request.headers.get("x-operator-id") or "").strip()
    res = drone_reservations.release(operator_id)
    await broker.broadcast_telemetry({
        "type": "drone_reservation",
        "state_snapshot": drone_state.to_dict(),
    })
    return res


@app.get("/logs")
async def logs(limit: int = 200, level: Optional[str] = None, source: Optional[str] = None):
    return {"items": await get_logs(limit=limit, level=level, source=source)}


@app.get("/health/db")
async def health_db():
    return await get_db_health_summary()


@app.get("/battery")
async def battery():
    return {"percent": drone_state.battery_percent, "temperature": drone_state.battery_temp}


@app.get("/home")
async def get_home():
    has_home = drone_state.home_lat is not None and drone_state.home_lon is not None
    return {
        "available": has_home,
        "lat": drone_state.home_lat,
        "lon": drone_state.home_lon,
    }


async def fetch_terrain_elevations(points: list[tuple[float, float]]) -> list[Optional[float]]:
    """Fetch terrain elevation in meters using Open-Meteo, with a tiny in-memory cache."""
    out: list[Optional[float]] = []
    missing: list[tuple[int, float, float, str]] = []
    for idx, (lat, lon) in enumerate(points):
        key = f"{lat:.5f},{lon:.5f}"
        if key in terrain_cache:
            out.append(terrain_cache[key])
        else:
            out.append(None)
            missing.append((idx, lat, lon, key))

    if not missing:
        return out

    client = go2rtc_client
    close_after = False
    if client is None:
        client = httpx.AsyncClient(timeout=8.0)
        close_after = True
    try:
        lat_str = ",".join(f"{lat:.5f}" for _, lat, _, _ in missing)
        lon_str = ",".join(f"{lon:.5f}" for _, _, lon, _ in missing)
        try:
            resp = await client.get(
                "https://api.open-meteo.com/v1/elevation",
                params={"latitude": lat_str, "longitude": lon_str},
                timeout=8.0,
            )
            resp.raise_for_status()
            data = resp.json()
            values = data.get("elevation") if isinstance(data, dict) else None
            if isinstance(values, list):
                for item, elev in zip(missing, values):
                    idx, _, _, key = item
                    val = float(elev) if elev is not None else None
                    terrain_cache[key] = val
                    out[idx] = val
        except Exception as e:
            await log_event("WARN", "terrain", "terrain elevation lookup failed", {"error": str(e)})
    finally:
        if close_after:
            await client.aclose()
    return out


@app.get("/terrain/suggest_altitude")
async def terrain_suggest_altitude(
    lat: float,
    lon: float,
    prev_lat: Optional[float] = None,
    prev_lon: Optional[float] = None,
    home_lat: Optional[float] = None,
    home_lon: Optional[float] = None,
    base_agl: float = 35,
):
    start_lat = float(prev_lat if prev_lat is not None else home_lat if home_lat is not None else lat)
    start_lon = float(prev_lon if prev_lon is not None else home_lon if home_lon is not None else lon)
    ref_home_lat = float(home_lat if home_lat is not None else drone_state.home_lat if drone_state.home_lat is not None else start_lat)
    ref_home_lon = float(home_lon if home_lon is not None else drone_state.home_lon if drone_state.home_lon is not None else start_lon)

    samples = [(ref_home_lat, ref_home_lon)]
    for i in range(0, 7):
        t = i / 6 if i else 0
        samples.append((start_lat + (lat - start_lat) * t, start_lon + (lon - start_lon) * t))
    elevations = await fetch_terrain_elevations(samples)
    valid = [v for v in elevations[1:] if v is not None]
    home_elev = elevations[0]

    if home_elev is None or not valid:
        return {
            "ok": False,
            "suggested_altitude": max(10, min(500, round(float(base_agl)))),
            "error": "terrain elevation unavailable",
        }

    target_elev = valid[-1]
    avg_elev = sum(valid) / len(valid)
    max_elev = max(valid)
    min_elev = min(valid)
    ruggedness = max_elev - min_elev
    climb_over_home = max_elev - home_elev
    slope_bonus = min(25.0, max(0.0, ruggedness * 0.18))
    clearance = max(float(base_agl), 25.0) + slope_bonus
    suggested = clearance + max(0.0, climb_over_home)
    suggested = max(10.0, min(500.0, suggested))
    return {
        "ok": True,
        "suggested_altitude": round(suggested),
        "clearance_agl": round(clearance, 1),
        "terrain": {
            "home_elevation": round(home_elev, 1),
            "target_elevation": round(target_elev, 1),
            "average_elevation": round(avg_elev, 1),
            "min_elevation": round(min_elev, 1),
            "max_elevation": round(max_elev, 1),
            "ruggedness": round(ruggedness, 1),
        },
    }


@app.get("/missions/history")
async def missions_history(limit: int = 30):
    return {"items": await get_mission_history(limit)}


@app.get("/missions/history/{mission_id}")
async def mission_history_detail(mission_id: int):
    mission = await get_mission_by_id(mission_id)
    if mission is None:
        return {"found": False, "error": "mission not found"}
    waypoints = await get_mission_waypoints(mission_id)
    return {"found": True, "mission": mission, "waypoints": waypoints}


@app.get("/missions/saved")
async def missions_saved():
    return {"items": await list_saved_missions()}


@app.get("/missions/saved/load")
async def missions_saved_load(mission_name: str):
    item = await get_saved_mission_by_name(mission_name)
    if item is None:
        return {"found": False, "error": "missione non trovata"}
    return {"found": True, "item": item}


@app.post("/missions/saved")
async def missions_saved_store(payload: dict):
    saved = await save_mission_preset(payload)
    if saved is None:
        return {"saved": False, "error": "payload non valido"}
    return {"saved": True, "item": saved}


@app.get("/poi")
async def poi_list():
    return {"items": await list_poi()}


@app.post("/poi")
async def poi_create(payload: dict):
    row = await create_poi(payload)
    if row is None:
        return {"saved": False, "error": "payload non valido"}
    return {"saved": True, "item": row}


@app.put("/poi/{poi_id}")
async def poi_update(poi_id: int, payload: dict):
    row = await update_poi(poi_id, payload)
    if row is None:
        return {"saved": False, "error": "poi non trovato o payload non valido"}
    return {"saved": True, "item": row}


@app.delete("/poi/{poi_id}")
async def poi_remove(poi_id: int):
    ok = await delete_poi(poi_id)
    return {"deleted": ok}


@app.get("/rtsp_info")
async def rtsp_info():
    rtsp_url = f"rtsp://zephyr:zephyr123@{KOTLIN_HOST}:8554/streaming/live/1"
    health = await check_go2rtc_health("rtsp_info")
    return {
        "kotlin_host": KOTLIN_HOST,
        "kotlin_port": KOTLIN_PORT,
        "direct_rtsp_url": rtsp_url,
        "rtsp_url": rtsp_url,
        "go2rtc_api": GO2RTC_URL,
        "stream": "live",
        "go2rtc": health,
        "go2rtc_tail": list(go2rtc_log_tail)[-40:],
    }


@app.get("/go2rtc/status")
async def go2rtc_status():
    proc_running = go2rtc_process is not None and go2rtc_process.poll() is None
    health = await check_go2rtc_health("status")
    return {
        "running": proc_running,
        "pid": go2rtc_process.pid if go2rtc_process is not None else None,
        "exit_code": go2rtc_process.poll() if go2rtc_process is not None else None,
        "go2rtc_url": GO2RTC_URL,
        "kotlin_host": KOTLIN_HOST,
        "expected_rtsp": f"rtsp://zephyr:zephyr123@{KOTLIN_HOST}:8554/streaming/live/1",
        "health": health,
        "tail": list(go2rtc_log_tail)[-80:],
    }


@app.post("/go2rtc/restart")
async def go2rtc_restart():
    await stop_go2rtc_process()
    await start_go2rtc_process()
    return await go2rtc_status()


@app.get("/settings/network")
async def get_network_settings():
    return current_network_settings()


@app.post("/settings/network")
async def set_network_settings(payload: dict):
    old_ws = KOTLIN_WS_URL
    settings = {
        "kotlin_host": payload.get("kotlin_host", KOTLIN_HOST),
        "kotlin_port": payload.get("kotlin_port", KOTLIN_PORT),
        "go2rtc_url": payload.get("go2rtc_url", GO2RTC_URL),
    }
    apply_network_settings(settings)
    save_network_settings()

    reconnect_triggered = False
    if old_ws != KOTLIN_WS_URL:
        async with kotlin_ws_lock:
            ws = kotlin_ws
        if ws is not None:
            reconnect_triggered = True
            with suppress(Exception):
                await ws.close(code=1012, reason="network settings updated")
    await log_event(
        "INFO",
        "config",
        "network settings updated",
        {
            "old_kotlin_ws_url": old_ws,
            "new_kotlin_ws_url": KOTLIN_WS_URL,
            "reconnect_triggered": reconnect_triggered,
            "go2rtc_url": GO2RTC_URL,
        },
    )

    return {
        "saved": True,
        "reconnect_triggered": reconnect_triggered,
        **current_network_settings(),
    }


@app.post("/settings/discover_kotlin")
async def discover_kotlin_settings(payload: Optional[dict] = None):
    body = payload or {}
    base_host = _normalize_host(str(body.get("base_host", KOTLIN_HOST)))
    subnet_prefix = str(body.get("subnet_prefix", "")).strip()
    if not subnet_prefix:
        subnet_prefix = _host_to_subnet_prefix(base_host) or ""
    if not subnet_prefix:
        local_ip = _guess_local_lan_ip() or ""
        subnet_prefix = _host_to_subnet_prefix(local_ip) or ""
    if not subnet_prefix:
        return {"found": False, "error": "Impossibile determinare subnet prefix"}

    try:
        port = int(body.get("kotlin_port", KOTLIN_PORT))
    except Exception:
        port = KOTLIN_PORT
    port = max(1, min(65535, port))
    auto_apply = _to_bool(body.get("auto_apply", True), True)

    found_ip = await discover_kotlin_on_subnet(subnet_prefix=subnet_prefix, port=port)
    await log_event(
        "INFO",
        "config",
        "kotlin discovery executed",
        {"subnet_prefix": subnet_prefix, "port": port, "found_ip": found_ip, "auto_apply": auto_apply},
    )
    if not found_ip:
        return {"found": False, "subnet_prefix": subnet_prefix, "kotlin_port": port}

    reconnect_triggered = False
    if auto_apply:
        old_ws = KOTLIN_WS_URL
        apply_network_settings(
            {
                "kotlin_host": found_ip,
                "kotlin_port": port,
                "go2rtc_url": GO2RTC_URL,
            }
        )
        save_network_settings()
        if old_ws != KOTLIN_WS_URL:
            async with kotlin_ws_lock:
                ws = kotlin_ws
            if ws is not None:
                reconnect_triggered = True
                with suppress(Exception):
                    await ws.close(code=1012, reason="kotlin auto-discovered")

    return {
        "found": True,
        "kotlin_host": found_ip,
        "kotlin_port": port,
        "subnet_prefix": subnet_prefix,
        "auto_applied": auto_apply,
        "reconnect_triggered": reconnect_triggered,
        **(current_network_settings() if auto_apply else {}),
    }


# ── Comandi volo ──────────────────────────────────────────────────────────────

@app.post("/cmd/takeoff")
async def cmd_takeoff(request: Request):
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    ok = await send_to_kotlin({"type": "takeoff"})
    return {"sent": ok}

@app.post("/cmd/land")
async def cmd_land(request: Request):
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    ok = await send_to_kotlin({"type": "land"})
    return {"sent": ok}

@app.post("/cmd/return_home")
async def cmd_return_home(request: Request):
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    ok = await send_to_kotlin({"type": "return_home"})
    return {"sent": ok}


# ── Comandi home point ────────────────────────────────────────────────────────

@app.post("/cmd/set_home")
async def cmd_set_home(request: Request, lat: float, lon: float):
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    ok = await send_to_kotlin({"type": "set_home", "lat": lat, "lon": lon})
    if ok:
        set_home_point(lat, lon)
    return {"sent": ok, "lat": lat, "lon": lon}

@app.get("/cmd/get_home")
async def cmd_get_home():
    ok = await send_to_kotlin({"type": "get_home"})
    return {
        "sent": ok,
        "available": drone_state.home_lat is not None and drone_state.home_lon is not None,
        "lat": drone_state.home_lat,
        "lon": drone_state.home_lon,
    }


# ── Comandi camera ────────────────────────────────────────────────────────────

@app.get("/camera/current")
async def camera_current():
    return {"camera": current_camera_mode}


@app.post("/cmd/switch_camera")
async def cmd_switch_camera(request: Request, camera: str = "WIDE"):
    global current_camera_mode
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    requested = camera.upper()
    if requested not in {"WIDE", "ZOOM", "IR"}:
        return {"sent": False, "error": "camera non valida", "camera": current_camera_mode}
    result = await send_control_command({"type": "switch_camera", "camera": requested})
    if result["sent"] and result.get("ack") is not False:
        current_camera_mode = requested
        await broker.broadcast_telemetry({
            "type": "camera_changed",
            "camera": current_camera_mode,
            "state_snapshot": drone_state.to_dict(),
        })
    return {**result, "camera": current_camera_mode}

@app.post("/cmd/set_zoom")
async def cmd_set_zoom(request: Request, ratio: float):
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    return await send_control_command({"type": "set_zoom", "ratio": ratio})

@app.post("/cmd/set_thermal_zoom")
async def cmd_set_thermal_zoom(request: Request, ratio: float):
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    return await send_control_command({"type": "set_thermal_zoom", "ratio": ratio})

@app.post("/cmd/thermal_spot_measure")
async def cmd_thermal_spot_measure(request: Request, x: float, y: float, source: str = "react"):
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    nx = max(0.0, min(1.0, float(x)))
    ny = max(0.0, min(1.0, float(y)))
    source_id = "".join(ch for ch in str(source or "react").lower() if ch.isalnum() or ch in {"_", "-"})[:32] or "react"
    thermal_spot_inputs[source_id] = {"x": nx, "y": ny, "updated_at": time.time()}
    if MOCK_DRONE_MODE:
        return {
            "sent": True,
            "ack": True,
            "x": nx,
            "y": ny,
            "source": source_id,
            "temperature": round(28.0 + (1.0 - ny) * 6.0 + nx * 2.5, 1),
        }
    result = await send_control_command(
        {"type": "thermal_spot_measure", "x": nx, "y": ny, "source": source_id},
        wait_ack_s=3.0,
    )
    return {**result, "source": source_id}

@app.post("/cmd/gimbal_rotate_speed")
async def cmd_gimbal_rotate_speed(
    request: Request,
    pitch_speed: float = 0.0,
    yaw_speed: float = 0.0,
    roll_speed: float = 0.0,
):
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    return await send_control_command({
        "type": "gimbal_rotate_speed",
        "pitch_speed": pitch_speed,
        "yaw_speed": yaw_speed,
        "roll_speed": roll_speed,
    })

@app.post("/cmd/gimbal_rotate_angle")
async def cmd_gimbal_rotate_angle(
    request: Request,
    pitch: Optional[float] = None,
    yaw: Optional[float] = None,
    roll: Optional[float] = None,
    relative: bool = True,
    duration: float = 0.3,
):
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    if pitch is None and yaw is None and roll is None:
        return {"sent": False, "error": "Specifica almeno uno tra pitch/yaw/roll"}
    payload = {
        "type": "gimbal_rotate_angle",
        "relative": relative,
        "duration": duration,
    }
    if pitch is not None:
        payload["pitch"] = pitch
    if yaw is not None:
        payload["yaw"] = yaw
    if roll is not None:
        payload["roll"] = roll
    return await send_control_command(payload)

@app.post("/cmd/gimbal_reset")
async def cmd_gimbal_reset(request: Request, reset_type: str = "PITCH_YAW"):
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    return await send_control_command({"type": "gimbal_reset", "reset_type": reset_type.upper()})

@app.post("/cmd/gimbal_stop")
async def cmd_gimbal_stop(request: Request):
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    return await send_control_command({
        "type": "gimbal_rotate_speed",
        "pitch_speed": 0.0,
        "yaw_speed": 0.0,
        "roll_speed": 0.0
    })

@app.post("/cmd/take_photo")
async def cmd_take_photo(request: Request):
    global current_camera_mode
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    if _record_toggle_state:
        return {
            "sent": False,
            "ack": False,
            "error": "Foto disabilitate durante registrazione video",
            "camera": current_camera_mode,
        }
    result = await send_control_command({"type": "take_photo", "zoom_ratio": DEFAULT_PHOTO_ZOOM_RATIO}, wait_ack_s=10.0)
    if result["sent"] and result.get("ack") is not False:
        current_camera_mode = "WIDE"
        await broker.broadcast_telemetry({
            "type": "camera_changed",
            "camera": current_camera_mode,
            "state_snapshot": drone_state.to_dict(),
        })
    return {**result, "camera": current_camera_mode}

@app.post("/cmd/start_recording")
async def cmd_start_recording(request: Request):
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    return await send_control_command({"type": "start_recording"}, wait_ack_s=3.0)

@app.post("/cmd/stop_recording")
async def cmd_stop_recording(request: Request):
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    return await send_control_command({"type": "stop_recording"}, wait_ack_s=3.0)

_record_toggle_state = False
DEFAULT_PHOTO_ZOOM_RATIO = 20.0

@app.post("/cmd/toggle_record")
async def cmd_toggle_record(request: Request):
    global _record_toggle_state
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    command = "stop_recording" if _record_toggle_state else "start_recording"
    result = await send_control_command({"type": command}, wait_ack_s=3.0)
    if result["sent"] and result.get("ack") is not False:
        _record_toggle_state = not _record_toggle_state
    return {**result, "recording": _record_toggle_state}
@app.post("/cmd/confirm_landing")
async def cmd_confirm_landing(request: Request):
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    if kotlin_ws is None and not MOCK_DRONE_MODE:
        return {"sent": False, "error": "Bridge Kotlin non connesso"}
    ok = await send_to_kotlin({"type": "confirm_landing"})
    return {"sent": ok, "landing_confirmation_needed": drone_state.landing_confirmation_needed}
@app.post("/cmd/set_home_current")
async def cmd_set_home_current(request: Request):
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    lat = drone_state.latitude
    lon = drone_state.longitude
    if lat is None or lon is None:
        return {"sent": False, "error": "Posizione GPS non disponibile"}
    ok = await send_to_kotlin({"type": "set_home", "lat": lat, "lon": lon})
    if ok:
        set_home_point(lat, lon)
    return {"sent": ok, "lat": lat, "lon": lon}


# ── Comandi missione ──────────────────────────────────────────────────────────

def _as_float(value, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def normalize_mission_waypoints(waypoints: list) -> list:
    normalized: list[dict] = []
    for idx, raw in enumerate(waypoints):
        if not isinstance(raw, dict):
            continue
        wp = dict(raw)
        action = str(wp.get("action") or "NONE").upper()
        wp["action"] = action

        if action == "TAKE_PHOTO_EXPERIMENTAL":
            photo_count = max(1, _as_int(wp.get("photo_count"), 1))
            interval = max(0.0, _as_float(wp.get("photo_interval_seconds"), 2.0))
            total = max(_as_float(wp.get("photo_total_seconds"), 0.0), interval * max(0, photo_count - 1), 6.0)
            hover = max(_as_float(wp.get("hover_seconds"), 0.0), total)
            gimbal_pitch = max(-90.0, min(30.0, _as_float(wp.get("gimbal_pitch"), -90.0)))

            wp["photo_count"] = photo_count
            wp["photo_interval_seconds"] = interval
            wp["photo_total_seconds"] = total
            wp["hover_seconds"] = hover
            wp["gimbal_pitch"] = gimbal_pitch
            print(
                "[Mission] EXP photo wp=%s alt=%s hover=%.1fs pitch=%.1f count=%s interval=%.1fs total=%.1fs"
                % (idx, wp.get("altitude"), hover, gimbal_pitch, photo_count, interval, total),
                flush=True,
            )
        normalized.append(wp)
    return normalized

@app.post("/cmd/start_mission")
async def cmd_start_mission(request: Request, payload: dict):
    """
    Body JSON:
    {
        "waypoints": [{"lat": 44.1, "lon": 7.5, "altitude": 30, "action": "TAKE_PHOTO"}],
        "auto_speed": 5.0,
        "max_speed": 10.0,
        "finished_action": "GO_HOME"
    }
    """
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    global active_mission_history_id, pending_delivery_return_payload
    waypoints = payload.get("waypoints")
    split_idx_raw = payload.get("delivery_split_index")
    mission_name = str(payload.get("mission_name") or "mission").strip() or "mission"
    if isinstance(waypoints, list):
        waypoints = normalize_mission_waypoints(waypoints)
        payload["waypoints"] = waypoints

    if isinstance(split_idx_raw, int):
        if not isinstance(waypoints, list) or len(waypoints) < 3:
            return {"sent": False, "error": "Missione troppo corta per split consegna"}
        split_abs_idx = split_idx_raw + 1  # +1 perché il payload include BASE iniziale in posizione 0
        if split_abs_idx < 1 or split_abs_idx >= len(waypoints) - 1:
            return {"sent": False, "error": "delivery_split_index fuori range"}

        outbound = dict(payload)
        outbound["type"] = "start_mission"
        outbound["waypoints"] = waypoints[: split_abs_idx + 1]
        outbound["finished_action"] = "HOVER"
        outbound["mission_name"] = f"{mission_name}-OUT"
        outbound.pop("delivery_split_index", None)

        return_leg = dict(payload)
        return_leg["type"] = "start_mission"
        return_leg["waypoints"] = waypoints[split_abs_idx:]
        return_leg["finished_action"] = "GO_HOME"
        return_leg["mission_name"] = f"{mission_name}-RTB"
        return_leg.pop("delivery_split_index", None)

        ok = await send_to_kotlin(outbound)
        mission_history_id: Optional[int] = None
        if ok:
            pending_delivery_return_payload = return_leg
            drone_state.delivery_waiting_operator = False
            drone_state.delivery_pending_return = True
            drone_state.delivery_split_waypoint_index = split_idx_raw
            drone_state.mission_state = "DELIVERY_OUTBOUND"
            await update_active_mission_state("DELIVERY_OUTBOUND")
            mission_history_id = await create_mission_history_entry(outbound)
            if mission_history_id is not None:
                active_mission_history_id = mission_history_id
            await broker.broadcast_telemetry({
                "type": "mission_state",
                "state": "DELIVERY_OUTBOUND",
                "state_snapshot": drone_state.to_dict(),
            })
        return {"sent": ok, "mission_history_id": mission_history_id, "delivery_split_applied": ok}

    payload["type"] = "start_mission"
    ok = await send_to_kotlin(payload)
    mission_history_id: Optional[int] = None
    if ok:
        pending_delivery_return_payload = None
        drone_state.delivery_waiting_operator = False
        drone_state.delivery_pending_return = False
        drone_state.delivery_split_waypoint_index = None
        mission_history_id = await create_mission_history_entry(payload)
        if mission_history_id is not None:
            active_mission_history_id = mission_history_id
    return {"sent": ok, "mission_history_id": mission_history_id}


@app.post("/cmd/resume_delivery_mission")
async def cmd_resume_delivery_mission(request: Request):
    global active_mission_history_id, pending_delivery_return_payload
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    if pending_delivery_return_payload is None:
        return {"sent": False, "error": "Nessuna missione consegna in attesa operatore"}

    return_payload = dict(pending_delivery_return_payload)
    return_payload["type"] = "start_mission"
    if drone_state.delivery_waiting_operator:
        # La tratta outbound termina in HOVER/NO_ACTION: su alcuni controller resta
        # una missione attiva che impedisce lo start immediato della tratta RTB.
        await send_to_kotlin({"type": "stop_mission"})
        await asyncio.sleep(0.8)
    ok = await send_to_kotlin(return_payload)
    mission_history_id: Optional[int] = None
    if ok:
        mission_history_id = await create_mission_history_entry(return_payload)
        if mission_history_id is not None:
            active_mission_history_id = mission_history_id
        pending_delivery_return_payload = None
        drone_state.delivery_waiting_operator = False
        drone_state.delivery_pending_return = False
        drone_state.mission_state = "DELIVERY_RETURN"
        await update_active_mission_state("DELIVERY_RETURN")
        await broker.broadcast_telemetry({
            "type": "mission_state",
            "state": "DELIVERY_RETURN",
            "state_snapshot": drone_state.to_dict(),
        })
    return {"sent": ok, "mission_history_id": mission_history_id}

@app.post("/cmd/pause_mission")
async def cmd_pause_mission(request: Request):
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    ok = await send_to_kotlin({"type": "pause_mission"})
    return {"sent": ok}

@app.post("/webrtc/offer")
async def webrtc_offer(request: Request, src: str = "live"):
    """Proxy verso go2rtc — risolve CORS e localhost."""
    body = await request.body()
    client = go2rtc_client
    close_after = False
    if client is None:
        client = httpx.AsyncClient(timeout=10.0)
        close_after = True
    resp = None
    try:
        try:
            resp = await client.post(
                f"{GO2RTC_URL}/api/webrtc?src={src}",
                content=body,
                headers={"Content-Type": "application/sdp"},
            )
            if resp.status_code >= 400:
                await log_event(
                    "WARN",
                    "go2rtc",
                    "webrtc offer returned error",
                    {
                        "status": resp.status_code,
                        "body": resp.text[:500],
                        "go2rtc_url": GO2RTC_URL,
                        "src": src,
                        "tail": list(go2rtc_log_tail)[-20:],
                    },
                )
        except httpx.RequestError as e:
            await log_event(
                "ERROR",
                "go2rtc",
                "webrtc offer proxy failed",
                {"error": str(e), "go2rtc_url": GO2RTC_URL, "src": src},
            )
            return Response(content=b"go2rtc unreachable", media_type="text/plain", status_code=502)
    finally:
        if close_after:
            await client.aclose()
    return Response(content=resp.content, media_type="application/sdp", status_code=resp.status_code)


@app.get("/video/frame")
async def video_frame(src: str = "dji"):
    """Proxy immagine JPEG da go2rtc per client mobile sulla sola porta :8000."""
    src_norm = (src or "dji").strip().lower()
    if src_norm in {"mock", "mock_wide", "wide"}:
        frame = MOCK_FRAME_DIR / "wide.png"
        if frame.exists():
            return Response(content=frame.read_bytes(), media_type="image/png")
    if src_norm in {"mock_zoom", "zoom"}:
        frame = MOCK_FRAME_DIR / "zoom.png"
        if frame.exists():
            return Response(content=frame.read_bytes(), media_type="image/png")
    if src_norm in {"mock_ir", "ir", "thermal"}:
        frame = MOCK_FRAME_DIR / "ir.png"
        if frame.exists():
            return Response(content=frame.read_bytes(), media_type="image/png")
    client = go2rtc_client
    close_after = False
    if client is None:
        client = httpx.AsyncClient(timeout=10.0)
        close_after = True
    resp = None
    try:
        try:
            resp = await client.get(f"{GO2RTC_URL}/api/frame.jpeg?src={src}")
            if resp.status_code >= 400:
                await log_event(
                    "WARN",
                    "go2rtc",
                    "frame proxy returned error",
                    {
                        "status": resp.status_code,
                        "body": resp.text[:500],
                        "go2rtc_url": GO2RTC_URL,
                        "src": src,
                        "tail": list(go2rtc_log_tail)[-20:],
                    },
                )
        except httpx.RequestError as e:
            await log_event(
                "ERROR",
                "go2rtc",
                "frame proxy failed",
                {"error": str(e), "go2rtc_url": GO2RTC_URL, "src": src},
            )
            return Response(content=b"go2rtc unreachable", media_type="text/plain", status_code=502)
    finally:
        if close_after:
            await client.aclose()
    media_type = resp.headers.get("content-type", "image/jpeg")
    return Response(content=resp.content, media_type=media_type, status_code=resp.status_code)


@app.post("/cmd/resume_mission")
async def cmd_resume_mission(request: Request):
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    ok = await send_to_kotlin({"type": "resume_mission"})
    return {"sent": ok}

@app.post("/cmd/stop_mission")
async def cmd_stop_mission(request: Request):
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    ok = await send_to_kotlin({"type": "stop_mission"})
    return {"sent": ok}


# ── Comando generico pass-through ─────────────────────────────────────────────

@app.post("/cmd/raw")
async def cmd_raw(request: Request, payload: dict):
    """Invia un payload JSON arbitrario al Kotlin server."""
    blocked = await command_blocked_response(request)
    if blocked:
        return blocked
    ok = await send_to_kotlin(payload)
    return {"sent": ok}


# ─────────────────────────────────────────────────────────────────────────────
# WEBSOCKET ENDPOINTS (browser → FastAPI)
# ─────────────────────────────────────────────────────────────────────────────

@app.websocket("/ws/telemetry")
async def ws_telemetry(ws: WebSocket):
    """Stream telemetria + eventi drone verso il browser."""
    await ws.accept()
    user_agent = ws.headers.get("user-agent", "")
    client_host = ws.client.host if ws.client else "unknown"
    mobile_client = is_mobile_user_agent(user_agent)
    if mobile_client:
        print(f"[WS] Client mobile connesso da {client_host} | ua={user_agent}")
        await log_event("INFO", "ws", "mobile telemetry client connected", {"client_host": client_host, "ua": user_agent})
        await broker.broadcast_telemetry({
            "type": "mobile_client_connected",
            "client_host": client_host,
            "user_agent": user_agent,
        })
    else:
        print(f"[WS] Client connesso da {client_host} | ua={user_agent}")
        await log_event("INFO", "ws", "telemetry client connected", {"client_host": client_host, "ua": user_agent})

    await broker.add_telemetry(ws)
    # Manda subito lo stato corrente
    try:
        await ws.send_text(json.dumps({
            "type": "state_snapshot",
            "state_snapshot": drone_state.to_dict()
        }))
        while True:
            # Mantieni vivo e ascolta eventuali comandi dal browser
            data = await ws.receive_text()
            try:
                cmd = json.loads(data)
                await send_to_kotlin(cmd)
            except Exception:
                pass
    except WebSocketDisconnect:
        pass
    finally:
        if mobile_client:
            print(f"[WS] Client mobile disconnesso da {client_host}")
            await log_event("INFO", "ws", "mobile telemetry client disconnected", {"client_host": client_host})
            await broker.broadcast_telemetry({
                "type": "mobile_client_disconnected",
                "client_host": client_host,
            })
        else:
            await log_event("INFO", "ws", "telemetry client disconnected", {"client_host": client_host})
        await broker.remove_telemetry(ws)





# ─────────────────────────────────────────────────────────────────────────────
# DASHBOARD HTML (embedded, nessun file statico necessario)
# ─────────────────────────────────────────────────────────────────────────────

DASHBOARD_HTML = r"""<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ZephyrDrone · Control</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@300;400;600;700&display=swap');

  :root {
    --bg:        #060B18;
    --bg2:       #0C1225;
    --bg3:       #111830;
    --cyan:      #00D4FF;
    --blue:      #4F8EFF;
    --green:     #00FF9F;
    --red:       #FF4A6B;
    --yellow:    #FFD166;
    --text:      rgba(255,255,255,0.85);
    --muted:     rgba(255,255,255,0.3);
    --border:    rgba(0,212,255,0.15);
    --font-mono: 'Share Tech Mono', monospace;
    --font-ui:   'Rajdhani', sans-serif;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-ui);
    height: 100vh;
    overflow: hidden;
    display: grid;
    grid-template-rows: 48px 1fr;
    grid-template-columns: 260px 1fr 280px;
    grid-template-areas:
      "header header header"
      "left   center right";
  }

  /* ── Header ─────────────────────────────────────────────── */
  header {
    grid-area: header;
    display: flex;
    align-items: center;
    padding: 0 20px;
    gap: 20px;
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
    z-index: 10;
  }
  .logo { font-family: var(--font-mono); color: var(--cyan); font-size: 18px; letter-spacing: 4px; }
  .logo span { color: var(--muted); font-size: 11px; letter-spacing: 2px; }
  #conn-badge {
    margin-left: auto;
    display: flex; align-items: center; gap: 8px;
    font-family: var(--font-mono); font-size: 11px;
    padding: 4px 12px;
    border-radius: 20px;
    border: 1px solid rgba(255,74,107,0.4);
    color: var(--red);
    transition: all .4s;
  }
  #conn-badge.ok  { border-color: rgba(0,255,159,0.4); color: var(--green); }
  #conn-badge .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }

  /* ── Panels ─────────────────────────────────────────────── */
  .panel {
    background: var(--bg2);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .panel-title {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 3px;
    color: var(--cyan);
    opacity: .5;
    padding: 12px 16px 8px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  /* ── LEFT: Telemetry ────────────────────────────────────── */
  #left { grid-area: left; border-left: none; }
  .tele-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    padding: 12px;
    overflow-y: auto;
    flex: 1;
  }
  .tele-cell {
    background: var(--bg3);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    text-align: center;
  }
  .tele-cell .label { font-family: var(--font-mono); font-size: 9px; color: var(--muted); letter-spacing: 1px; }
  .tele-cell .value { font-family: var(--font-mono); font-size: 18px; color: var(--cyan); margin-top: 4px; }
  .tele-cell .unit  { font-size: 10px; color: var(--muted); }

  .bat-bar-wrap { padding: 10px 12px 4px; flex-shrink: 0; }
  .bat-label    { font-family: var(--font-mono); font-size: 9px; color: var(--muted); letter-spacing: 1px; margin-bottom: 6px; }
  .bat-bar      { height: 8px; background: var(--bg3); border-radius: 4px; overflow: hidden; border: 1px solid var(--border); }
  .bat-fill     { height: 100%; border-radius: 4px; background: var(--green); transition: width .5s, background .5s; }

  .attitude-box {
    margin: 8px 12px;
    background: var(--bg3);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    flex-shrink: 0;
  }
  .att-row { display:flex; justify-content:space-between; font-family:var(--font-mono); font-size:12px; margin: 3px 0; }
  .att-label { color: var(--muted); font-size: 9px; }
  .att-value { color: var(--yellow); }

  /* ── CENTER: 3D View ────────────────────────────────────── */
  #center {
    grid-area: center;
    display: flex;
    flex-direction: column;
    border: none;
    position: relative;
  }
  #three-canvas { flex: 1; display: block; }
  #hud {
    position: absolute;
    bottom: 12px; left: 50%;
    transform: translateX(-50%);
    display: flex; gap: 8px;
    z-index: 5;
  }
  .hud-chip {
    font-family: var(--font-mono); font-size: 10px;
    padding: 4px 12px;
    border-radius: 16px;
    background: rgba(6,11,24,.85);
    border: 1px solid var(--border);
    color: var(--cyan);
    backdrop-filter: blur(4px);
  }

  /* ── RIGHT: Controls + Video ─────────────────────────────── */
  #right { grid-area: right; border-right: none; border-left: 1px solid var(--border); overflow-y: auto; }
  .section { padding: 12px; border-bottom: 1px solid var(--border); }
  .section-title { font-family: var(--font-mono); font-size: 9px; color: var(--muted); letter-spacing: 2px; margin-bottom: 10px; }

  /* Video feed */
  #video-feed {
    width: 100%;
    aspect-ratio: 16/9;
    background: #000;
    border-radius: 6px;
    overflow: hidden;
    position: relative;
    border: 1px solid var(--border);
  }
  #video-feed canvas { width: 100%; height: 100%; display: block; }
  #video-feed .no-signal {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    font-family: var(--font-mono); font-size: 11px; color: var(--muted); gap: 6px;
  }
  .cam-tabs { display: flex; gap: 6px; margin-bottom: 8px; }
  .cam-tab  {
    flex: 1; padding: 5px;
    border-radius: 5px; border: 1px solid var(--border);
    background: transparent; color: var(--muted);
    font-family: var(--font-mono); font-size: 10px;
    cursor: pointer; transition: all .2s;
  }
  .cam-tab.active { border-color: var(--cyan); color: var(--cyan); background: rgba(0,212,255,.08); }

  /* Buttons */
  .btn-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .btn {
    padding: 8px 6px;
    border-radius: 6px; border: 1px solid var(--border);
    background: rgba(0,212,255,.05);
    color: var(--text); font-family: var(--font-ui); font-weight: 600; font-size: 13px;
    cursor: pointer; transition: all .2s;
    letter-spacing: .5px;
  }
  .btn:hover   { border-color: var(--cyan); color: var(--cyan); background: rgba(0,212,255,.12); }
  .btn.danger  { border-color: rgba(255,74,107,.3); color: var(--red); }
  .btn.danger:hover  { background: rgba(255,74,107,.12); }
  .btn.success { border-color: rgba(0,255,159,.3); color: var(--green); }
  .btn.success:hover { background: rgba(0,255,159,.12); }
  .btn.warn    { border-color: rgba(255,209,102,.3); color: var(--yellow); }
  .btn.warn:hover    { background: rgba(255,209,102,.12); }
  .btn.full { grid-column: 1 / -1; }

  /* Camera controls */
  .slider-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
  .slider-row label { font-family: var(--font-mono); font-size: 9px; color: var(--muted); width: 60px; }
  .slider-row input[type=range] { flex: 1; accent-color: var(--cyan); }
  .slider-row .val { font-family: var(--font-mono); font-size: 10px; color: var(--cyan); width: 32px; text-align: right; }

  /* Log */
  #log {
    font-family: var(--font-mono); font-size: 10px;
    color: var(--muted);
    padding: 8px 12px;
    max-height: 90px;
    overflow-y: auto;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  #log div { margin: 2px 0; }
  #log .ok  { color: var(--green); }
  #log .err { color: var(--red); }
  #log .info{ color: var(--cyan); }

  /* Landing confirm modal */
  #landing-modal {
    position: fixed;
    inset: 0;
    background: rgba(4, 8, 20, 0.72);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    backdrop-filter: blur(2px);
  }
  #landing-modal.show { display: flex; }
  .landing-card {
    width: min(440px, 92vw);
    border: 1px solid rgba(255, 209, 102, 0.45);
    background: linear-gradient(180deg, rgba(10,18,38,0.96), rgba(6,11,24,0.98));
    box-shadow: 0 24px 70px rgba(0,0,0,0.45);
    border-radius: 10px;
    padding: 16px;
  }
  .landing-title {
    font-family: var(--font-ui);
    font-size: 17px;
    color: var(--yellow);
    margin-bottom: 6px;
  }
  .landing-text {
    font-family: var(--font-ui);
    color: var(--muted);
    font-size: 13px;
    margin-bottom: 14px;
  }
  .landing-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
</style>
</head>
<body>

<header>
  <div class="logo">ZEPHYR <span>DRONE</span></div>
  <div id="conn-badge"><div class="dot"></div><span id="conn-text">DISCONNESSO</span></div>
</header>

<!-- LEFT: Telemetry -->
<div class="panel" id="left">
  <div class="panel-title">◆ TELEMETRIA</div>
  <div class="bat-bar-wrap">
    <div class="bat-label">BATTERIA — <span id="bat-pct">—</span>%</div>
    <div class="bat-bar"><div class="bat-fill" id="bat-fill" style="width:0%"></div></div>
  </div>
  <div class="attitude-box">
    <div class="att-row"><span class="att-label">PITCH</span><span class="att-value" id="t-pitch">—°</span></div>
    <div class="att-row"><span class="att-label">ROLL</span> <span class="att-value" id="t-roll">—°</span></div>
    <div class="att-row"><span class="att-label">YAW</span>  <span class="att-value" id="t-yaw">—°</span></div>
  </div>
  <div class="tele-grid">
    <div class="tele-cell"><div class="label">ALTITUDINE</div><div class="value" id="t-alt">—</div><div class="unit">m</div></div>
    <div class="tele-cell"><div class="label">GPS</div><div class="value" id="t-gps">—</div><div class="unit">segnale</div></div>
    <div class="tele-cell"><div class="label">VEL X</div><div class="value" id="t-vx">—</div><div class="unit">m/s</div></div>
    <div class="tele-cell"><div class="label">VEL Y</div><div class="value" id="t-vy">—</div><div class="unit">m/s</div></div>
    <div class="tele-cell"><div class="label">VEL Z</div><div class="value" id="t-vz">—</div><div class="unit">m/s</div></div>
    <div class="tele-cell"><div class="label">VOLO</div><div class="value" id="t-fly">NO</div><div class="unit">stato</div></div>
    <div class="tele-cell"><div class="label">LAT</div><div class="value" id="t-lat" style="font-size:13px">—</div><div class="unit">°</div></div>
    <div class="tele-cell"><div class="label">LON</div><div class="value" id="t-lon" style="font-size:13px">—</div><div class="unit">°</div></div>
  </div>
  <div id="log"></div>
</div>

<!-- CENTER: 3D -->
<div id="center">
  <canvas id="three-canvas"></canvas>
  <div id="hud">
    <div class="hud-chip" id="hud-mission">MISSIONE: —</div>
    <div class="hud-chip" id="hud-alt">ALT: —m</div>
    <div class="hud-chip" id="hud-speed">VEL: —m/s</div>
    <div class="hud-chip" id="hud-mission-detail">WP: — | FILE: —</div>
  </div>
</div>

<!-- RIGHT: Controls + Video -->
<div class="panel" id="right">

  <div class="section">
  <div class="section-title">VIDEO FEED</div>
  <div class="cam-tabs">
    <button class="cam-tab active" onclick="switchCam('WIDE', this)">WIDE</button>
    <button class="cam-tab"        onclick="switchCam('ZOOM', this)">ZOOM</button>
    <button class="cam-tab"        onclick="switchCam('IR', this)">IR</button>
  </div>
  <div id="video-feed">
    <video id="rtsp-video" autoplay muted playsinline
           style="width:100%;height:100%;object-fit:cover;border-radius:6px;background:#000">
    </video>
    <div class="no-signal" id="no-signal">
      <div>◈</div><div>NESSUN SEGNALE</div>
    </div>
  </div>
  <div class="slider-row" style="margin-top:8px">
    <label>ZOOM</label>
    <input type="range" id="zoom-slider" min="1" max="30" step="0.5" value="1"
           oninput="onZoom(this.value)">
    <span class="val" id="zoom-val">1×</span>
  </div>
</div>

  <div class="section">
    <div class="section-title">COMANDI VOLO</div>
    <div class="btn-grid">
      <button class="btn success" onclick="cmd('takeoff')">▲ DECOLLO</button>
      <button class="btn danger"  onclick="cmd('land')">▼ ATTERRA</button>
      <button class="btn warn full" onclick="cmd('return_home')">⌂ RITORNA ALLA BASE</button>
      <button class="btn warn full" onclick="setHomeCurrent()">⌖ SET HOME QUI</button>
      <button class="btn warn full" onclick="cmd('confirm_landing')">✓ CONFERMA ATTERRAGGIO</button>
    </div>
  </div>

  <div class="section">
    <div class="section-title">CAMERA</div>
    <div class="btn-grid">
      <button class="btn" onclick="cmd('take_photo')">📷 FOTO</button>
      <button class="btn" onclick="toggleRecording()"><span id="rec-icon">⏺</span> REC</button>
    </div>
  </div>

  <div class="section">
    <div class="section-title">MISSIONE</div>
    <div class="btn-grid">
      <button class="btn" onclick="cmd('pause_mission')">⏸ PAUSA</button>
      <button class="btn" onclick="cmd('resume_mission')">▶ RIPRENDI</button>
      <button class="btn danger" onclick="cmd('stop_mission')">⏹ STOP</button>
      <button class="btn" onclick="testMission()">⬆ TEST KMZ</button>
      
    </div>
    <div style="margin-top:8px;font-family:var(--font-mono);font-size:11px;color:var(--muted);line-height:1.4">
      <div>STATO: <span id="mission-state">—</span></div>
      <div>WP: <span id="mission-waypoint">—</span></div>
      <div>FILE: <span id="mission-name">—</span></div>
      <div>WAYLINE: <span id="mission-wayline">—</span></div>
    </div>
  </div>

</div>

<div id="landing-modal" role="dialog" aria-modal="true" aria-labelledby="landing-title">
  <div class="landing-card">
    <div class="landing-title" id="landing-title">Conferma Atterraggio Richiesta</div>
    <div class="landing-text">Il drone richiede conferma finale per completare l'atterraggio. Confermare ora?</div>
    <div class="landing-actions">
      <button class="btn warn" onclick="confirmLandingFromModal()">✓ CONFERMA</button>
      <button class="btn" onclick="dismissLandingModal()">ANNULLA</button>
    </div>
  </div>
</div>

<script>
// ─────────────────────────────────────────────────────────────────────────────
// THREE.JS — scena 3D
// ─────────────────────────────────────────────────────────────────────────────

const canvas3d = document.getElementById('three-canvas');
const renderer = new THREE.WebGLRenderer({
  canvas: canvas3d,
  antialias: true,
  alpha: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
renderer.setClearColor(0x060B18, 1);

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 10000);
camera.position.set(0, 80, 200);
camera.lookAt(0, 0, 0);

// Grid
const gridHelper = new THREE.GridHelper(260, 26, 0x1a2640, 0x0d1520);
scene.add(gridHelper);

// Axes subtle
const axMat = new THREE.LineBasicMaterial({ color: 0x1a3a5c });
const mkAxis = (a, b) => {
  const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
  return new THREE.Line(g, axMat);
};
scene.add(mkAxis([-200,0,0],[200,0,0]), mkAxis([0,0,0],[0,200,0]), mkAxis([0,0,-200],[0,0,200]));

// ── Drone mesh ─────────────────────────────────────────────────────────────
const droneGroup = new THREE.Group();

// Body centrale
const bodyMat = new THREE.MeshPhongMaterial({
    color: 0x1a2a3a, emissive: 0x001122, shininess: 120
});
const body = new THREE.Mesh(new THREE.BoxGeometry(10, 2.5, 10), bodyMat);
droneGroup.add(body);

// Materiale bracci e motori
const armMat   = new THREE.MeshPhongMaterial({ color: 0x223344, shininess: 60 });
const motorMat = new THREE.MeshPhongMaterial({ color: 0x00D4FF, emissive: 0x002244 });
const propMat  = new THREE.MeshPhongMaterial({
    color: 0x00FF9F, emissive: 0x003322,
    transparent: true, opacity: 0.75
});

// 4 bracci diagonali + motori + eliche
const ARM_LEN   = 14;
const PROP_CONF = [
    { x:  ARM_LEN, z:  ARM_LEN },
    { x: -ARM_LEN, z:  ARM_LEN },
    { x:  ARM_LEN, z: -ARM_LEN },
    { x: -ARM_LEN, z: -ARM_LEN },
];

const propellers = []; // ← array che useremo per farle girare

PROP_CONF.forEach(({ x, z }, i) => {
    // Braccio: BoxGeometry orientato diagonalmente
    const arm = new THREE.Mesh(
        new THREE.BoxGeometry(ARM_LEN * 1.41, 1.2, 1.8),
        armMat
    );
    arm.position.set(x / 2, 0, z / 2);
    arm.rotation.y = Math.PI / 4 * (x * z > 0 ? -1 : 1); // ±45°
    droneGroup.add(arm);

    // Motore cilindrico in punta del braccio
    const motor = new THREE.Mesh(
        new THREE.CylinderGeometry(2.2, 2.2, 2.5, 12),
        motorMat
    );
    motor.position.set(x, 0, z);
    droneGroup.add(motor);

    // Elica: due blade piatte ruotanti sull'asse Y
    const propGroup = new THREE.Group();
    propGroup.position.set(x, 1.8, z);

    const blade = new THREE.Mesh(
        new THREE.BoxGeometry(8, 0.3, 1.5),
        propMat
    );
    const blade2 = blade.clone();
    blade2.rotation.y = Math.PI / 2;

    propGroup.add(blade, blade2);
    droneGroup.add(propGroup);
    propellers.push({ group: propGroup, dir: i % 2 === 0 ? 1 : -1 });
});

// LED glow
const droneLigh = new THREE.PointLight(0x00D4FF, 2, 60);
droneGroup.add(droneLigh);

droneGroup.position.set(0, 30, 0);
scene.add(droneGroup);

// Trail (linea percorso)
const trailPoints = [];
const trailGeo = new THREE.BufferGeometry();
const trailMat = new THREE.LineBasicMaterial({ color: 0x00D4FF, opacity: 0.5, transparent: true });
const trailLine = new THREE.Line(trailGeo, trailMat);
scene.add(trailLine);

// Luce ambientale
scene.add(new THREE.AmbientLight(0x1a2640, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(100, 200, 100);
scene.add(sun);

// Home marker (cubo semitrasparente a terra)
const homeMarker = new THREE.Mesh(
  new THREE.BoxGeometry(10, 0.5, 10),
  new THREE.MeshPhongMaterial({ color: 0xFFD166, opacity: 0.5, transparent: true })
);
homeMarker.position.set(0, 0.25, 0);
scene.add(homeMarker);

// Station spheres (placeholder stazioni)
const stationMat = new THREE.MeshPhongMaterial({ color: 0x4F8EFF, opacity: 0.5, transparent: true, wireframe: true });
[-60, 60].forEach(x => {
  const s = new THREE.Mesh(new THREE.SphereGeometry(8, 16, 16), stationMat);
  s.position.set(x, 0, 0);
  scene.add(s);
});

// Resize
function resizeRenderer() {
  const c = canvas3d.parentElement;
  renderer.setSize(c.clientWidth, c.clientHeight);
  camera.aspect = c.clientWidth / c.clientHeight;
  camera.updateProjectionMatrix();
}
resizeRenderer();
window.addEventListener('resize', resizeRenderer);

// Orbit (semplice, no import)
let orbitDragging = false, orbitLast = {x:0, y:0};
let orbitTheta = 0, orbitPhi = Math.PI/4, orbitR = 190;
canvas3d.addEventListener('mousedown', e => { orbitDragging = true; orbitLast = {x:e.clientX, y:e.clientY}; });
canvas3d.addEventListener('mouseup',   () => orbitDragging = false);
canvas3d.addEventListener('mousemove', e => {
  if (!orbitDragging) return;
  orbitTheta -= (e.clientX - orbitLast.x) * 0.005;
  orbitPhi   -= (e.clientY - orbitLast.y) * 0.005;
  orbitPhi    = Math.max(0.1, Math.min(Math.PI/2 - 0.05, orbitPhi));
  orbitLast   = {x:e.clientX, y:e.clientY};
});
canvas3d.addEventListener('wheel', e => {
  orbitR = Math.max(50, Math.min(600, orbitR + e.deltaY * 0.3));
});

// ── Stato drone ───────────────────────────────────────────────────────────────

let originLat = null, originLon = null;
let targetX     = 0;
let targetZ     = 0;
let targetAlt   = 30;
let targetYaw   = 0;
let targetPitch = 0;
let targetRoll  = 0;
const LERP_POS = 0.4;
const ROT_SLERP = 0.35;
let lastPositionHistory = [];
const HORIZONTAL_SCALE = 14000; // più movimento su X/Z a parità di delta GPS

const YAW_MODEL_OFFSET = 0.0;
const targetEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const targetQuat = new THREE.Quaternion();
let trailDirty = false;
let lastTrailUpdateMs = 0;
const TRAIL_UPDATE_INTERVAL_MS = 80;

function latLonToXZ(lat, lon) {
  if (originLat === null) { originLat = lat; originLon = lon; }
  const x = (lon - originLon) * HORIZONTAL_SCALE;
  const z = -(lat - originLat) * HORIZONTAL_SCALE;
  return { x, z };
}

function updateTrail(history) {
  if (!history || history.length < 2) return;
  const pts = history.map(p => {
    const {x, z} = latLonToXZ(p.lat, p.lon);
    return new THREE.Vector3(x, p.alt * 1.5, z);
  });
  trailGeo.setFromPoints(pts);
}

// ── Animate loop ──────────────────────────────────────────────────────────────

let t = 0;
function animate() {
    requestAnimationFrame(animate);
    t += 0.01;

    // ── Camera orbita ──────────────────────────────────────────────────────
    camera.position.set(
        orbitR * Math.sin(orbitTheta) * Math.cos(orbitPhi),
        orbitR * Math.sin(orbitPhi),
        orbitR * Math.cos(orbitTheta) * Math.cos(orbitPhi)
    );
    camera.lookAt(droneGroup.position);

    // ── Lerp posizione ─────────────────────────────────────────────────────
    droneGroup.position.x = THREE.MathUtils.lerp(droneGroup.position.x, targetX,         LERP_POS);
    droneGroup.position.z = THREE.MathUtils.lerp(droneGroup.position.z, targetZ,         LERP_POS);
    droneGroup.position.y = THREE.MathUtils.lerp(droneGroup.position.y, targetAlt * 1.5, LERP_POS);

    // ── Lerp rotazione ─────────────────────────────────────────────────────
    targetEuler.set(targetPitch, -targetYaw + YAW_MODEL_OFFSET, -targetRoll);
    targetQuat.setFromEuler(targetEuler);
    droneGroup.quaternion.slerp(targetQuat, ROT_SLERP);

    // ── Hover idle (solo se fermo) ─────────────────────────────────────────
    const hoverOffset = Math.sin(t * 1.2) * 0.3;
    droneGroup.position.y += hoverOffset;

    // ── Eliche ────────────────────────────────────────────────────────────
    propellers.forEach(({ group, dir }) => {
        group.rotation.y += 0.35 * dir;
    });

    // ── Trail ─────────────────────────────────────────────────────────────
    const now = performance.now();
    if (trailDirty && (now - lastTrailUpdateMs) >= TRAIL_UPDATE_INTERVAL_MS) {
        updateTrail(lastPositionHistory);
        trailDirty = false;
        lastTrailUpdateMs = now;
    }

    renderer.render(scene, camera);
}
animate();

// ─────────────────────────────────────────────────────────────────────────────
// VIDEO — WebRTC via go2rtc
// ─────────────────────────────────────────────────────────────────────────────

const GO2RTC_API = `http://localhost:1984`;
let   currentCam = 'WIDE';
let   pc         = null;

console.log(GO2RTC_API);

async function startWebRTC(streamName = 'live') {
    // Chiudi connessione precedente se esiste
    if (pc) { pc.close(); pc = null; }

    const video = document.getElementById('rtsp-video');
    const noSig = document.getElementById('no-signal');

    try {
        pc = new RTCPeerConnection({
            iceServers: [],          // locale, non serve STUN/TURN
            bundlePolicy: 'max-bundle'
        });

        pc.ontrack = e => {
            video.srcObject = e.streams[0];
            noSig.style.display = 'none';
            log('Video WebRTC connesso', 'ok');
        };

        pc.oniceconnectionstatechange = () => {
            if (pc.iceConnectionState === 'disconnected' ||
                pc.iceConnectionState === 'failed') {
                noSig.style.display = 'flex';
                log('Video disconnesso — retry...', 'err');
                setTimeout(() => startWebRTC('live'), 2000);
            }
        };

        pc.addTransceiver('video', { direction: 'recvonly' });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const resp = await fetch(`${GO2RTC_API}/api/webrtc?src=live`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body:    offer.sdp
});

        if (!resp.ok) throw new Error(`go2rtc HTTP ${resp.status}`);

        await pc.setRemoteDescription({ type: 'answer', sdp: await resp.text() });

    } catch (e) {
        log(`WebRTC errore: ${e}`, 'err');
        noSig.style.display = 'flex';
        setTimeout(() => startWebRTC(streamName), 3000);
    }
}

function switchCam(cam, btn) {
    currentCam = cam;
    document.querySelectorAll('.cam-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');

    // Stream sempre 'live' — go2rtc non cambia
    // Il Kotlin cambia la sorgente RTSP internamente
    fetch(`/cmd/switch_camera?camera=${cam}`, { method: 'POST' });
    log(`Camera → ${cam}`, 'info');
}

// ─────────────────────────────────────────────────────────────────────────────
// TELEMETRY WEBSOCKET
// ─────────────────────────────────────────────────────────────────────────────

let telemWs = null;
const badge   = document.getElementById('conn-badge');
const connTxt = document.getElementById('conn-text');
const landingModal = document.getElementById('landing-modal');
let landingModalVisible = false;
const UI_TARGET_HZ = 60;
const UI_INTERVAL_MS = Math.max(1, Math.round(1000 / UI_TARGET_HZ));
let pendingSnapshot = null;
let lastLandingEventNeeded = null;

function showLandingModal() {
  if (landingModalVisible) return;
  landingModalVisible = true;
  landingModal.classList.add('show');
}

function dismissLandingModal() {
  landingModalVisible = false;
  landingModal.classList.remove('show');
}

async function confirmLandingFromModal() {
  if (telemWs && telemWs.readyState === WebSocket.OPEN) {
    telemWs.send(JSON.stringify({ type: 'confirm_landing' }));
    log('Invio conferma atterraggio...', 'info');
    return;
  }
  await cmd('confirm_landing');
}

function connectTelemWs() {
  telemWs = new WebSocket(`ws://${location.host}/ws/telemetry`);

  telemWs.onopen = () => {
    badge.className = 'ok';
    connTxt.textContent = 'CONNESSO';
    log('WebSocket telemetria connesso', 'ok');
  };

  telemWs.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'landing_confirmation_needed') {
        const needed = !!msg.needed;
        if (needed && lastLandingEventNeeded !== true) {
          showLandingModal();
          log('Richiesta conferma atterraggio ricevuta', 'info');
        } else if (!needed && lastLandingEventNeeded !== false) {
          dismissLandingModal();
        }
        lastLandingEventNeeded = needed;
      }
      if (msg.type === 'ack') {
        const ok = !!msg.success;
        log(`${msg.command}: ${ok ? 'ok' : 'errore'}${msg.error ? ' - ' + msg.error : ''}`, ok ? 'ok' : 'err');
        if (msg.command === 'confirm_landing' && ok) dismissLandingModal();
      } else if (msg.type === 'error') {
        log(`errore drone: ${msg.message ?? 'sconosciuto'}`, 'err');
      }
      if (msg && msg.state_snapshot) pendingSnapshot = msg.state_snapshot;
    } catch(_) {}
  };

  telemWs.onclose = () => {
    badge.className = '';
    connTxt.textContent = 'DISCONNESSO';
    dismissLandingModal();
    setTimeout(connectTelemWs, 2000);
  };
}

function renderSnapshot(snap) {
  const t = snap.telemetry;
  const b = snap.battery;
  const m = snap.mission;

  // Badge drone
  if (snap.connected) {
    badge.className = 'ok';
    connTxt.textContent = snap.product_name || 'CONNESSO';
  }

  // Batteria
  const pct = b.percent ?? 0;
  document.getElementById('bat-pct').textContent  = b.percent ?? '—';
  document.getElementById('bat-fill').style.width = pct + '%';
  document.getElementById('bat-fill').style.background =
    pct > 50 ? 'var(--green)' : pct > 20 ? 'var(--yellow)' : 'var(--red)';

  // Attitude
  const fmt = v => v != null ? v.toFixed(1) + '°' : '—°';
  document.getElementById('t-pitch').textContent = fmt(t.pitch);
  document.getElementById('t-roll').textContent  = fmt(t.roll);
  document.getElementById('t-yaw').textContent   = fmt(t.yaw);

  // Tele grid
  const fmtN = (v,d=1) => v != null ? v.toFixed(d) : '—';
  document.getElementById('t-alt').textContent = fmtN(t.altitude);
  document.getElementById('t-gps').textContent = t.gps_signal ?? '—';
  document.getElementById('t-vx').textContent  = fmtN(t.velocity_x);
  document.getElementById('t-vy').textContent  = fmtN(t.velocity_y);
  document.getElementById('t-vz').textContent  = fmtN(t.velocity_z);
  document.getElementById('t-fly').textContent = t.is_flying ? 'SÌ' : 'NO';
  document.getElementById('t-lat').textContent = fmtN(t.latitude, 5);
  document.getElementById('t-lon').textContent = fmtN(t.longitude, 5);

  // HUD
  document.getElementById('hud-mission').textContent = 'MISSIONE: ' + (m.state ?? '—');
  document.getElementById('hud-alt').textContent     = 'ALT: ' + fmtN(t.altitude) + 'm';
  const speed = t.velocity_x != null
    ? Math.sqrt(t.velocity_x**2 + t.velocity_y**2 + t.velocity_z**2).toFixed(1)
    : '—';
  document.getElementById('hud-speed').textContent = 'VEL: ' + speed + 'm/s';
  const wpText = m.waypoint_index ?? '—';
  const missionName = m.mission_name ?? '—';
  const waylineText = m.wayline_id ?? '—';
  document.getElementById('hud-mission-detail').textContent = `WP: ${wpText} | FILE: ${missionName}`;
  document.getElementById('mission-state').textContent = m.state ?? '—';
  document.getElementById('mission-waypoint').textContent = wpText;
  document.getElementById('mission-name').textContent = missionName;
  document.getElementById('mission-wayline').textContent = waylineText;

  if (snap.landing_confirmation_needed) showLandingModal();
  else dismissLandingModal();

  // 3D drone position
  if (t.latitude != null && t.longitude != null) {
    const {x, z} = latLonToXZ(t.latitude, t.longitude);
    targetX = x;
    targetZ = z;
}
if (t.altitude != null) targetAlt   = t.altitude;
if (t.yaw      != null) targetYaw   = t.yaw   * Math.PI / 180;
if (t.pitch    != null) targetPitch = t.pitch  * Math.PI / 180;
if (t.roll     != null) targetRoll  = t.roll   * Math.PI / 180;

  const newHistory = snap.position_history || [];
  const prevLast = lastPositionHistory.length ? lastPositionHistory[lastPositionHistory.length - 1] : null;
  const nextLast = newHistory.length ? newHistory[newHistory.length - 1] : null;
  if (
    newHistory.length !== lastPositionHistory.length ||
    (prevLast && nextLast && (prevLast.lat !== nextLast.lat || prevLast.lon !== nextLast.lon || prevLast.alt !== nextLast.alt)) ||
    (!prevLast && nextLast) ||
    (prevLast && !nextLast)
  ) {
    trailDirty = true;
  }
  lastPositionHistory = newHistory;
}

setInterval(() => {
  if (!pendingSnapshot) return;
  renderSnapshot(pendingSnapshot);
  pendingSnapshot = null;
}, UI_INTERVAL_MS);

// ─────────────────────────────────────────────────────────────────────────────
// COMANDI
// ─────────────────────────────────────────────────────────────────────────────

async function cmd(endpoint) {
  try {
    const r = await fetch(`/cmd/${endpoint}`, { method: 'POST' });
    const d = await r.json();
    log(`${endpoint}: ${d.sent ? 'inviato ✓' : 'errore ✗'}`, d.sent ? 'ok' : 'err');
  } catch(e) { log(`${endpoint}: ${e}`, 'err'); }
}

let isRecording = false;
function toggleRecording() {
  isRecording = !isRecording;
  document.getElementById('rec-icon').textContent = isRecording ? '⏹' : '⏺';
  cmd(isRecording ? 'start_recording' : 'stop_recording');
}

function onZoom(val) {
  document.getElementById('zoom-val').textContent = val + '×';
  fetch(`/cmd/set_zoom?ratio=${val}`, { method: 'POST' });
}

async function testMission() {
  const payload = {
    waypoints: [
      { lat: (originLat || 44.3845) + 0.001, lon: (originLon || 7.5432),        altitude: 30, action: "NONE" },
      { lat: (originLat || 44.3845) + 0.001, lon: (originLon || 7.5432) + 0.001, altitude: 35, action: "TAKE_PHOTO" },
      { lat: (originLat || 44.3845),          lon: (originLon || 7.5432) + 0.001, altitude: 30, action: "NONE" },
    ],
    auto_speed: 5, max_speed: 10, finished_action: "GO_HOME"
  };
  try {
    const r = await fetch('/cmd/start_mission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await r.json();
    log(`missione test: ${d.sent ? 'avviata ✓' : 'errore ✗'}`, d.sent ? 'ok' : 'err');
  } catch(e) { log('missione: ' + e, 'err'); }
}
async function setHomeCurrent() {
    try {
        const r = await fetch('/cmd/set_home_current', { method: 'POST' });
        const d = await r.json();
        if (d.sent) {
            log(`Home impostata: ${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}`, 'ok');
        } else {
            log(`Set home fallito: ${d.error ?? ''}`, 'err');
        }
    } catch(e) { log(`Set home: ${e}`, 'err'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// LOG
// ─────────────────────────────────────────────────────────────────────────────

const logEl = document.getElementById('log');
function log(msg, type='info') {
  const d = document.createElement('div');
  d.className = type;
  d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.prepend(d);
  while (logEl.children.length > 30) logEl.lastChild.remove();
}

// ─────────────────────────────────────────────────────────────────────────────
// AVVIO
// ─────────────────────────────────────────────────────────────────────────────

connectTelemWs();
startWebRTC('live');
log('Dashboard ZephyrDrone avviata', 'info');

</script>
</body>
</html>
"""


@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard():
    return HTMLResponse(content=DASHBOARD_HTML)


SETTINGS_HTML = """
<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Zephyr Settings</title>
  <style>
    :root { --bg:#09141c; --panel:#122330; --line:#2a4a5f; --txt:#dff6ff; --muted:#8db0c3; --accent:#4dd8ff; --ok:#7dffa6; }
    body { margin:0; background:radial-gradient(circle at top, #153245, var(--bg) 60%); color:var(--txt); font:14px/1.4 'Segoe UI',sans-serif; }
    .wrap { max-width:760px; margin:30px auto; padding:0 16px; }
    .card { background:rgba(18,35,48,.85); border:1px solid var(--line); border-radius:14px; padding:14px; box-shadow:0 8px 30px rgba(0,0,0,.35); }
    h1 { margin:0 0 12px; letter-spacing:.08em; font-size:22px; }
    .muted { color:var(--muted); margin:0 0 14px; }
    .row { display:grid; grid-template-columns:1fr 180px; gap:10px; margin-bottom:10px; }
    label { display:block; color:var(--muted); margin-bottom:4px; font-size:12px; letter-spacing:.04em; text-transform:uppercase; }
    input { width:100%; box-sizing:border-box; border-radius:10px; border:1px solid var(--line); background:#0b1b26; color:var(--txt); padding:10px; }
    button { border:1px solid #3daecf; background:rgba(77,216,255,.15); color:var(--txt); border-radius:10px; padding:10px 14px; cursor:pointer; font-weight:600; letter-spacing:.05em; }
    .actions { display:flex; gap:8px; margin-top:10px; }
    .ok { color:var(--ok); }
    .err { color:#ff9d9d; }
    .bar { margin-top:12px; min-height:24px; font-family:Consolas,monospace; }
    a { color:var(--accent); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>NETWORK SETTINGS</h1>
      <p class="muted">Questi valori vengono salvati su disco e mantenuti tra i riavvii.</p>
      <div class="row">
        <div>
          <label>Host Controller DJI (Kotlin)</label>
          <input id="kotlin-host" placeholder="10.101.30.88" />
        </div>
        <div>
          <label>Porta Kotlin</label>
          <input id="kotlin-port" type="number" min="1" max="65535" placeholder="8081" />
        </div>
      </div>
      <div>
        <label>URL go2rtc</label>
        <input id="go2rtc-url" placeholder="http://127.0.0.1:1984" />
      </div>
      <div class="actions">
        <button id="load-btn" type="button">RICARICA</button>
        <button id="save-btn" type="button">SALVA</button>
        <button id="dashboard-btn" type="button" onclick="location.href='/dashboard'">VAI A DASHBOARD</button>
      </div>
      <div id="status" class="bar"></div>
      <p class="muted">Endpoint: <a href="/settings/network" target="_blank">/settings/network</a></p>
    </div>
  </div>
  <script>
    const statusEl = document.getElementById('status');
    const hostEl = document.getElementById('kotlin-host');
    const portEl = document.getElementById('kotlin-port');
    const go2rtcEl = document.getElementById('go2rtc-url');

    function setStatus(msg, ok=true) {
      statusEl.className = 'bar ' + (ok ? 'ok' : 'err');
      statusEl.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    }

    async function loadSettings() {
      try {
        const r = await fetch('/settings/network');
        const d = await r.json();
        hostEl.value = d.kotlin_host ?? '';
        portEl.value = d.kotlin_port ?? 8081;
        go2rtcEl.value = d.go2rtc_url ?? '';
        setStatus('Configurazione caricata');
      } catch (e) {
        setStatus('Errore lettura impostazioni: ' + e, false);
      }
    }

    async function saveSettings() {
      const payload = {
        kotlin_host: hostEl.value.trim(),
        kotlin_port: Number(portEl.value || 8081),
        go2rtc_url: go2rtcEl.value.trim(),
      };
      try {
        const r = await fetch('/settings/network', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const d = await r.json();
        if (!r.ok || d.saved !== true) throw new Error(d.error || r.status);
        hostEl.value = d.kotlin_host ?? payload.kotlin_host;
        portEl.value = d.kotlin_port ?? payload.kotlin_port;
        go2rtcEl.value = d.go2rtc_url ?? payload.go2rtc_url;
        setStatus('Salvato. ' + (d.reconnect_triggered ? 'Bridge riavviato automaticamente.' : 'Nessun reconnect necessario.'));
      } catch (e) {
        setStatus('Errore salvataggio: ' + e, false);
      }
    }

    document.getElementById('load-btn').addEventListener('click', loadSettings);
    document.getElementById('save-btn').addEventListener('click', saveSettings);
    loadSettings();
  </script>
</body>
</html>
"""


@app.get("/settings", response_class=HTMLResponse)
async def settings_page():
    return HTMLResponse(content=SETTINGS_HTML)


# ─────────────────────────────────────────────────────────────────────────────
# ENTRYPOINT
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False, log_level="info")
