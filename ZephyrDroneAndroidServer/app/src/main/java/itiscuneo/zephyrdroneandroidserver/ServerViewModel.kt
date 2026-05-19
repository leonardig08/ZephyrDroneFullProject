package itiscuneo.zephyrdroneandroidserver

import android.app.Application
import android.content.Context
import android.util.Log
import android.view.Surface
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch

private const val TAG      = "ServerViewModel"
private const val USE_MOCK = false  // ← cambia a false quando hai il drone fisico

// ── Stato globale dell'applicazione esposto alla UI ───────────────────────────
data class AppState(
    val phase:              AppPhase = AppPhase.IDLE,
    val errorMessage:       String?  = null,
    val droneProductName:   String?  = null,
    val serverPort:         Int      = 8081,
    val connectedClients:   Int      = 0,
    val lastBatteryPercent: Int?     = null,
    val lastAltitude:       Float?   = null,
    val isFlying:           Boolean  = false,
    val startBattery:       Int? = null
)

enum class AppPhase {
    IDLE,
    INITIALIZING_SDK,
    SDK_ERROR,
    WAITING_DRONE,
    DRONE_ERROR,
    SERVER_STARTING,
    RUNNING,
    STOPPING
}

class ServerViewModel(application: Application) : AndroidViewModel(application) {

    // ── Stato UI ──────────────────────────────────────────────────────────────
    private val _appState = MutableStateFlow(AppState())
    val appState: StateFlow<AppState> = _appState.asStateFlow()

    // ── Sotto-componenti — IDroneManager ovunque ──────────────────────────────
    private var droneManager: IDroneManager? = null
    private var ktorServer:   KtorServer?    = null
    private var ktorStartInProgress: Boolean = false
    private var connectionStateJob: Job?     = null
    private var batteryUiJob: Job?           = null

    // ─────────────────────────────────────────────────────────────────────────
    // AVVIO
    // ─────────────────────────────────────────────────────────────────────────

