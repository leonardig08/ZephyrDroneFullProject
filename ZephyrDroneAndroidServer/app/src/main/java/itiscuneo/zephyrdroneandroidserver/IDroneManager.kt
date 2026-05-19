package itiscuneo.zephyrdroneandroidserver

import android.view.Surface
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.StateFlow

// ── Dati waypoint esposti verso KtorServer/Python ────────────────────────────
data class WaypointData(
    val lat:          Double,
    val lon:          Double,
    val altitude:     Float,
    val action:       WaypointAction = WaypointAction.NONE,
    val hoverSeconds: Float          = 0f,
    val photoCount:   Int            = 1,
    val photoIntervalSeconds: Float  = 0f,
    val photoTotalSeconds: Float     = 0f,
    val gimbalPitch:  Float?         = null,
    val roiLat:       Double?        = null,
    val roiLon:       Double?        = null,
    val roiAlt:       Float?         = null,
)

enum class WaypointAction {
    NONE, TAKE_PHOTO, TAKE_PHOTO_EXPERIMENTAL, RECORD_START, RECORD_STOP
}

enum class WaypointMissionFinishedAction {
    GO_HOME, LAND, HOVER, RETURN_TO_FIRST_WAYPOINT
}

data class ThermalPaletteOption(
    val id: String,
    val label: String
)

data class ThermalPaletteState(
    val options: List<ThermalPaletteOption> = emptyList(),
    val current: ThermalPaletteOption? = null,
    val error: String? = null
)

data class ThermalSpotMeasurement(
    val x: Double,
    val y: Double,
    val temperature: Double
)

// ─────────────────────────────────────────────────────────────────────────────

interface IDroneManager {
    val connectionState:  StateFlow<DroneConnectionState>
    val eventChannel:     Channel<DroneEvent>
    val isDroneConnected: Boolean

    fun loginDJIAccount(activity: FragmentActivity)
    fun initSdk()
    fun release()
    fun getBatteryPercentage(): String

    // ── Volo base ─────────────────────────────────────────────────────────────
    fun takeoff(onResult:    (Boolean, String?) -> Unit = { _, _ -> })
    fun land(onResult:       (Boolean, String?) -> Unit = { _, _ -> })
    fun returnHome(onResult: (Boolean, String?) -> Unit = { _, _ -> })

    // ── Home point ────────────────────────────────────────────────────────────
    fun setHomePoint(lat: Double, lon: Double, onResult: (Boolean, String?) -> Unit = { _, _ -> })
    fun getHomePoint(onResult: (Double?, Double?) -> Unit)

    // ── Camera ────────────────────────────────────────────────────────────────
    fun startVideoStreams()
    fun stopVideoStreams()
    fun switchOperatorCamera(camera: DroneCamera, onResult: (Boolean, String?) -> Unit = { _, _ -> }) {}
    fun setZoomLevel(ratio: Float)                {}
    fun setThermalZoom(ratio: Float)              {}
    fun getThermalPaletteState(): ThermalPaletteState = ThermalPaletteState(error = "DroneManager non inizializzato")
    fun setThermalPalette(paletteId: String, onResult: (Boolean, String?) -> Unit = { _, _ -> }) {
        onResult(false, "DroneManager non inizializzato")
    }
    fun measureThermalSpot(
        x: Double,
        y: Double,
        onResult: (Boolean, String?, ThermalSpotMeasurement?) -> Unit = { _, _, _ -> }
    ) {
        onResult(false, "DroneManager non inizializzato", null)
    }
    fun rotateGimbalBySpeed(
        pitchSpeed: Double = 0.0,
        yawSpeed: Double = 0.0,
        rollSpeed: Double = 0.0,
        onResult: (Boolean, String?) -> Unit = { _, _ -> }
    ) {}
    fun rotateGimbalByAngle(
        pitch: Double? = null,
        yaw: Double? = null,
        roll: Double? = null,
        relative: Boolean = true,
        duration: Double = 0.3,
        onResult: (Boolean, String?) -> Unit = { _, _ -> }
    ) {}
    fun resetGimbal(
        resetType: String = "PITCH_YAW",
        onResult: (Boolean, String?) -> Unit = { _, _ -> }
    ) {}
    fun takePhoto(zoomRatio: Float = 20f, onResult: (Boolean, String?) -> Unit = { _, _ -> })
    fun startRecording(onResult:  (Boolean, String?) -> Unit = { _, _ -> })
    fun stopRecording(onResult:   (Boolean, String?) -> Unit = { _, _ -> })
    fun attachCameraSurface(
        surface: Surface,
        width: Int,
        height: Int,
        onResult: (Boolean, String?) -> Unit = { _, _ -> }
    ) {}

    fun detachCameraSurface(surface: Surface?) {}

    // ── Missioni waypoint ─────────────────────────────────────────────────────
    fun uploadAndStartMission(
        waypoints:      List<WaypointData>,
        autoSpeed:      Float                         = 5f,
        maxSpeed:       Float                         = 10f,
        finishedAction: WaypointMissionFinishedAction = WaypointMissionFinishedAction.GO_HOME,
        onResult:       (Boolean, String?) -> Unit    = { _, _ -> }
    )
    fun pauseMission(onResult:  (Boolean, String?) -> Unit = { _, _ -> })
    fun resumeMission(onResult: (Boolean, String?) -> Unit = { _, _ -> })
    // stopMission non prende missionName: DroneManager tiene traccia internamente
    fun stopMission(onResult:   (Boolean, String?) -> Unit = { _, _ -> })
    fun armMotors(onResult: (Boolean, String?) -> Unit = { _, _ -> })
    fun confirmLanding(onResult: (Boolean, String?) -> Unit = { _, _ -> })
    fun setRTHAltitude(altitudeMeters: Int, onResult: (Boolean, String?) -> Unit = { _, _ -> })
}
