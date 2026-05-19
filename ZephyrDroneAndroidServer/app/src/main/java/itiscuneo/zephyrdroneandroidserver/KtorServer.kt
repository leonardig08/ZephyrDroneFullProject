package itiscuneo.zephyrdroneandroidserver

import android.util.Log
import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.websocket.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.resume
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.float
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.time.Duration.Companion.seconds

private const val TAG  = "KtorServer"
private const val PORT = 8081
private val PORT_CANDIDATES = listOf(PORT)

// ─────────────────────────────────────────────────────────────────────────────
// Risposte HTTP
// ─────────────────────────────────────────────────────────────────────────────

@Serializable
data class StatusResponse(
    val status:         String,
    val droneConnected: Boolean,
    val serverVersion:  String = "1.0",
    val timestampMs:    Long   = System.currentTimeMillis()
)

@Serializable
data class AckResponse(
    val success: Boolean,
    val command: String,
    val error:   String? = null
)

// ─────────────────────────────────────────────────────────────────────────────

class KtorServer(
    private val droneManager: IDroneManager,
    private val eventChannel: ReceiveChannel<DroneEvent>,
    private val serverIp:     String
) {
    companion object {
        private val processServerStarted = AtomicBoolean(false)
        private var activeServer: KtorServer? = null
    }

    private val scope  = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var engine: EmbeddedServer<NettyApplicationEngine, NettyApplicationEngine.Configuration>? = null
    private var boundPort: Int = PORT

    private val sessionsMutex = Mutex()
    private val wsSessions    = Collections.newSetFromMap(
        WeakHashMap<DefaultWebSocketSession, Boolean>()
    )
    private val realtimeBacklog = ArrayDeque<DroneEvent>()

    // ─────────────────────────────────────────────────────────────────────────
    // START / STOP
    // ─────────────────────────────────────────────────────────────────────────

    fun start() {
        synchronized(KtorServer::class.java) {
            if (activeServer?.engine != null) {
                Log.w(TAG, "Server Ktor gia avviato in questo processo")
                processServerStarted.set(true)
                throw IllegalStateException("Server Ktor gia avviato in questo processo")
            }
            if (!processServerStarted.compareAndSet(false, true)) {
                Log.w(TAG, "Server Ktor gia in avvio in questo processo")
                throw IllegalStateException("Server Ktor gia in avvio in questo processo")
            }
            activeServer = this
        }
        if (engine != null) { Log.w(TAG, "Server già in esecuzione"); return }

        try {
            var lastError: Exception? = null
            for (port in PORT_CANDIDATES) {
                try {
                    boundPort = port
                    engine = embeddedServer(Netty, host = "0.0.0.0", port = port) {
                        install(ContentNegotiation) { json() }
                        install(WebSockets) {
                            pingPeriod   = 15.seconds
                            timeout      = 30.seconds
                            maxFrameSize = Long.MAX_VALUE
                            masking      = false
                        }
                        configureRouting()
                    }.start(wait = false)
                    break
                } catch (e: Exception) {
                    lastError = e
                    engine = null
                    if (!e.isAddressAlreadyInUse()) throw e
                    Log.w(TAG, "Porta Ktor $port gia occupata, provo la prossima")
                }
            }
            if (engine == null) throw lastError ?: IllegalStateException("Nessuna porta Ktor disponibile")

            startEventPump()
            Log.i(TAG, "Ktor server avviato su :$boundPort")
        } catch (e: Exception) {
            engine = null
            synchronized(KtorServer::class.java) {
                if (activeServer === this) activeServer = null
                processServerStarted.set(false)
            }
            throw e
        }
    }

    fun stop() {
        synchronized(KtorServer::class.java) {
            val server = if (engine != null) this else activeServer
            server?.engine?.stop(1000, 2000)
            server?.engine = null
            if (activeServer === server || activeServer === this) activeServer = null
            engine = null
            processServerStarted.set(false)
        }
        Log.i(TAG, "Ktor server fermato")
    }

    private fun Throwable.isAddressAlreadyInUse(): Boolean {
        var current: Throwable? = this
        while (current != null) {
            if (current.message?.contains("Address already in use", ignoreCase = true) == true) return true
            current = current.cause
        }
        return false
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ROUTING
    // ─────────────────────────────────────────────────────────────────────────

    private fun Application.configureRouting() {
        routing {

            // ── GET /status ──────────────────────────────────────────────────
            get("/status") {
                call.respond(StatusResponse(
                    status         = "ok",
                    droneConnected = droneManager.isDroneConnected
                ))
            }

            // ── GET /cameras ─────────────────────────────────────────────────
            get("/cameras") {
                call.respond(mapOf(
                    "rtsp" to "rtsp://zephyr:zephyr123@$serverIp:8554/live"
                ))
            }

            post("/camera/switch") {
                val cameraStr = call.request.queryParameters["camera"]
                val camera = DroneCamera.entries.find { it.name == cameraStr?.uppercase() }
                if (camera == null) {
                    call.respond(AckResponse(false, "switch_camera", "Camera non valida: $cameraStr. Valori: WIDE, ZOOM, IR"))
                } else {
                    Log.i(TAG, "HTTP command switch_camera camera=${camera.name}")
                    val response = suspendCancellableCoroutine<AckResponse> { cont ->
                        droneManager.switchOperatorCamera(camera) { ok, err ->
                            if (cont.isActive) cont.resume(AckResponse(ok, "switch_camera", err))
                        }
                    }
                    call.respond(response)
                }
            }

            // ── GET /battery ─────────────────────────────────────────────────
            get("/battery") {
                call.respond(mapOf("charge_percent" to droneManager.getBatteryPercentage()))
            }

            // ── GET /home ────────────────────────────────────────────────────
            get("/home") {
                droneManager.getHomePoint { lat, lon ->
                    scope.launch {
                        if (lat != null && lon != null)
                            call.respond(mapOf("latitude" to lat, "longitude" to lon))
                        else
                            call.respond(mapOf("error" to "Home point non disponibile"))
                    }
                }
            }

            // ── WebSocket /ws/drone ──────────────────────────────────────────
            webSocket("/ws/drone") {
                Log.i(TAG, "Nuovo client WS: ${call.request.local.remoteAddress}")
                sessionsMutex.withLock { wsSessions.add(this) }
                try {
                    for (frame in incoming) {
                        if (frame is Frame.Text) handleIncomingCommand(frame.readText(), this)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Client WS disconnesso: ${e.message}")
                } finally {
                    sessionsMutex.withLock { wsSessions.remove(this) }
                    Log.i(TAG, "Client WS rimosso, attivi: ${wsSessions.size}")
                }
            }

            // ── WebSocket /ws/telemetry ──────────────────────────────────────
            webSocket("/ws/telemetry") {
                Log.i(TAG, "Client telemetria connesso")
                sessionsMutex.withLock { wsSessions.add(this) }
                try {
                    for (frame in incoming) { /* solo ricezione passiva */ }
                } finally {
                    sessionsMutex.withLock { wsSessions.remove(this) }
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GESTIONE COMANDI IN ENTRATA DA PYTHON
    // ─────────────────────────────────────────────────────────────────────────

    private suspend fun handleIncomingCommand(text: String, session: DefaultWebSocketSession) {
        Log.d(TAG, "Comando ricevuto: $text")

        runCatching {
            val root = Json.parseToJsonElement(text).jsonObject
            val type = root["type"]?.jsonPrimitive?.content

            when (type) {

                // ── Volo base ────────────────────────────────────────────────

                "takeoff" -> droneManager.takeoff { ok, err ->
                    scope.launch { session.ack("takeoff", ok, err) }
                }

                "land" -> droneManager.land { ok, err ->
                    scope.launch { session.ack("land", ok, err) }
                }

                "return_home" -> droneManager.returnHome { ok, err ->
                    scope.launch { session.ack("return_home", ok, err) }
                }

                // ── Home point ───────────────────────────────────────────────

                "set_home" -> {
                    val lat = root["lat"]?.jsonPrimitive?.double
                    val lon = root["lon"]?.jsonPrimitive?.double
                    if (lat == null || lon == null) {
                        session.sendError("server", "set_home richiede lat e lon")
                    } else {
                        droneManager.setHomePoint(lat, lon) { ok, err ->
                            scope.launch { session.ack("set_home", ok, err) }
                        }
                    }
                }

                "get_home" -> {
                    droneManager.getHomePoint { lat, lon ->
                        scope.launch {
                            if (lat != null && lon != null) {
                                session.send(Frame.Text(
                                    """{"type":"home_point","lat":$lat,"lon":$lon}"""
                                ))
                            } else {
                                session.sendError("drone", "Home point non disponibile")
                            }
                        }
                    }
                }

                // ── Camera ───────────────────────────────────────────────────

                "switch_camera" -> {
                    val cameraStr = root["camera"]?.jsonPrimitive?.content
                    val camera = DroneCamera.entries.find { it.name == cameraStr?.uppercase() }
                    if (camera == null) {
                        session.sendError("server", "Camera non valida: $cameraStr. Valori: WIDE, ZOOM, IR")
                    } else {
                        Log.i(TAG, "WS command switch_camera camera=${camera.name}")
                        droneManager.switchOperatorCamera(camera) { ok, err ->
                            scope.launch { session.ack("switch_camera", ok, err) }
                        }
                    }
                }

                "set_zoom" -> {
                    val ratio = root["ratio"]?.jsonPrimitive?.float
                    if (ratio == null) {
                        session.sendError("server", "set_zoom richiede ratio (float)")
                    } else {
                        droneManager.setZoomLevel(ratio)
                        session.ack("set_zoom", true)
                    }
                }

                "set_thermal_zoom" -> {
                    val ratio = root["ratio"]?.jsonPrimitive?.float
                    if (ratio == null) {
                        session.sendError("server", "set_thermal_zoom richiede ratio (float)")
                    } else {
                        droneManager.setThermalZoom(ratio)
                        session.ack("set_thermal_zoom", true)
                    }
                }

                "thermal_spot_measure" -> {
                    val x = root["x"]?.jsonPrimitive?.double
                    val y = root["y"]?.jsonPrimitive?.double
                    if (x == null || y == null) {
                        session.sendError("server", "thermal_spot_measure richiede x e y normalizzati")
                    } else {
                        Log.i(TAG, "WS command thermal_spot_measure x=$x y=$y")
                        droneManager.measureThermalSpot(x, y) { ok, err, measurement ->
                            val extra = measurement?.let {
                                ""","x":${it.x},"y":${it.y},"temperature":${it.temperature}"""
                            } ?: ""
                            scope.launch { session.ack("thermal_spot_measure", ok, err, extra) }
                        }
                    }
                }

                "gimbal_rotate_speed" -> {
                    val pitchSpeed = root["pitch_speed"]?.jsonPrimitive?.double ?: 0.0
                    val yawSpeed = root["yaw_speed"]?.jsonPrimitive?.double ?: 0.0
                    val rollSpeed = root["roll_speed"]?.jsonPrimitive?.double ?: 0.0
                    Log.i(TAG, "WS command gimbal_rotate_speed pitch=$pitchSpeed yaw=$yawSpeed roll=$rollSpeed")
                    droneManager.rotateGimbalBySpeed(pitchSpeed, yawSpeed, rollSpeed) { ok, err ->
                        scope.launch { session.ack("gimbal_rotate_speed", ok, err) }
                    }
                }

                "gimbal_rotate_angle" -> {
                    val pitch = root["pitch"]?.jsonPrimitive?.double
                    val yaw = root["yaw"]?.jsonPrimitive?.double
                    val roll = root["roll"]?.jsonPrimitive?.double
                    if (pitch == null && yaw == null && roll == null) {
                        session.sendError("server", "gimbal_rotate_angle richiede almeno uno tra pitch, yaw, roll")
                    } else {
                        val relative = root["relative"]?.jsonPrimitive?.content
                            ?.toBooleanStrictOrNull() ?: true
                        val duration = root["duration"]?.jsonPrimitive?.double ?: 0.3
                        Log.i(TAG, "WS command gimbal_rotate_angle pitch=$pitch yaw=$yaw roll=$roll relative=$relative duration=$duration")
                        droneManager.rotateGimbalByAngle(
                            pitch = pitch,
                            yaw = yaw,
                            roll = roll,
                            relative = relative,
                            duration = duration
                        ) { ok, err ->
                            scope.launch { session.ack("gimbal_rotate_angle", ok, err) }
                        }
                    }
                }

                "gimbal_reset" -> {
                    val resetType = root["reset_type"]?.jsonPrimitive?.content ?: "PITCH_YAW"
                    Log.i(TAG, "WS command gimbal_reset resetType=$resetType")
                    droneManager.resetGimbal(resetType) { ok, err ->
                        scope.launch { session.ack("gimbal_reset", ok, err) }
                    }
                }

                "take_photo" -> {
                    val zoomRatio = root["zoom_ratio"]?.jsonPrimitive?.float ?: 20f
                    Log.i(TAG, "WS command take_photo zoomRatio=$zoomRatio")
                    droneManager.takePhoto(zoomRatio) { ok, err ->
                        scope.launch { session.ack("take_photo", ok, err) }
                    }
                }

                "start_recording" -> droneManager.startRecording { ok, err ->
                    scope.launch { session.ack("start_recording", ok, err) }
                }

                "stop_recording" -> droneManager.stopRecording { ok, err ->
                    scope.launch { session.ack("stop_recording", ok, err) }
                }

                // ── Missioni waypoint ────────────────────────────────────────
                // Formato atteso:
                // {
                //   "type": "start_mission",
                //   "waypoints": [
                //     { "lat": 44.1, "lon": 7.5, "altitude": 30.0, "action": "TAKE_PHOTO", "hover_seconds": 2.0 },
                //     ...
                //   ],
                //   "auto_speed": 5.0,          // opzionale, default 5
                //   "max_speed": 10.0,           // opzionale, default 10
                //   "finished_action": "GO_HOME" // opzionale, default GO_HOME
                // }

                "start_mission" -> {
                    val waypoints = parseMissionWaypoints(root["waypoints"]?.jsonArray)
                    if (waypoints == null) {
                        session.sendError("server", "start_mission richiede waypoints (array non vuoto)")
                    } else {
                        val autoSpeed      = root["auto_speed"]?.jsonPrimitive?.float ?: 5f
                        val maxSpeed       = root["max_speed"]?.jsonPrimitive?.float  ?: 10f
                        val finishedAction = root["finished_action"]?.jsonPrimitive?.content
                            ?.let { name -> WaypointMissionFinishedAction.entries.find { it.name == name } }
                            ?: WaypointMissionFinishedAction.GO_HOME

                        droneManager.uploadAndStartMission(
                            waypoints      = waypoints,
                            autoSpeed      = autoSpeed,
                            maxSpeed       = maxSpeed,
                            finishedAction = finishedAction
                        ) { ok, err ->
                            scope.launch { session.ack("start_mission", ok, err) }
                        }
                    }
                }

                "pause_mission" -> droneManager.pauseMission { ok, err ->
                    scope.launch { session.ack("pause_mission", ok, err) }
                }

                "resume_mission" -> droneManager.resumeMission { ok, err ->
                    scope.launch { session.ack("resume_mission", ok, err) }
                }

                "stop_mission" -> droneManager.stopMission { ok, err ->
                    scope.launch { session.ack("stop_mission", ok, err) }
                }

                "motor" -> droneManager.armMotors { ok, err ->
                    scope.launch { session.ack("motor", ok, err) }
                }
                "confirm_landing" -> droneManager.confirmLanding { ok, err ->
                    scope.launch { session.ack("confirm_landing", ok, err) }
                }
                "set_rth_altitude" -> {
                    val alt = root["altitude"]?.jsonPrimitive?.content?.toIntOrNull()
                    if (alt == null) {
                        session.sendError("server", "set_rth_altitude richiede altitude (int)")
                    } else {
                        droneManager.setRTHAltitude(alt) { ok, err ->
                            scope.launch { session.ack("set_rth_altitude", ok, err) }
                        }
                    }
                }

                // ── Utility ──────────────────────────────────────────────────

                "ping" -> session.send(Frame.Text(
                    """{"type":"pong","timestamp_ms":${System.currentTimeMillis()}}"""
                ))

                null -> session.sendError("server", "Campo 'type' mancante")

                else -> {
                    Log.w(TAG, "Comando sconosciuto: $type")
                    session.sendError("server", "Comando sconosciuto: $type")
                }
            }
        }.onFailure { e ->
            Log.e(TAG, "Errore parsing comando: ${e.message}")
            session.sendError("server", "JSON non valido: ${e.message}")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PARSING WAYPOINTS
    // ─────────────────────────────────────────────────────────────────────────

    private fun parseMissionWaypoints(array: JsonArray?): List<WaypointData>? {
        if (array == null || array.isEmpty()) return null
        return runCatching {
            array.map { element ->
                val obj     = element.jsonObject
                val lat     = obj["lat"]?.jsonPrimitive?.double     ?: return null
                val lon     = obj["lon"]?.jsonPrimitive?.double     ?: return null
                val alt     = obj["altitude"]?.jsonPrimitive?.float ?: return null
                val action  = obj["action"]?.jsonPrimitive?.content
                    ?.let { name -> WaypointAction.entries.find { it.name == name } }
                    ?: WaypointAction.NONE
                val hover   = obj["hover_seconds"]?.jsonPrimitive?.float ?: 0f
                val photoCount = obj["photo_count"]?.jsonPrimitive?.content?.toIntOrNull() ?: 1
                val photoIntervalSeconds = obj["photo_interval_seconds"]?.jsonPrimitive?.float ?: 0f
                val photoTotalSeconds = obj["photo_total_seconds"]?.jsonPrimitive?.float ?: 0f
                val gimbalPitch = obj["gimbal_pitch"]?.jsonPrimitive?.float
                WaypointData(
                    lat          = lat,
                    lon          = lon,
                    altitude     = alt,
                    action       = action,
                    hoverSeconds = hover,
                    photoCount   = photoCount.coerceAtLeast(1),
                    photoIntervalSeconds = photoIntervalSeconds.coerceAtLeast(0f),
                    photoTotalSeconds = photoTotalSeconds.coerceAtLeast(0f),
                    gimbalPitch  = gimbalPitch
                )
            }
        }.getOrNull()
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EVENT PUMP: DroneManager.eventChannel → broadcast a tutti i client WS
    // ─────────────────────────────────────────────────────────────────────────

    private fun startEventPump() {
        scope.launch {
            for (event in eventChannel) {
                var outgoing: DroneEvent? = realtimeBacklog.removeFirstOrNull() ?: event
                while (outgoing != null) {
                    broadcastToAll(coalesceTelemetry(outgoing).toJson())
                    outgoing = realtimeBacklog.removeFirstOrNull()
                }
            }
            Log.i(TAG, "Event pump terminato (canale chiuso)")
        }
    }

    private fun coalesceTelemetry(first: DroneEvent): DroneEvent {
        if (first !is DroneEvent.Telemetry) return first
        var latest: DroneEvent = first
        while (true) {
            val next = eventChannel.tryReceive().getOrNull() ?: break
            if (next is DroneEvent.Telemetry) {
                latest = next
            } else {
                realtimeBacklog.addLast(next)
                break
            }
        }
        return latest
    }

    private suspend fun broadcastToAll(message: String) {
        val sessionsSnapshot = sessionsMutex.withLock { wsSessions.toList() }
        if (sessionsSnapshot.isEmpty()) return

        val dead = mutableListOf<DefaultWebSocketSession>()
        for (session in sessionsSnapshot) {
            runCatching { session.send(Frame.Text(message)) }
                .onFailure { dead.add(session) }
        }

        if (dead.isNotEmpty()) {
            sessionsMutex.withLock {
                wsSessions.removeAll(dead.toSet())
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HELPER EXTENSIONS
    // ─────────────────────────────────────────────────────────────────────────

    private suspend fun DefaultWebSocketSession.ack(
        command: String,
        success: Boolean,
        error:   String? = null,
        extraJson: String = ""
    ) {
        val errorPart = if (error != null) ""","error":"${error.replace("\"", "\\\"")}"""" else ""
        send(Frame.Text("""{"type":"ack","command":"$command","success":$success$errorPart$extraJson}"""))
    }

    private suspend fun DefaultWebSocketSession.sendError(source: String, message: String) {
        send(Frame.Text(DroneEvent.Error(source = source, message = message).toJson()))
    }
}
