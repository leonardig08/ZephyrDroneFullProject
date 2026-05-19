package itiscuneo.zephyrdroneandroidserver

import android.content.Context
import kotlinx.coroutines.delay
import android.graphics.Bitmap
import android.util.Log
import android.view.Surface
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.FragmentActivity
import dji.sdk.keyvalue.key.BatteryKey
import dji.sdk.keyvalue.key.CameraKey
import dji.sdk.keyvalue.key.FlightControllerKey
import dji.sdk.keyvalue.key.GimbalKey
import dji.sdk.keyvalue.key.KeyTools
import dji.sdk.keyvalue.key.ProductKey
import dji.sdk.keyvalue.value.camera.CameraVideoStreamSourceType
import dji.sdk.keyvalue.value.camera.CameraMode
import dji.sdk.keyvalue.value.camera.CameraThermalPalette
import dji.sdk.keyvalue.value.camera.ThermalDigitalZoomFactor
import dji.sdk.keyvalue.value.camera.ThermalTemperatureMeasureMode
import dji.sdk.keyvalue.value.common.CameraLensType
import dji.sdk.keyvalue.value.common.ComponentIndexType
import dji.sdk.keyvalue.value.common.DoublePoint2D
import dji.sdk.keyvalue.value.common.EmptyMsg
import dji.sdk.keyvalue.value.common.LocationCoordinate2D
import dji.sdk.keyvalue.value.flightcontroller.GoHomeState
import dji.sdk.keyvalue.value.product.ProductType
import dji.sdk.keyvalue.value.gimbal.GimbalAngleRotation
import dji.sdk.keyvalue.value.gimbal.GimbalAngleRotationMode
import dji.sdk.keyvalue.value.gimbal.GimbalMode
import dji.sdk.keyvalue.value.gimbal.GimbalResetType
import dji.sdk.keyvalue.value.gimbal.GimbalSpeedRotation
import dji.v5.common.callback.CommonCallbacks
import dji.v5.common.error.IDJIError
import dji.v5.common.register.DJISDKInitEvent
import dji.v5.manager.KeyManager
import dji.v5.manager.SDKManager
import dji.v5.manager.account.LoginState
import dji.v5.manager.account.UserAccountManager
import dji.v5.manager.aircraft.waypoint3.model.WaylineExecutingInfo
import dji.v5.manager.aircraft.waypoint3.model.WaypointMissionExecuteState
import dji.v5.manager.datacenter.MediaDataCenter
import dji.v5.manager.datacenter.camera.CameraStreamManager
import dji.v5.manager.datacenter.livestream.LiveStreamSettings
import dji.v5.manager.datacenter.livestream.LiveStreamType
import dji.v5.manager.datacenter.livestream.LiveVideoBitrateMode
import dji.v5.manager.datacenter.livestream.StreamQuality
import dji.v5.manager.datacenter.livestream.settings.RtspSettings
import dji.v5.manager.interfaces.ICameraStreamManager
import dji.v5.manager.interfaces.SDKManagerCallback
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.ByteArrayOutputStream
import androidx.compose.ui.zIndex

private const val TAG = "DroneManager"
private const val EVENT_CHANNEL_CAPACITY = 2048
private const val CAMERA_PREFS_NAME = "zephyr_camera"
private const val THERMAL_PALETTE_PREF_KEY = "thermal_palette"

// ── Camera index esposti all'esterno ─────────────────────────────────────────
enum class DroneCamera(
    val componentIndex: ComponentIndexType,
    val streamSource:   CameraVideoStreamSourceType,
    val lensType:       CameraLensType,
    val photoComponentIndex: ComponentIndexType = ComponentIndexType.LEFT_OR_MAIN
) {
    WIDE(ComponentIndexType.LEFT_OR_MAIN, CameraVideoStreamSourceType.WIDE_CAMERA,     CameraLensType.CAMERA_LENS_WIDE),
    ZOOM(ComponentIndexType.LEFT_OR_MAIN, CameraVideoStreamSourceType.ZOOM_CAMERA,     CameraLensType.CAMERA_LENS_ZOOM),
    IR(ComponentIndexType.LEFT_OR_MAIN,   CameraVideoStreamSourceType.INFRARED_CAMERA, CameraLensType.CAMERA_LENS_THERMAL)
}

sealed class DroneConnectionState {
    object Idle                                        : DroneConnectionState()
    object InitializingSDK                             : DroneConnectionState()
    data class SDKError(val error: String)             : DroneConnectionState()
    object SDKReady                                    : DroneConnectionState()
    object WaitingForDrone                             : DroneConnectionState()
    data class DroneConnected(val productName: String) : DroneConnectionState()
    data class DroneError(val error: String)           : DroneConnectionState()
}

