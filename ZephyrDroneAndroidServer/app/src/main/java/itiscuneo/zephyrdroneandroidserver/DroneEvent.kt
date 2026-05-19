package itiscuneo.zephyrdroneandroidserver

// Tutti gli eventi emessi da DroneManager verso KtorServer/Python via WebSocket
sealed class DroneEvent {

    data class ConnectionChanged(
        val connected:   Boolean,
        val productName: String? = null
    ) : DroneEvent()

    data class Telemetry(
        val latitude:       Double?  = null,
        val longitude:      Double?  = null,
        val altitude:       Float?   = null,
        val pitch:          Float?   = null,
        val roll:           Float?   = null,
        val yaw:            Float?   = null,
        val velocityX:      Float?   = null,
        val velocityY:      Float?   = null,
        val velocityZ:      Float?   = null,
        val gimbalPitch:    Float?   = null,
        val gimbalRoll:     Float?   = null,
        val gimbalYaw:      Float?   = null,
        val gimbalYawRel:   Float?   = null,
        val isFlying:       Boolean? = null,
        val gpsSignalLevel: Int?     = null
    ) : DroneEvent()

    data class BatteryUpdate(
        val chargePercent: Int,
        val temperature:   Float? = null
    ) : DroneEvent()

    data class VideoFrame(
        val camera:      String,
        val base64Jpeg:  String,
        val width:       Int,
        val height:      Int,
        val timestampMs: Long
    ) : DroneEvent()

    data class CameraSwitch(
        val target: String,
        val camera: String
    ) : DroneEvent()

    data class MissionStateChanged(
        val state: String
    ) : DroneEvent()

    data class MissionProgress(
        val waypointIndex: Int,
        val missionName:   String?,
        val waylineId:     Int? = null
    ) : DroneEvent()

    data class LandingConfirmationNeeded(
        val needed: Boolean
    ) : DroneEvent()

    data class Error(
        val source:  String,
        val code:    Int?   = null,
        val message: String
    ) : DroneEvent()
}

// ─────────────────────────────────────────────────────────────────────────────
// Serializzazione a JSON (manuale, senza @Serializable su sealed class)
// ─────────────────────────────────────────────────────────────────────────────

fun DroneEvent.toJson(): String = when (this) {

    is DroneEvent.ConnectionChanged -> json("connection_changed") {
        field("connected", connected)
        productName?.let { field("product_name", it) }
    }

    is DroneEvent.Telemetry -> json("telemetry") {
        latitude?.let       { field("latitude", it) }
        longitude?.let      { field("longitude", it) }
        altitude?.let       { field("altitude", it) }
        pitch?.let          { field("pitch", it) }
        roll?.let           { field("roll", it) }
        yaw?.let            { field("yaw", it) }
        velocityX?.let      { field("velocity_x", it) }
        velocityY?.let      { field("velocity_y", it) }
        velocityZ?.let      { field("velocity_z", it) }
        gimbalPitch?.let    { field("gimbal_pitch", it) }
        gimbalRoll?.let     { field("gimbal_roll", it) }
        gimbalYaw?.let      { field("gimbal_yaw", it) }
        gimbalYawRel?.let   { field("gimbal_yaw_relative", it) }
        isFlying?.let       { field("is_flying", it) }
        gpsSignalLevel?.let { field("gps_signal", it) }
    }

    is DroneEvent.BatteryUpdate -> json("battery") {
        field("charge_percent", chargePercent)
        temperature?.let { field("temperature", it) }
    }

    is DroneEvent.VideoFrame -> json("video_frame") {
        field("camera", camera)
        field("width", width)
        field("height", height)
        field("timestamp_ms", timestampMs)
        field("data", base64Jpeg)
    }

    is DroneEvent.CameraSwitch -> json("camera_switch") {
        field("target", target)
        field("camera", camera)
    }

    is DroneEvent.MissionStateChanged -> json("mission_state") {
        field("state", state)
    }

    is DroneEvent.MissionProgress -> json("mission_progress") {
        field("waypoint_index", waypointIndex)
        missionName?.let { field("mission_name", it) }
        waylineId?.let { field("wayline_id", it) }
    }

    is DroneEvent.LandingConfirmationNeeded -> json("landing_confirmation_needed") {
        field("needed", needed)
    }

    is DroneEvent.Error -> json("error") {
        field("source", source)
        field("message", message)
        code?.let { field("code", it) }
    }
}

// ── Builder DSL minimale ──────────────────────────────────────────────────────

private class JsonBuilder {
    private val sb      = StringBuilder()
    private var isFirst = true

    fun field(key: String, value: String) {
        comma(); sb.append(""""$key":"${value.replace("\"", "\\\"")}"""")
    }
    fun field(key: String, value: Number) {
        comma(); sb.append(""""$key":$value""")
    }
    fun field(key: String, value: Boolean) {
        comma(); sb.append(""""$key":$value""")
    }
    private fun comma() { if (!isFirst) sb.append(",") else isFirst = false }
    fun build() = sb.toString()
}

private fun json(type: String, block: JsonBuilder.() -> Unit): String {
    val body = JsonBuilder().also(block).build()
    return if (body.isEmpty()) """{"type":"$type"}"""
    else """{"type":"$type",$body}"""
}