    fun startServer(activity: AppCompatActivity) {
        if (_appState.value.phase != AppPhase.IDLE &&
            _appState.value.phase != AppPhase.SDK_ERROR &&
            _appState.value.phase != AppPhase.DRONE_ERROR
        ) {
            Log.w(TAG, "startServer ignorato: fase corrente = ${_appState.value.phase}")
            return
        }

        Log.i(TAG, "=== Avvio sequenza START ===")
        connectionStateJob?.cancel()
        connectionStateJob = null
        batteryUiJob?.cancel()
        batteryUiJob = null
        ktorServer?.stop()
        ktorServer = null
        ktorStartInProgress = false
        droneManager?.release()
        droneManager = null

        updatePhase(AppPhase.INITIALIZING_SDK)

        // 1. Crea il manager giusto
        val manager: IDroneManager =
            DroneManager(getApplication(), activity)
        droneManager = manager

        // 2. Osserva lo stato connessione
        connectionStateJob?.cancel()
        connectionStateJob = manager.connectionState
            .onEach { state ->
                if (droneManager !== manager) {
                    Log.w(TAG, "DroneConnectionState ignorato: manager non piu attivo")
                    return@onEach
                }
                handleDroneConnectionState(state, manager)
            }
            .launchIn(viewModelScope)

        // 3. IMPORTANTE:
        // Non consumare manager.eventChannel dalla UI.
        // È il canale usato da Ktor verso Python: due consumer sullo stesso Channel
        // causano perdita di eventi critici (es. landing_confirmation_needed).

        // 4. Avvia SDK
        manager.initSdk()

        refreshBatteryForUi(manager)
        startBatteryUiPolling(manager)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STATE MACHINE
    // ─────────────────────────────────────────────────────────────────────────

    private fun handleDroneConnectionState(
        state:   DroneConnectionState,
        manager: IDroneManager
    ) {
        Log.i(TAG, "DroneConnectionState → $state")

        when (state) {
            is DroneConnectionState.Idle            -> Unit

            is DroneConnectionState.InitializingSDK -> {
                updatePhase(AppPhase.INITIALIZING_SDK)
            }

            is DroneConnectionState.SDKError        -> {
                ktorStartInProgress = false
                updatePhase(AppPhase.SDK_ERROR, errorMessage = state.error)
            }

            is DroneConnectionState.SDKReady        -> {
                updatePhase(AppPhase.WAITING_DRONE)
            }

            is DroneConnectionState.WaitingForDrone -> {
                updatePhase(AppPhase.WAITING_DRONE)
            }

            is DroneConnectionState.DroneConnected -> {
                if (_appState.value.phase == AppPhase.SERVER_STARTING || _appState.value.phase == AppPhase.RUNNING || ktorStartInProgress) {
                    Log.w(TAG, "DroneConnected ignorato: Ktor gia in avvio/attivo")
                    return
                }
                _appState.value = _appState.value.copy(
                    phase            = AppPhase.SERVER_STARTING,
                    droneProductName = state.productName,
                    errorMessage     = null
                )

                // ← applica simulatore qui, quando SDK è pronto
                if (simulatorWanted) {
                    Log.i("ServerViewModel", "Applico simulatore dopo connessione drone...")
                    simulatorHelper.enable { success, error ->
                        Log.i("ServerViewModel", "Simulatore → success=$success error=$error")
                        startKtorServer(manager)
                    }
                } else {
                    startKtorServer(manager)
                }
            }

            is DroneConnectionState.DroneError      -> {
                updatePhase(AppPhase.DRONE_ERROR, errorMessage = state.error)
                ktorServer?.stop()
                ktorServer = null
                ktorStartInProgress = false
                connectionStateJob?.cancel()
                connectionStateJob = null
                batteryUiJob?.cancel()
                batteryUiJob = null
            }
        }
    }

    private fun startKtorServer(manager: IDroneManager) {
        if (droneManager !== manager) {
            Log.w(TAG, "startKtorServer ignorato: manager non piu attivo")
            return
        }
        if (ktorStartInProgress || ktorServer != null || _appState.value.phase == AppPhase.RUNNING) {
            Log.w(TAG, "startKtorServer ignorato: server gia avviato/in avvio o fase RUNNING")
            return
        }
        Log.i(TAG, "Avvio Ktor server...")
        ktorStartInProgress = true
        try {
            val server = KtorServer(
                droneManager = manager,
                eventChannel = manager.eventChannel,
                serverIp     = getServerIp()
            )
            server.start()
            ktorServer = server
            updatePhase(AppPhase.RUNNING)
            Log.i(TAG, "✅ Tutto operativo: drone connesso + server su :8081")
            manager.startVideoStreams()
            startBatteryUiPolling(manager)
        } catch (e: Exception) {
            ktorServer = null
            Log.e(TAG, "Errore avvio Ktor: ${e.message}")
            updatePhase(AppPhase.DRONE_ERROR, errorMessage = "Errore server: ${e.message}")
        } finally {
            ktorStartInProgress = false
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STOP
    // ─────────────────────────────────────────────────────────────────────────

    private fun startBatteryUiPolling(manager: IDroneManager) {
        batteryUiJob?.cancel()
        batteryUiJob = viewModelScope.launch {
            while (true) {
                refreshBatteryForUi(manager)
                delay(2_000L)
            }
        }
    }

    private fun refreshBatteryForUi(manager: IDroneManager) {
        val percent = manager.getBatteryPercentage().toIntOrNull()
        if (percent != null && percent in 0..100) {
            _appState.value = _appState.value.copy(lastBatteryPercent = percent)
        }
    }
    fun stopServer() {
        Log.i(TAG, "=== Avvio sequenza STOP ===")
        updatePhase(AppPhase.STOPPING)

        viewModelScope.launch {
            try {
                ktorServer?.stop()
                ktorServer = null
                ktorStartInProgress = false
                connectionStateJob?.cancel()
                connectionStateJob = null
                batteryUiJob?.cancel()
                batteryUiJob = null

                droneManager?.release()
                droneManager = null

                updatePhase(AppPhase.IDLE)
                Log.i(TAG, "✅ Server fermato correttamente")
            } catch (e: Exception) {
                Log.e(TAG, "Errore durante stop: ${e.message}")
                updatePhase(AppPhase.IDLE)
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AGGIORNAMENTO UI DA EVENTI DRONE
    // ─────────────────────────────────────────────────────────────────────────

    private fun updateUiFromEvent(event: DroneEvent) {
        when (event) {
            is DroneEvent.BatteryUpdate -> {
                _appState.value = _appState.value.copy(
                    lastBatteryPercent = event.chargePercent
                )
            }
            is DroneEvent.Telemetry     -> {
                _appState.value = _appState.value.copy(
                    lastAltitude = event.altitude ?: _appState.value.lastAltitude,
                    isFlying     = event.isFlying ?: _appState.value.isFlying
                )
            }
            is DroneEvent.Error         -> {
                Log.e(TAG, "DroneEvent.Error [${event.source}]: ${event.message}")
            }
            else                        -> Unit
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    private fun updatePhase(phase: AppPhase, errorMessage: String? = null) {
        _appState.value = _appState.value.copy(
            phase        = phase,
            errorMessage = errorMessage
        )
    }

    override fun onCleared() {
        super.onCleared()
        Log.i(TAG, "ViewModel cleared → stop server")
        ktorServer?.stop()
        ktorStartInProgress = false
        connectionStateJob?.cancel()
        connectionStateJob = null
        droneManager?.release()
    }
    fun loginDJI(activity: FragmentActivity) {
        Log.i(TAG, "LOGGING IN")
        droneManager?.loginDJIAccount(activity)
    }
    private val simulatorHelper = SimulatorHelper()
    private var simulatorWanted = false  // ← aggiunto

    fun setSimulator(enabled: Boolean) {
        simulatorWanted = enabled
        Log.i("ServerViewModel", "Simulatore wanted → $enabled (verrà applicato dopo init SDK)")
    }
    fun saveServerIp(ip: String) {
        getApplication<Application>().getSharedPreferences("zephyr", Context.MODE_PRIVATE)
            .edit().putString("server_ip", ip).apply()
    }

    fun getServerIp(): String {
        return getApplication<Application>().getSharedPreferences("zephyr", Context.MODE_PRIVATE)
            .getString("server_ip", "192.168.1.100") ?: "192.168.1.100"
    }
    fun attachCameraSurface(
        surface: Surface,
        width: Int,
        height: Int,
        onResult: (Boolean, String?) -> Unit
    ) {
        droneManager?.attachCameraSurface(surface, width, height, onResult)
            ?: onResult(false, "DroneManager non inizializzato")
    }

    fun detachCameraSurface(surface: Surface?) {
        droneManager?.detachCameraSurface(surface)
    }

    fun switchLiveCamera(
        camera: DroneCamera,
        onResult: (Boolean, String?) -> Unit = { _, _ -> }
    ) {
        droneManager?.switchOperatorCamera(camera, onResult)
            ?: onResult(false, "DroneManager non inizializzato")
    }

    fun setLiveZoom(camera: DroneCamera, ratio: Float) {
        val manager = droneManager ?: return
        if (camera == DroneCamera.IR) return
        manager.setZoomLevel(ratio)
    }

    fun getThermalPaletteState(): ThermalPaletteState {
        return droneManager?.getThermalPaletteState()
            ?: ThermalPaletteState(error = "Server non avviato")
    }

    fun setThermalPalette(
        paletteId: String,
        onResult: (Boolean, String?) -> Unit = { _, _ -> }
    ) {
        droneManager?.setThermalPalette(paletteId, onResult)
            ?: onResult(false, "Server non avviato")
    }

    fun measureThermalSpot(
        x: Double,
        y: Double,
        onResult: (Boolean, String?, ThermalSpotMeasurement?) -> Unit = { _, _, _ -> }
    ) {
        droneManager?.measureThermalSpot(x, y, onResult)
            ?: onResult(false, "Server non avviato", null)
    }

    fun nudgeLiveGimbal(
        pitchDelta: Double = 0.0,
        yawDelta: Double = 0.0,
        onResult: (Boolean, String?) -> Unit = { _, _ -> }
    ) {
        droneManager?.rotateGimbalByAngle(
            pitch = if (pitchDelta == 0.0) null else pitchDelta,
            yaw = if (yawDelta == 0.0) null else yawDelta,
            roll = null,
            relative = true,
            duration = 0.25,
            onResult = onResult
        ) ?: onResult(false, "DroneManager non inizializzato")
    }

    fun resetLiveGimbal(onResult: (Boolean, String?) -> Unit = { _, _ -> }) {
        droneManager?.resetGimbal("PITCH_YAW", onResult)
            ?: onResult(false, "DroneManager non inizializzato")
    }

    fun setLiveGimbalSpeed(
        pitchSpeed: Double = 0.0,
        yawSpeed: Double = 0.0,
        onResult: (Boolean, String?) -> Unit = { _, _ -> }
    ) {
        droneManager?.rotateGimbalBySpeed(
            pitchSpeed = pitchSpeed,
            yawSpeed = yawSpeed,
            rollSpeed = 0.0,
            onResult = onResult
        ) ?: onResult(false, "DroneManager non inizializzato")
    }
}