class DroneManager(
    private val context:  Context,
    private val activity: AppCompatActivity
) : IDroneManager {

    private var scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var currentZoom: Float = 1f

    private val _connectionState = MutableStateFlow<DroneConnectionState>(DroneConnectionState.Idle)
    override val connectionState: StateFlow<DroneConnectionState> = _connectionState.asStateFlow()

    override var eventChannel = Channel<DroneEvent>(
        capacity = EVENT_CHANNEL_CAPACITY,
        onBufferOverflow = BufferOverflow.DROP_OLDEST
    )
        private set

    override val isDroneConnected: Boolean
        get() = _connectionState.value is DroneConnectionState.DroneConnected

    // ── Camera corrente dell'operatore (per RTSP) ─────────────────────────────
    private var operatorCamera: DroneCamera = DroneCamera.WIDE
    private var isRecordingVideo: Boolean = false
    private val thermalMeasurementMutex = Mutex()

    // ── WaypointMissionHelper ─────────────────────────────────────────────────
    // currentMissionName è tracciato internamente da WaypointMissionHelper
    private val missionHelper by lazy {
        WaypointMissionHelper(context, scope)
    }
    private var missionListenersRegistered = false
    private var landingStateListenersRegistered = false
    private var landingCompletionMonitorArmed = false
    private var lastLandingConfirmationNeeded: Boolean? = null

    // ─────────────────────────────────────────────────────────────────────────
    // UTILS
    // ─────────────────────────────────────────────────────────────────────────

    private fun safeSend(event: DroneEvent) {
        val result = eventChannel.trySend(event)
        if (result.isFailure && !result.isClosed) {
            Log.w(TAG, "Event dropped (channel full): ${event::class.simpleName}")
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LOGIN
    // ─────────────────────────────────────────────────────────────────────────

    override fun loginDJIAccount(activity: FragmentActivity) {
        UserAccountManager.getInstance().logInDJIUserAccount(
            activity,
            false,
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() { Log.i(TAG, "Login DJI riuscito") }
                override fun onFailure(error: IDJIError) { Log.e(TAG, "Login DJI fallito: ${error.description()}") }
            }
        )
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SDK INIT
    // ─────────────────────────────────────────────────────────────────────────

    override fun initSdk() {
        if (_connectionState.value != DroneConnectionState.Idle &&
            _connectionState.value !is DroneConnectionState.SDKError
        ) {
            Log.w(TAG, "SDK già inizializzato o in corso")
            return
        }

        _connectionState.value = DroneConnectionState.InitializingSDK
        Log.i(TAG, "Inizializzazione DJI SDK v5...")

        SDKManager.getInstance().init(context, object : SDKManagerCallback {

            override fun onInitProcess(event: DJISDKInitEvent, totalProcess: Int) {
                if (event == DJISDKInitEvent.INITIALIZE_COMPLETE) {
                    SDKManager.getInstance().registerApp()
                }
            }

            override fun onRegisterSuccess() {
                Log.i(TAG, "SDK registrato → controllo login...")
                val loginInfo = UserAccountManager.getInstance().getLoginInfo()
                if (loginInfo?.loginState == LoginState.LOGGED_IN) {
                    Log.i(TAG, "Già loggato, procedo")
                    _connectionState.value = DroneConnectionState.SDKReady
                    _connectionState.value = DroneConnectionState.WaitingForDrone
                } else {
                    Log.i(TAG, "Non loggato, apro login...")
                    UserAccountManager.getInstance().logInDJIUserAccount(
                        activity,
                        false,
                        object : CommonCallbacks.CompletionCallback {
                            override fun onSuccess() {
                                Log.i(TAG, "Login riuscito")
                                _connectionState.value = DroneConnectionState.SDKReady
                                _connectionState.value = DroneConnectionState.WaitingForDrone
                            }
                            override fun onFailure(error: IDJIError) {
                                Log.e(TAG, "Login fallito: ${error.description()}")
                                _connectionState.value = DroneConnectionState.SDKError(error.description())
                            }
                        }
                    )
                }
            }

            override fun onRegisterFailure(error: IDJIError?) {
                val msg = error?.description() ?: "Errore sconosciuto"
                Log.e(TAG, "SDK register failed: $msg")
                _connectionState.value = DroneConnectionState.SDKError(msg)
                scope.launch {
                    safeSend(DroneEvent.Error(
                        source  = "sdk",
                        code    = error?.errorCode()?.toIntOrNull(),
                        message = msg
                    ))
                }
            }

            override fun onProductConnect(productId: Int) {
                Log.i(TAG, "Prodotto connesso: $productId")
                scope.launch {
                    kotlinx.coroutines.delay(1000)
                    val productName = getProductName()
                    _connectionState.value = DroneConnectionState.DroneConnected(productName)
                    safeSend(DroneEvent.ConnectionChanged(connected = true, productName = productName))
                    startDataListeners()
                    setupMissionListeners()
                    setRTHAltitude(30) // ← imposta subito 30m al posto di 100m default
                }
            }

            override fun onProductDisconnect(productId: Int) {
                Log.w(TAG, "Prodotto disconnesso: $productId")
                _connectionState.value = DroneConnectionState.WaitingForDrone
                missionHelper.removeListeners()
                missionListenersRegistered = false
                missionHelper.clearCurrentMission()
                removeLandingStateListeners()
                scope.launch { safeSend(DroneEvent.ConnectionChanged(connected = false)) }
            }

            override fun onProductChanged(productId: Int) {
                Log.i(TAG, "Prodotto cambiato: $productId")
            }

            override fun onDatabaseDownloadProgress(current: Long, total: Long) {
                Log.d(TAG, "DB download: $current/$total")
            }
        })
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MISSION LISTENERS (collegati al WaypointMissionHelper)
    // ─────────────────────────────────────────────────────────────────────────

    private fun setupMissionListeners() {
        if (missionListenersRegistered) return
        missionHelper.addExecutionListeners(
            onStateChanged = { state: WaypointMissionExecuteState ->
                scope.launch {
                    safeSend(DroneEvent.MissionStateChanged(state = state.name))
                    if (state == WaypointMissionExecuteState.FINISHED) {
                        missionHelper.clearCurrentMission()
                    }
                }
            },
            onWaylineInfo = { info: WaylineExecutingInfo ->
                scope.launch {
                    safeSend(DroneEvent.MissionProgress(
                        waypointIndex = info.currentWaypointIndex,
                        missionName   = info.missionFileName,
                        waylineId     = info.waylineID
                    ))
                }
            }
        )
        missionListenersRegistered = true
    }

    private fun setupLandingStateListeners() {
        if (landingStateListenersRegistered) return
        val km = KeyManager.getInstance()
        km.listen(KeyTools.createKey(FlightControllerKey.KeyIsLandingConfirmationNeeded), this) { _, needed ->
            val value = needed ?: false
            if (lastLandingConfirmationNeeded != value) {
                lastLandingConfirmationNeeded = value
                scope.launch { safeSend(DroneEvent.LandingConfirmationNeeded(needed = value)) }
            }
        }
        landingStateListenersRegistered = true
    }

    private fun removeLandingStateListeners() {
        val km = KeyManager.getInstance()
        km.cancelListen(KeyTools.createKey(FlightControllerKey.KeyIsLandingConfirmationNeeded), this)
        km.cancelListen(KeyTools.createKey(FlightControllerKey.KeyIsFlying), this)
        landingStateListenersRegistered = false
        landingCompletionMonitorArmed = false
        lastLandingConfirmationNeeded = null
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TELEMETRY + BATTERY LISTENERS
    // ─────────────────────────────────────────────────────────────────────────

    private fun startDataListeners() {

        startBatteryListeners()
        startTelemetryLoop()
        setupLandingStateListeners()
        Log.i(TAG, "Tutti i listener avviati")
    }

    private fun startTelemetryLoop() {
        val km = KeyManager.getInstance()
        scope.launch(Dispatchers.Default) {
            while (true) {
                delay(11) // ~90Hz, realtime telemetry without building backlog
                if (!isDroneConnected) continue
                try {
                    val location = km.getValue(KeyTools.createKey(FlightControllerKey.KeyAircraftLocation3D))
                    val attitude = km.getValue(KeyTools.createKey(FlightControllerKey.KeyAircraftAttitude))
                    val velocity = km.getValue(KeyTools.createKey(FlightControllerKey.KeyAircraftVelocity))
                    val altitude = km.getValue(KeyTools.createKey(FlightControllerKey.KeyAltitude))
                    val isFlying = km.getValue(KeyTools.createKey(FlightControllerKey.KeyIsFlying))
                    val gps      = km.getValue(KeyTools.createKey(FlightControllerKey.KeyGPSSignalLevel))
                    val gimbalAttitude = km.getValue(
                        KeyTools.createKey(GimbalKey.KeyGimbalAttitude, ComponentIndexType.LEFT_OR_MAIN)
                    )
                    val gimbalYawRelative = km.getValue(
                        KeyTools.createKey(GimbalKey.KeyYawRelativeToAircraftHeading, ComponentIndexType.LEFT_OR_MAIN)
                    )

                safeSend(DroneEvent.Telemetry(
                        latitude       = (location as? dji.sdk.keyvalue.value.common.LocationCoordinate3D)?.latitude,
                        longitude      = (location as? dji.sdk.keyvalue.value.common.LocationCoordinate3D)?.longitude,
                        altitude       = (altitude as? Double)?.toFloat()
                            ?: (location as? dji.sdk.keyvalue.value.common.LocationCoordinate3D)?.altitude?.toFloat(),
                        pitch          = (attitude as? dji.sdk.keyvalue.value.common.Attitude)?.pitch?.toFloat(),
                        roll           = (attitude as? dji.sdk.keyvalue.value.common.Attitude)?.roll?.toFloat(),
                        yaw            = (attitude as? dji.sdk.keyvalue.value.common.Attitude)?.yaw?.toFloat(),
                        velocityX      = (velocity as? dji.sdk.keyvalue.value.common.Velocity3D)?.x?.toFloat(),
                        velocityY      = (velocity as? dji.sdk.keyvalue.value.common.Velocity3D)?.y?.toFloat(),
                        velocityZ      = (velocity as? dji.sdk.keyvalue.value.common.Velocity3D)?.z?.toFloat(),
                        gimbalPitch    = (gimbalAttitude as? dji.sdk.keyvalue.value.common.Attitude)?.pitch?.toFloat(),
                        gimbalRoll     = (gimbalAttitude as? dji.sdk.keyvalue.value.common.Attitude)?.roll?.toFloat(),
                        gimbalYaw      = (gimbalAttitude as? dji.sdk.keyvalue.value.common.Attitude)?.yaw?.toFloat(),
                        gimbalYawRel   = (gimbalYawRelative as? Double)?.toFloat(),
                        isFlying       = isFlying as? Boolean,
                        gpsSignalLevel = (gps as? dji.sdk.keyvalue.value.flightcontroller.GPSSignalLevel)?.value()
                    ))
                } catch (e: Exception) {
                    Log.w(TAG, "telemetryLoop: ${e.message}")
                }
            }
        }
    }

    private fun startTelemetryListeners() {
        val km = KeyManager.getInstance()


        km.listen(KeyTools.createKey(FlightControllerKey.KeyFlightMode), this) { _, v ->
            Log.i(TAG, "FlightMode: $v")
        }
        km.listen(KeyTools.createKey(FlightControllerKey.KeyIMUStatus), this) { _, v ->
            Log.i(TAG, "IMU preriscaldamento: $v")
        }
        km.listen(KeyTools.createKey(FlightControllerKey.KeyCompassCalibrationStatus), this) { _, v ->
            Log.i(TAG, "Bussola stato: $v")
        }
        km.listen(KeyTools.createKey(FlightControllerKey.KeyTakeoffFailureError), this) { _, v ->
            Log.i(TAG, "FC errore generale: $v")
        }
    }

    private fun startBatteryListeners() {
        val km = KeyManager.getInstance()

        km.listen(
            KeyTools.createKey(BatteryKey.KeyChargeRemainingInPercent, ComponentIndexType.LEFT_OR_MAIN),
            this
        ) { _, v ->
            v ?: return@listen
            scope.launch { safeSend(DroneEvent.BatteryUpdate(chargePercent = v)) }
        }
        km.listen(
            KeyTools.createKey(BatteryKey.KeyBatteryTemperature, ComponentIndexType.LEFT_OR_MAIN),
            this
        ) { _, v ->
            v ?: return@listen
            scope.launch {
                safeSend(DroneEvent.BatteryUpdate(
                    chargePercent = getBatteryPercentage().toIntOrNull() ?: 0,
                    temperature   = v.toFloat()
                ))
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // VIDEO — LIVE STREAM (operatore) + FRAME LISTENERS (AI)
    // ─────────────────────────────────────────────────────────────────────────



    override fun startVideoStreams() {
        setVideoMode { _, _ ->
            startLiveStream(operatorCamera)
        }
    }

    override fun stopVideoStreams() {
        stopLiveStream()
    }

    // ── RTSP per operatore ─────────────────────────────────────────────────
    private fun startLiveStream(camera: DroneCamera) {
        MediaDataCenter.getInstance().liveStreamManager.apply {
            setCameraIndex(ComponentIndexType.LEFT_OR_MAIN)
            setLiveStreamSettings(
                LiveStreamSettings.Builder()
                    .setLiveStreamType(LiveStreamType.RTSP)
                    .setRtspSettings(
                        RtspSettings.Builder()
                            .setUserName("zephyr")
                            .setPassWord("zephyr123")
                            .setPort(8554)
                            .build()
                    )
                    .build()
            )
            setLiveVideoBitrateMode(LiveVideoBitrateMode.AUTO)
            setLiveStreamQuality(StreamQuality.SD)

            startStream(object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() { Log.i(TAG, "RTSP avviato su camera ${camera.name}") }
                override fun onFailure(e: IDJIError) {
                    Log.e(TAG, "RTSP fallito camera ${camera.name}: ${e.description()}")
                }
            })
        }
    }

    private fun stopLiveStream() {
        MediaDataCenter.getInstance().liveStreamManager.stopStream(
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() { Log.i(TAG, "RTSP fermato") }
                override fun onFailure(e: IDJIError) { Log.w(TAG, "RTSP stop: ${e.description()}") }
            }
        )
    }

    override fun switchOperatorCamera(camera: DroneCamera, onResult: (Boolean, String?) -> Unit) {
        Log.i(TAG, "Switch camera operatore → ${camera.name}")
        operatorCamera = camera
        reclaimManualGimbalControl("switch_camera")
        applyOperatorCameraSource(camera, onResult)
    }

    private fun applyOperatorCameraSource(
        camera: DroneCamera,
        onResult: (Boolean, String?) -> Unit = { _, _ -> }
    ) {
        Log.i(TAG, "Applico source camera=${camera.name} stream=${camera.streamSource.name}")
        KeyManager.getInstance().setValue(
            KeyTools.createKey(CameraKey.KeyCameraVideoStreamSource, ComponentIndexType.LEFT_OR_MAIN),
            camera.streamSource,
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() {
                    Log.i(TAG, "Camera switchata a ${camera.name}")
                    logCurrentVideoSource("switch_success_${camera.name}")
                    if (camera == DroneCamera.IR) {
                        applySavedThermalPalette()
                    }
                    scope.launch {
                        safeSend(DroneEvent.CameraSwitch(target = "operator", camera = camera.name))
                    }
                    onResult(true, null)
                }
                override fun onFailure(error: IDJIError) {
                    val desc = error.description().orUnknownDjiError()
                    Log.e(TAG, "Switch camera fallito: $desc")
                    onResult(false, desc)
                }
            }
        )
    }


    // ── NV21 → Bitmap ──────────────────────────────────────────────────────
    private fun thermalPaletteKey() =
        KeyTools.createCameraKey(
            CameraKey.KeyThermalPalette,
            ComponentIndexType.LEFT_OR_MAIN,
            CameraLensType.CAMERA_LENS_THERMAL
        )

    private fun thermalPaletteRangeKey() =
        KeyTools.createCameraKey(
            CameraKey.KeyThermalPaletteRange,
            ComponentIndexType.LEFT_OR_MAIN,
            CameraLensType.CAMERA_LENS_THERMAL
        )

    private fun thermalMeasureModeKey() =
        KeyTools.createCameraKey(
            CameraKey.KeyThermalTemperatureMeasureMode,
            ComponentIndexType.LEFT_OR_MAIN,
            CameraLensType.CAMERA_LENS_THERMAL
        )

    private fun thermalSpotPointKey() =
        KeyTools.createCameraKey(
            CameraKey.KeyThermalSpotMetersurePoint,
            ComponentIndexType.LEFT_OR_MAIN,
            CameraLensType.CAMERA_LENS_THERMAL
        )

    private fun thermalSpotTemperatureKey() =
        KeyTools.createCameraKey(
            CameraKey.KeyThermalSpotMetersureTemperature,
            ComponentIndexType.LEFT_OR_MAIN,
            CameraLensType.CAMERA_LENS_THERMAL
        )

    private fun CameraThermalPalette.toOption() = ThermalPaletteOption(
        id = name,
        label = name.replace('_', ' ')
    )

    private fun savedThermalPaletteId(): String? =
        context.getSharedPreferences(CAMERA_PREFS_NAME, Context.MODE_PRIVATE)
            .getString(THERMAL_PALETTE_PREF_KEY, null)

    private fun saveThermalPaletteId(id: String) {
        context.getSharedPreferences(CAMERA_PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(THERMAL_PALETTE_PREF_KEY, id)
            .apply()
    }

    override fun getThermalPaletteState(): ThermalPaletteState {
        return try {
            val available = (KeyManager.getInstance().getValue(thermalPaletteRangeKey()) as? List<*>)
                ?.filterIsInstance<CameraThermalPalette>()
                ?.filter { it != CameraThermalPalette.UNKNOWN }
                ?: emptyList()
            val current = KeyManager.getInstance().getValue(thermalPaletteKey()) as? CameraThermalPalette
            ThermalPaletteState(
                options = available.map { it.toOption() },
                current = current?.takeIf { it != CameraThermalPalette.UNKNOWN }?.toOption(),
                error = if (available.isEmpty()) "Palette IR non disponibili dal drone." else null
            )
        } catch (e: Exception) {
            Log.w(TAG, "Lettura palette IR fallita: ${e.message}")
            ThermalPaletteState(error = e.message ?: "Lettura palette IR fallita")
        }
    }

    override fun setThermalPalette(paletteId: String, onResult: (Boolean, String?) -> Unit) {
        val palette = runCatching { CameraThermalPalette.valueOf(paletteId) }.getOrNull()
        if (palette == null || palette == CameraThermalPalette.UNKNOWN) {
            onResult(false, "Palette IR non valida: $paletteId")
            return
        }
        applyOperatorCameraSource(DroneCamera.IR) { ok, err ->
            if (!ok) {
                onResult(false, err)
                return@applyOperatorCameraSource
            }
            KeyManager.getInstance().setValue(
                thermalPaletteKey(),
                palette,
                object : CommonCallbacks.CompletionCallback {
                    override fun onSuccess() {
                        Log.i(TAG, "Thermal palette impostata: ${palette.name}")
                        saveThermalPaletteId(palette.name)
                        onResult(true, null)
                    }
                    override fun onFailure(error: IDJIError) {
                        val desc = error.description().orUnknownDjiError()
                        Log.e(TAG, "Thermal palette fallita: $desc")
                        onResult(false, desc)
                    }
                }
            )
        }
    }

    override fun measureThermalSpot(
        x: Double,
        y: Double,
        onResult: (Boolean, String?, ThermalSpotMeasurement?) -> Unit
    ) {
        val nx = x.coerceIn(0.0, 1.0)
        val ny = y.coerceIn(0.0, 1.0)
        if (operatorCamera != DroneCamera.IR) {
            onResult(false, "Misura temperatura disponibile solo in IR", null)
            return
        }

        scope.launch {
            thermalMeasurementMutex.withLock {
                val km = KeyManager.getInstance()

                val modeError = CompletableDeferred<String?>()
                km.setValue(
                    thermalMeasureModeKey(),
                    ThermalTemperatureMeasureMode.SPOT,
                    object : CommonCallbacks.CompletionCallback {
                        override fun onSuccess() {
                            modeError.complete(null)
                        }

                        override fun onFailure(error: IDJIError) {
                            modeError.complete(error.description().orUnknownDjiError())
                        }
                    }
                )
                modeError.await()?.let { err ->
                    Log.e(TAG, "Set thermal measure mode SPOT fallito: $err")
                    onResult(false, err, null)
                    return@withLock
                }

                val pointError = CompletableDeferred<String?>()
                km.setValue(
                    thermalSpotPointKey(),
                    DoublePoint2D(nx, ny),
                    object : CommonCallbacks.CompletionCallback {
                        override fun onSuccess() {
                            pointError.complete(null)
                        }

                        override fun onFailure(error: IDJIError) {
                            pointError.complete(error.description().orUnknownDjiError())
                        }
                    }
                )
                pointError.await()?.let { err ->
                    Log.e(TAG, "Set thermal spot point fallito: $err")
                    onResult(false, err, null)
                    return@withLock
                }

                delay(25)
                val temperature = runCatching {
                    km.getValue(thermalSpotTemperatureKey()) as? Double
                }.getOrNull()
                if (temperature == null || temperature.isNaN()) {
                    onResult(false, "Temperatura spot non disponibile", null)
                } else {
                    onResult(true, null, ThermalSpotMeasurement(nx, ny, temperature))
                }
            }
        }
    }

    private fun applySavedThermalPalette() {
        val id = savedThermalPaletteId() ?: return
        val palette = runCatching { CameraThermalPalette.valueOf(id) }.getOrNull() ?: return
        if (palette == CameraThermalPalette.UNKNOWN) return
        KeyManager.getInstance().setValue(
            thermalPaletteKey(),
            palette,
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() {
                    Log.i(TAG, "Thermal palette salvata riapplicata: ${palette.name}")
                }
                override fun onFailure(error: IDJIError) {
                    Log.w(TAG, "Riapplica thermal palette fallita: ${error.description().orUnknownDjiError()}")
                }
            }
        )
    }

    @Suppress("DEPRECATION")
    private fun nv21ToBitmap(nv21: ByteArray, width: Int, height: Int): Bitmap? {
        return try {
            val rs = android.renderscript.RenderScript.create(context)
            val yuvType = android.renderscript.Type.Builder(rs, android.renderscript.Element.U8(rs))
                .setX(nv21.size).create()
            val inAlloc  = android.renderscript.Allocation.createTyped(rs, yuvType, android.renderscript.Allocation.USAGE_SCRIPT)
            val rgbaType = android.renderscript.Type.Builder(rs, android.renderscript.Element.RGBA_8888(rs))
                .setX(width).setY(height).create()
            val outAlloc = android.renderscript.Allocation.createTyped(rs, rgbaType)
            val script   = android.renderscript.ScriptIntrinsicYuvToRGB.create(rs, android.renderscript.Element.U8_4(rs))
            inAlloc.copyFrom(nv21)
            script.setInput(inAlloc)
            script.forEach(outAlloc)
            val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            outAlloc.copyTo(bmp)
            rs.destroy()
            bmp
        } catch (e: Exception) {
            Log.w(TAG, "NV21→Bitmap fallito: ${e.message}")
            null
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FLIGHT CONTROLS
    // ─────────────────────────────────────────────────────────────────────────

    override fun takeoff(onResult: (Boolean, String?) -> Unit) {
        KeyManager.getInstance().performAction(
            KeyTools.createKey(FlightControllerKey.KeyStartTakeoff),
            object : CommonCallbacks.CompletionCallbackWithParam<EmptyMsg> {
                override fun onSuccess(result: EmptyMsg?) {
                    Log.i(TAG, "Takeoff avviato ✅")
                    onResult(true, null)
                }
                override fun onFailure(error: IDJIError) {
                    val msg = "code=${error.errorCode()} " +
                            "desc=${error.description()} " +
                            "hint=${error.toString()}"
                    Log.e(TAG, "Takeoff fallito: $msg")
                    onResult(false, msg)
                }
            }
        )
    }


    override fun land(onResult: (Boolean, String?) -> Unit) {
        armLandingCompletionMonitor()
        KeyManager.getInstance().performAction(
            KeyTools.createKey(FlightControllerKey.KeyStartAutoLanding),
            object : CommonCallbacks.CompletionCallbackWithParam<EmptyMsg> {
                override fun onSuccess(result: EmptyMsg?) {
                    Log.i(TAG, "Landing avviato")
                    onResult(true, null)
                }
                override fun onFailure(error: IDJIError) {
                    Log.e(TAG, "Landing fallito: ${error.description()}")
                    landingCompletionMonitorArmed = false
                    onResult(false, error.description())
                }
            }
        )
    }
    private fun armLandingCompletionMonitor() {
        if (landingCompletionMonitorArmed) return
        landingCompletionMonitorArmed = true
        val km = KeyManager.getInstance()
        km.cancelListen(KeyTools.createKey(FlightControllerKey.KeyIsFlying), this)
        km.listen(KeyTools.createKey(FlightControllerKey.KeyIsFlying), this) { _, isFlying ->
            if (landingCompletionMonitorArmed && isFlying == false) {
                landingCompletionMonitorArmed = false
                km.cancelListen(KeyTools.createKey(FlightControllerKey.KeyIsFlying), this)
                scope.launch {
                    kotlinx.coroutines.delay(1500) // aspetta che SDK finisca il reset
                    Log.i(TAG, "Atterrato - ri-applico camera=${operatorCamera.name} zoom=${currentZoom}x")
                    switchOperatorCamera(operatorCamera)
                    if (currentZoom > 1f) setZoomLevel(currentZoom)
                }
            }
        }
    }

    override fun returnHome(onResult: (Boolean, String?) -> Unit) {
        KeyManager.getInstance().performAction(
            KeyTools.createKey(FlightControllerKey.KeyStartGoHome),
            object : CommonCallbacks.CompletionCallbackWithParam<EmptyMsg> {
                override fun onSuccess(result: EmptyMsg?) {
                    Log.i(TAG, "Go Home avviato")
                    onResult(true, null)
                }
                override fun onFailure(error: IDJIError) {
                    Log.e(TAG, "Go Home fallito: ${error.description()}")
                    onResult(false, error.description())
                }
            }
        )
    }
    override fun confirmLanding(onResult: (Boolean, String?) -> Unit) {
        val needed = KeyManager.getInstance().getValue(
            KeyTools.createKey(FlightControllerKey.KeyIsLandingConfirmationNeeded)
        ) as? Boolean
        if (needed != true) {
            onResult(false, "Landing confirmation non richiesta")
            return
        }

        KeyManager.getInstance().performAction(
            KeyTools.createKey(FlightControllerKey.KeyConfirmLanding),
            object : CommonCallbacks.CompletionCallbackWithParam<EmptyMsg> {
                override fun onSuccess(r: EmptyMsg?) {
                    Log.i(TAG, "Landing confermato")
                    lastLandingConfirmationNeeded = false
                    scope.launch { safeSend(DroneEvent.LandingConfirmationNeeded(needed = false)) }
                    onResult(true, null)
                }
                override fun onFailure(e: IDJIError) {
                    Log.e(TAG, "Confirm landing fallito: ${e.description()}")
                    onResult(false, e.description())
                }
            }
        )
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HOME POINT
    // ─────────────────────────────────────────────────────────────────────────

    override fun setHomePoint(lat: Double, lon: Double, onResult: (Boolean, String?) -> Unit) {
        val location = LocationCoordinate2D(lat, lon)
        KeyManager.getInstance().setValue(
            KeyTools.createKey(FlightControllerKey.KeyHomeLocation),
            location,
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() {
                    Log.i(TAG, "Home point impostato: $lat, $lon")
                    onResult(true, null)
                }
                override fun onFailure(error: IDJIError) {
                    Log.e(TAG, "Set home point fallito: ${error.description()}")
                    onResult(false, error.description())
                }
            }
        )
    }

    override fun getHomePoint(onResult: (Double?, Double?) -> Unit) {
        try {
            val location = KeyManager.getInstance()
                .getValue(KeyTools.createKey(FlightControllerKey.KeyHomeLocation)) as? LocationCoordinate2D
            onResult(location?.latitude, location?.longitude)
        } catch (e: Exception) {
            Log.w(TAG, "getHomePoint fallito: ${e.message}")
            onResult(null, null)
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CAMERA — FOTO / REGISTRAZIONE
    // ─────────────────────────────────────────────────────────────────────────

    override fun takePhoto(zoomRatio: Float, onResult: (Boolean, String?) -> Unit) {
        if (isRecordingVideo) {
            Log.w(TAG, "takePhoto bloccato: registrazione video attiva")
            onResult(false, "Foto disabilitate durante registrazione video")
            return
        }
        val restoreZoom = currentZoom
        setPhotoMode { modeOk, modeErr ->
            if (!modeOk) {
                restoreVideoAfterPhoto {
                    if (restoreZoom > 1f) setZoomLevel(restoreZoom)
                    onResult(false, "Set photo mode fallito: $modeErr")
                }
                return@setPhotoMode
            }
            capturePhotoSequence(DroneCamera.entries.toList(), zoomRatio, restoreZoom, onResult)
        }
    }

    private fun capturePhotoSequence(
        cameras: List<DroneCamera>,
        zoomRatio: Float,
        restoreZoom: Float,
        onResult: (Boolean, String?) -> Unit
    ) {
        if (cameras.isEmpty()) {
            restoreVideoAfterPhoto {
                if (restoreZoom > 1f) setZoomLevel(restoreZoom)
                onResult(true, null)
            }
            return
        }

        val camera = cameras.first()
        Log.i(TAG, "PHOTO STEP start lens=${camera.name} remaining=${cameras.size}")
        applyOperatorCameraSource(camera) { switchOk, switchErr ->
            if (!switchOk) {
                restoreVideoAfterPhoto {
                    if (restoreZoom > 1f) setZoomLevel(restoreZoom)
                    onResult(false, "Switch camera ${camera.name} fallito: $switchErr")
                }
                return@applyOperatorCameraSource
            }

            scope.launch {
                val settleDelay = when (camera) {
                    DroneCamera.IR -> 900L
                    DroneCamera.ZOOM -> 450L
                    else -> 300L
                }
                if (camera == DroneCamera.ZOOM) {
                    Log.i(TAG, "Foto ZOOM: imposto zoom ${zoomRatio}x prima dello scatto")
                    setZoomLevel(zoomRatio)
                }
                delay(settleDelay)
                logCurrentVideoSource("before_shoot_${camera.name}")
                Log.i(TAG, "Shoot key lens=${camera.lensType.name} component=${camera.photoComponentIndex.name}")
                KeyManager.getInstance().performAction(
                    KeyTools.createCameraKey(CameraKey.KeyStartShootPhoto, camera.photoComponentIndex, camera.lensType),
                    object : CommonCallbacks.CompletionCallbackWithParam<EmptyMsg> {
                        override fun onSuccess(result: EmptyMsg?) {
                            Log.i(TAG, "Foto ${camera.name} scattata")
                            scope.launch {
                                delay(450)
                                capturePhotoSequence(cameras.drop(1), zoomRatio, restoreZoom, onResult)
                            }
                        }

                        override fun onFailure(error: IDJIError) {
                            val desc = error.description().orUnknownDjiError()
                            Log.e(TAG, "Foto ${camera.name} fallita: $desc")
                            restoreVideoAfterPhoto {
                                if (restoreZoom > 1f) setZoomLevel(restoreZoom)
                                onResult(false, "${camera.name}: $desc")
                            }
                        }
                    }
                )
            }
        }
    }

    private fun logCurrentVideoSource(stage: String) {
        runCatching {
            val source = KeyManager.getInstance().getValue(
                KeyTools.createKey(CameraKey.KeyCameraVideoStreamSource, ComponentIndexType.LEFT_OR_MAIN)
            ) as? CameraVideoStreamSourceType
            Log.i(TAG, "Video source [$stage] = ${source?.name ?: "null"}")
        }.onFailure {
            Log.w(TAG, "Video source [$stage] read fallito: ${it.message}")
        }
    }

    private fun restoreVideoAfterPhoto(onDone: () -> Unit) {
        setVideoMode { _, _ ->
            operatorCamera = DroneCamera.WIDE
            applyOperatorCameraSource(DroneCamera.WIDE)
            onDone()
        }
    }

    private fun setPhotoMode(onResult: (Boolean, String?) -> Unit) {
        KeyManager.getInstance().setValue(
            KeyTools.createKey(CameraKey.KeyCameraMode, ComponentIndexType.LEFT_OR_MAIN),
            CameraMode.PHOTO_NORMAL,
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() {
                    scope.launch {
                        delay(250)
                        onResult(true, null)
                    }
                }
                override fun onFailure(error: IDJIError) {
                    val desc = error.description().orUnknownDjiError()
                    Log.e(TAG, "Set photo mode fallito: $desc")
                    if (desc == "unknown DJI error") {
                        Log.w(TAG, "Continuo comunque con lo scatto: camera mode ha restituito errore nullo")
                        onResult(true, null)
                    } else {
                        onResult(false, desc)
                    }
                }
            }
        )
    }

    private fun setVideoMode(onResult: (Boolean, String?) -> Unit) {
        KeyManager.getInstance().setValue(
            KeyTools.createKey(CameraKey.KeyCameraMode, ComponentIndexType.LEFT_OR_MAIN),
            CameraMode.VIDEO_NORMAL,
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() {
                    scope.launch {
                        delay(250)
                        onResult(true, null)
                    }
                }
                override fun onFailure(error: IDJIError) {
                    val desc = error.description().orUnknownDjiError()
                    Log.w(TAG, "Set video mode fallito: $desc")
                    onResult(false, desc)
                }
            }
        )
    }

    private fun String?.orUnknownDjiError(): String {
        val value = this?.trim()
        return if (value.isNullOrEmpty() || value.equals("null", ignoreCase = true)) "unknown DJI error" else value
    }

    override fun startRecording(onResult: (Boolean, String?) -> Unit) {
        setVideoMode { _, _ ->
            KeyManager.getInstance().performAction(
                KeyTools.createKey(CameraKey.KeyStartRecord),
                object : CommonCallbacks.CompletionCallbackWithParam<EmptyMsg> {
                    override fun onSuccess(result: EmptyMsg?) {
                        Log.i(TAG, "Registrazione avviata")
                        isRecordingVideo = true
                        onResult(true, null)
                    }

                    override fun onFailure(error: IDJIError) {
                        val desc = error.description().orUnknownDjiError()
                        Log.e(TAG, "Start recording fallito: $desc")
                        onResult(false, desc)
                    }
                }
            )
        }
    }

    override fun stopRecording(onResult: (Boolean, String?) -> Unit) {
        setVideoMode { _, _ ->
            KeyManager.getInstance().performAction(
                KeyTools.createKey(CameraKey.KeyStopRecord),
                object : CommonCallbacks.CompletionCallbackWithParam<EmptyMsg> {
                    override fun onSuccess(result: EmptyMsg?) {
                        Log.i(TAG, "Registrazione fermata")
                        isRecordingVideo = false
                        onResult(true, null)
                    }

                    override fun onFailure(error: IDJIError) {
                        val desc = error.description().orUnknownDjiError()
                        Log.e(TAG, "Stop recording fallito: $desc")
                        onResult(false, desc)
                    }
                }
            )
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ZOOM
    // ─────────────────────────────────────────────────────────────────────────

    override fun setZoomLevel(ratio: Float) {
        currentZoom = ratio
        KeyManager.getInstance().setValue(
            KeyTools.createKey(CameraKey.KeyCameraZoomRatios),
            ratio.toDouble(),
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() { Log.i(TAG, "Zoom impostato a ${ratio}x") }
                override fun onFailure(e: IDJIError) { Log.e(TAG, "Zoom fallito: ${e.description()}") }
            }
        )
    }

    override fun setThermalZoom(ratio: Float) {
        val zoomFactor = when {
            ratio <= 1f  -> ThermalDigitalZoomFactor.FACTOR_X1
            ratio <= 2f  -> ThermalDigitalZoomFactor.FACTOR_X2
            ratio <= 4f  -> ThermalDigitalZoomFactor.FACTOR_X4
            ratio <= 8f  -> ThermalDigitalZoomFactor.FACTOR_X8
            ratio <= 16f -> ThermalDigitalZoomFactor.FACTOR_X16
            ratio <= 32f -> ThermalDigitalZoomFactor.FACTOR_X32
            else         -> ThermalDigitalZoomFactor.FACTOR_X64
        }
        KeyManager.getInstance().setValue(
            KeyTools.createKey(CameraKey.KeyThermalDigitalZoomFactor),
            zoomFactor,
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() { Log.i(TAG, "Thermal zoom: ${zoomFactor.name}") }
                override fun onFailure(e: IDJIError) { Log.e(TAG, "Thermal zoom fallito: ${e.description()}") }
            }
        )
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MISSIONI WAYPOINT — delega a WaypointMissionHelper
    // ─────────────────────────────────────────────────────────────────────────

    override fun rotateGimbalBySpeed(
        pitchSpeed: Double,
        yawSpeed: Double,
        rollSpeed: Double,
        onResult: (Boolean, String?) -> Unit
    ) {
        Log.i(TAG, "Gimbal speed request pitch=$pitchSpeed yaw=$yawSpeed roll=$rollSpeed")
        reclaimManualGimbalControl("gimbal_speed")
        val speedRotation = GimbalSpeedRotation().apply {
            setPitch(pitchSpeed)
            setYaw(yawSpeed)
            setRoll(rollSpeed)
        }
        KeyManager.getInstance().performAction(
            KeyTools.createKey(GimbalKey.KeyRotateBySpeed, ComponentIndexType.LEFT_OR_MAIN),
            speedRotation,
            object : CommonCallbacks.CompletionCallbackWithParam<EmptyMsg> {
                override fun onSuccess(result: EmptyMsg?) {
                    Log.i(TAG, "Gimbal speed ok")
                    onResult(true, null)
                }
                override fun onFailure(error: IDJIError) {
                    Log.e(TAG, "Gimbal speed fallito: ${error.description()}")
                    onResult(false, error.description())
                }
            }
        )
    }

    override fun rotateGimbalByAngle(
        pitch: Double?,
        yaw: Double?,
        roll: Double?,
        relative: Boolean,
        duration: Double,
        onResult: (Boolean, String?) -> Unit
    ) {
        Log.i(TAG, "Gimbal angle request pitch=$pitch yaw=$yaw roll=$roll relative=$relative duration=$duration")
        reclaimManualGimbalControl("gimbal_angle")
        val angleRotation = GimbalAngleRotation().apply {
            setMode(if (relative) GimbalAngleRotationMode.RELATIVE_ANGLE else GimbalAngleRotationMode.ABSOLUTE_ANGLE)
            pitch?.let { setPitch(it) }
            yaw?.let { setYaw(it) }
            roll?.let { setRoll(it) }
            setDuration(duration)
        }
        KeyManager.getInstance().performAction(
            KeyTools.createKey(GimbalKey.KeyRotateByAngle, ComponentIndexType.LEFT_OR_MAIN),
            angleRotation,
            object : CommonCallbacks.CompletionCallbackWithParam<EmptyMsg> {
                override fun onSuccess(result: EmptyMsg?) {
                    Log.i(TAG, "Gimbal angle ok")
                    onResult(true, null)
                }
                override fun onFailure(error: IDJIError) {
                    Log.e(TAG, "Gimbal angle fallito: ${error.description()}")
                    onResult(false, error.description())
                }
            }
        )
    }

    private fun reclaimManualGimbalControl(reason: String) {
        KeyManager.getInstance().setValue(
            KeyTools.createKey(GimbalKey.KeyGimbalMode, ComponentIndexType.LEFT_OR_MAIN),
            GimbalMode.FREE,
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() {
                    Log.i(TAG, "Gimbal manual mode FREE ok ($reason)")
                }

                override fun onFailure(error: IDJIError) {
                    Log.w(TAG, "Gimbal manual mode FREE fallito ($reason): ${error.description()}")
                }
            }
        )
    }

    override fun resetGimbal(
        resetType: String,
        onResult: (Boolean, String?) -> Unit
    ) {
        val type = runCatching { GimbalResetType.valueOf(resetType.uppercase()) }
            .getOrDefault(GimbalResetType.PITCH_YAW)
        Log.i(TAG, "Gimbal reset request type=$type")
        KeyManager.getInstance().performAction(
            KeyTools.createKey(GimbalKey.KeyGimbalReset, ComponentIndexType.LEFT_OR_MAIN),
            type,
            object : CommonCallbacks.CompletionCallbackWithParam<EmptyMsg> {
                override fun onSuccess(result: EmptyMsg?) {
                    Log.i(TAG, "Gimbal reset ok")
                    onResult(true, null)
                }
                override fun onFailure(error: IDJIError) {
                    Log.e(TAG, "Gimbal reset fallito: ${error.description()}")
                    onResult(false, error.description())
                }
            }
        )
    }

    override fun uploadAndStartMission(
        waypoints:      List<WaypointData>,
        autoSpeed:      Float,
        maxSpeed:       Float,
        finishedAction: WaypointMissionFinishedAction,
        onResult:       (Boolean, String?) -> Unit
    ) {
        missionHelper.uploadAndStartMission(
            waypoints      = waypoints,
            autoSpeed      = autoSpeed,
            maxSpeed       = maxSpeed,
            finishedAction = finishedAction
        ) { success, error ->
            if (success) {
                // currentMissionName aggiornato da WaypointMissionHelper internamente
                Log.i(TAG, "Missione avviata con successo")
            }
            onResult(success, error)
        }
    }

    override fun pauseMission(onResult: (Boolean, String?) -> Unit) {
        missionHelper.pauseMission(onResult)
    }

    override fun resumeMission(onResult: (Boolean, String?) -> Unit) {
        missionHelper.resumeMission(onResult)
    }

    // stopMission non prende missionName dall'esterno:
    // usiamo currentMissionName tracciato internamente.
    // Se è null (nessuna missione attiva) restituiamo errore.
    override fun stopMission(onResult: (Boolean, String?) -> Unit) {
        val name = missionHelper.currentMissionName
        if (name == null) {
            Log.w(TAG, "stopMission: nessuna missione attiva")
            onResult(false, "Nessuna missione attiva")
            return
        }
        missionHelper.stopMission(name, onResult)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    private fun getProductName(): String {
        return try {
            val productType = KeyManager.getInstance()
                .getValue(KeyTools.createKey(ProductKey.KeyProductType)) as? ProductType
            productType?.name ?: "DJI Drone"
        } catch (e: Exception) { "DJI Drone" }
    }

    override fun getBatteryPercentage(): String {
        return try {
            KeyManager.getInstance()
                .getValue(KeyTools.createKey(BatteryKey.KeyChargeRemainingInPercent, ComponentIndexType.LEFT_OR_MAIN))
                ?.toString() ?: "-1"
        } catch (e: Exception) { "-1" }
    }
    override fun armMotors(onResult: (Boolean, String?) -> Unit) {
        val motorsOn = KeyManager.getInstance()
            .getValue(KeyTools.createKey(FlightControllerKey.KeyAreMotorsOn)) as? Boolean
        Log.i(TAG, "Stato motori prima di armare: $motorsOn")

        KeyManager.getInstance().performAction(
            KeyTools.createKey(FlightControllerKey.KeyTurnOnTheMotor),
            object : CommonCallbacks.CompletionCallbackWithParam<EmptyMsg> {
                override fun onSuccess(result: EmptyMsg?) {
                    Log.i(TAG, "Motori armati ✅")
                    onResult(true, null)
                }
                override fun onFailure(error: IDJIError) {
                    val msg = "code=${error.errorCode()} innerCode=${error.toString()}"
                    Log.e(TAG, "Arm motori fallito: $msg")
                    onResult(false, msg)
                }
            }
        )
    }
    override fun setRTHAltitude(altitudeMeters: Int, onResult: (Boolean, String?) -> Unit) {
        KeyManager.getInstance().setValue(
            KeyTools.createKey(FlightControllerKey.KeyGoHomeHeight),
            altitudeMeters,
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() {
                    Log.i(TAG, "RTH altitude → ${altitudeMeters}m")
                    onResult(true, null)
                }
                override fun onFailure(error: IDJIError) {
                    Log.e(TAG, "RTH altitude fallita: ${error.description()}")
                    onResult(false, error.description())
                }
            }
        )
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RELEASE
    // ─────────────────────────────────────────────────────────────────────────

    override fun release() {
        Log.i(TAG, "DroneManager released")
        stopVideoStreams()
        missionHelper.removeListeners()
        missionListenersRegistered = false
        removeLandingStateListeners()
        _connectionState.value = DroneConnectionState.Idle
        KeyManager.getInstance().cancelListen(this)
        scope.cancel()
        eventChannel.close()
        scope        = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        eventChannel = Channel(
            capacity = EVENT_CHANNEL_CAPACITY,
            onBufferOverflow = BufferOverflow.DROP_OLDEST
        )
        SDKManager.getInstance().destroy()
    }
    override fun attachCameraSurface(
        surface: Surface,
        width: Int,
        height: Int,
        onResult: (Boolean, String?) -> Unit
    ) {
        if (!isDroneConnected) {
            Log.w(TAG, "attachCameraSurface: drone non connesso")
            onResult(false, "Drone non connesso")
            return
        }

        if (width <= 0 || height <= 0) {
            onResult(false, "Surface size non valida")
            return
        }

        try {
            setVideoMode { _, _ ->
                try {
                    applyOperatorCameraSource(operatorCamera) { _, _ ->
                        MediaDataCenter.getInstance()
                            .cameraStreamManager
                            .putCameraStreamSurface(
                                ComponentIndexType.LEFT_OR_MAIN,
                                surface,
                                width,
                                height,
                                ICameraStreamManager.ScaleType.CENTER_CROP
                            )

                        Log.i(TAG, "Surface DJI collegata ${width}x$height camera=${operatorCamera.name}")
                        onResult(true, null)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "attachCameraSurface fallito interno: ${e.message}")
                    onResult(false, e.message)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "attachCameraSurface fallito: ${e.message}")
            onResult(false, e.message)
        }
    }

    override fun detachCameraSurface(surface: Surface?) {
        surface ?: return

        try {
            MediaDataCenter.getInstance()
                .cameraStreamManager
                .removeCameraStreamSurface(surface)

            Log.i(TAG, "Surface DJI rimossa")
        } catch (e: Exception) {
            Log.w(TAG, "detachCameraSurface fallito: ${e.message}")
        }
    }
}

