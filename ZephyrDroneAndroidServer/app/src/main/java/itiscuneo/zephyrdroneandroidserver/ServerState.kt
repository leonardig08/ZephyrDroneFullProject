package itiscuneo.zephyrdroneandroidserver

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

// ── Modifica questi step come vuoi ───────────────────────────────────────────
val STARTUP_STEPS = listOf(
    StartupStep("INITIALIZING",  "Preparing system…",      600),
    StartupStep("NETWORK",       "Binding HTTP :8081…",    800),
    StartupStep("WEBSOCKET",     "Opening WS channel…",    700),
    StartupStep("DJI SDK",       "Loading DJI SDK…",      1000),
    StartupStep("DRONE SCAN",    "Scanning for drone…",    900),
    StartupStep("CONNECTING",    "Connecting to drone…",   800),
    StartupStep("TELEMETRY",     "Starting telemetry…",    600),
    StartupStep("READY",         "All systems nominal",      0),  // ultimo = running
)

data class StartupStep(val label: String, val detail: String, val durationMs: Long)

object ServerState {
    var stepIndex  by mutableStateOf(-1)      // -1 = stopped
        private set
    var isStarting by mutableStateOf(false)
        private set
    var isRunning  by mutableStateOf(false)
        private set

    // Chiamalo dal file Python-bridge / server per avanzare lo step
    fun setStep(index: Int) {
        stepIndex  = index.coerceIn(-1, STARTUP_STEPS.lastIndex)
        isStarting = stepIndex in 0 until STARTUP_STEPS.lastIndex
        isRunning  = stepIndex == STARTUP_STEPS.lastIndex
    }

    fun reset() { stepIndex = -1; isStarting = false; isRunning = false }
}