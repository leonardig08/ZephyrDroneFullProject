package itiscuneo.zephyrdroneandroidserver

import android.content.Context
import android.util.Log
import com.dji.wpmzsdk.common.data.Template
import com.dji.wpmzsdk.manager.WPMZManager
import dji.sdk.wpmz.value.mission.*
import dji.v5.common.callback.CommonCallbacks
import dji.v5.common.error.IDJIError
import dji.v5.manager.aircraft.waypoint3.WaypointMissionManager
import dji.v5.manager.aircraft.waypoint3.WaylineExecutingInfoListener
import dji.v5.manager.aircraft.waypoint3.WaypointActionListener
import dji.v5.manager.aircraft.waypoint3.model.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.File

private const val TAG = "WaypointMissionHelper"

class WaypointMissionHelper(private val context: Context, private val scope: CoroutineScope) {

    private val missionManager get() = WaypointMissionManager.getInstance()
    private val wpmzManager    get() = WPMZManager.getInstance()
    private val photoLensSequence = listOf(CameraLensType.WIDE, CameraLensType.ZOOM, CameraLensType.IR)


    private fun normalizedMissionHoverSeconds(wp: WaypointData): Float {
        val requested = wp.hoverSeconds.coerceAtLeast(0f)
        if (wp.action != WaypointAction.TAKE_PHOTO_EXPERIMENTAL) return requested
        val intervalSeconds = wp.photoIntervalSeconds.coerceAtLeast(0f)
        val count = wp.photoCount.coerceAtLeast(1)
        val sequenceSeconds = (count - 1).coerceAtLeast(0) * intervalSeconds
        return maxOf(requested, wp.photoTotalSeconds.coerceAtLeast(0f), sequenceSeconds)
    }

    // Esposto a DroneManager per poter chiamare stopMission con il nome corretto
    var currentMissionName: String? = null
        private set

    fun clearCurrentMission() {
        currentMissionName = null
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UPLOAD + START
    // ─────────────────────────────────────────────────────────────────────────

    fun uploadAndStartMission(
        waypoints:      List<WaypointData>,
        autoSpeed:      Float,
        maxSpeed:       Float,
        finishedAction: WaypointMissionFinishedAction,
        onResult:       (Boolean, String?) -> Unit
    ) {
        scope.launch(Dispatchers.IO) {
            try {
                val kmzFile = buildKMZ(waypoints, autoSpeed, maxSpeed, finishedAction)
                pushAndStart(kmzFile, onResult)
            } catch (e: Exception) {
                Log.e(TAG, "Errore buildKMZ: ${e.message}")
                onResult(false, e.message)
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // BUILD KMZ
    // ─────────────────────────────────────────────────────────────────────────

    private fun buildKMZ(
        waypoints:      List<WaypointData>,
        autoSpeed:      Float,
        maxSpeed:       Float,
        finishedAction: WaypointMissionFinishedAction
    ): File {

        // ── WaylineMission (metadati autore/tempo) ────────────────────────────
        // NOTA: WaylineMission NON contiene droneInfo/payloadInfo/name,
        //       quelli vanno in WaylineMissionConfig
        val waylineMission = WaylineMission().apply {
            author     = "ZephyrDrone"
            createTime = System.currentTimeMillis().toDouble()
            updateTime = System.currentTimeMillis().toDouble()
        }

        // ── MissionConfig globale ─────────────────────────────────────────────
        val missionConfig = WaylineMissionConfig().apply {
            securityTakeOffHeight   = 20.0
            globalTransitionalSpeed = autoSpeed.toDouble()
            flyToWaylineMode        = WaylineFlyToWaylineMode.SAFELY
            finishAction = when (finishedAction) {
                WaypointMissionFinishedAction.GO_HOME                  -> WaylineFinishedAction.GO_HOME
                WaypointMissionFinishedAction.LAND                     -> WaylineFinishedAction.AUTO_LAND
                WaypointMissionFinishedAction.HOVER                    -> WaylineFinishedAction.NO_ACTION
                WaypointMissionFinishedAction.RETURN_TO_FIRST_WAYPOINT -> WaylineFinishedAction.GOTO_FIRST_WAYPOINT
            }
            exitOnRCLostBehavior = WaylineExitOnRCLostBehavior.EXCUTE_RC_LOST_ACTION
            exitOnRCLostType     = WaylineExitOnRCLostAction.GO_BACK

            // droneInfo e payloadInfo appartengono a MissionConfig, NON a WaylineMission
            droneInfo = WaylineDroneInfo(WaylineDroneType.WM265, 0)  // Mavic 3 Enterprise
            payloadInfo = listOf(
                WaylinePayloadInfo().apply {
                    payloadType          = WaylinePayloadType.WM265M
                    payloadSubType       = 0
                    payloadPositionIndex = 0
                }
            )
        }

        // ── Wayline (il percorso vero) ────────────────────────────────────────
        val wayline = Wayline().apply {
            autoFlightSpeed = autoSpeed.toDouble()
            mode            = WaylineExecuteAltitudeMode.RELATIVE_TO_START_POINT
        }

        // ── Lista waypoint (usa WaylineExecuteWaypoint, non WaylineWaypoint) ──
        waypoints.forEachIndexed { index, wp ->
            val djiWp = WaylineExecuteWaypoint().apply {
                waypointIndex   = index
                location        = WaylineLocationCoordinate2D(wp.lat, wp.lon)
                executeHeight   = wp.altitude.toDouble()
                speed           = autoSpeed.toDouble()
                useStraightLine = true
                turnParam = WaylineWaypointTurnParam().apply {
                    turnMode            = WaylineWaypointTurnMode.TO_POINT_AND_STOP_WITH_DISCONTINUITY_CURVATURE
                    turnDampingDistance = 0.0
                }

                // ROI — sovrascrive gimbalHeadingParam se presente
                if (wp.roiLat != null && wp.roiLon != null) {
                    gimbalHeadingParam = WaylineWaypointGimbalHeadingParam().apply {
                        headingMode   = WaylineWaypointGimbalHeadingMode.TOWARD_POI

                    }
                } else {
                    val missionPitch = if (wp.action == WaypointAction.TAKE_PHOTO_EXPERIMENTAL) {
                        wp.gimbalPitch ?: -90f
                    } else {
                        -90f
                    }
                    gimbalHeadingParam = WaylineWaypointGimbalHeadingParam().apply {
                        headingMode = WaylineWaypointGimbalHeadingMode.FOLLOW_WAYLINE
                        pitchAngle  = missionPitch.toDouble()
                    }
                }
            }
            wayline.waypoints.add(djiWp)
        }

        // ── ActionGroup per waypoint con azione ───────────────────────────────
        // WaylineActionGroup usa: groupId, startIndex, endIndex, trigger, actions
        waypoints.forEachIndexed { index, wp ->
            val actions = mutableListOf<WaylineActionInfo>()

            val hoverSeconds = normalizedMissionHoverSeconds(wp)
            if (wp.action == WaypointAction.TAKE_PHOTO_EXPERIMENTAL) {
                actions.add(buildExperimentalGimbalPitchAction(wp, index))
                Log.i(
                    TAG,
                    "EXP photo wp=$index pitch=${(wp.gimbalPitch ?: -90f).coerceIn(-90f, 30f)} " +
                        "hover=$hoverSeconds count=${wp.photoCount.coerceAtLeast(1)} " +
                        "interval=${wp.photoIntervalSeconds.coerceAtLeast(0f)} total=${wp.photoTotalSeconds.coerceAtLeast(0f)}"
                )
            }
            if (hoverSeconds > 0f) {
                actions.add(WaylineActionInfo().apply {
                    actionId = index * 1000 + 2
                    actionType = WaylineActionType.HOVER // verifica nome esatto
                    aircraftHoverParam = ActionAircraftHoverParam().apply {
                        hoverTime = hoverSeconds.toDouble()
                    }
                })
            }

            buildActions(wp, index)?.let { actions.addAll(it) }

            if (actions.isEmpty()) return@forEachIndexed
            actions.forEachIndexed { actionIndex, action ->
                action.actionId = actionIndex
            }

            val actionGroup = WaylineActionGroup().apply {
                groupId    = index
                startIndex = index
                endIndex   = index
                trigger    = WaylineActionTrigger().apply {
                    triggerType = WaylineActionTriggerType.REACH_POINT
                }
                nodeLists = buildSequentialActionNodes(actions.size)
                this.actions = actions
            }
            wayline.actionGroups.add(actionGroup)
        }

        // ── Output file ───────────────────────────────────────────────────────
        val outputDir  = File(context.cacheDir, "missions").also { it.mkdirs() }
        val outputFile = File(outputDir, "mission_${System.currentTimeMillis()}.kmz")

        // generateKMZFile accetta Wayline (non Template) come ultimo parametro
        wpmzManager.generateKMZFile(
            outputFile.absolutePath,
            waylineMission,
            missionConfig,
            wayline
        )

        Log.i(TAG, "KMZ generato: ${outputFile.absolutePath} (${outputFile.length()} bytes)")
        return outputFile
    }

    private fun buildActions(wp: WaypointData, waypointIndex: Int): List<WaylineActionInfo>? {
        return when (wp.action) {
            WaypointAction.TAKE_PHOTO -> photoLensSequence.mapIndexed { lensIndex, lens ->
                WaylineActionInfo().apply {
                    actionId = waypointIndex * 10 + lensIndex
                    actionType = WaylineActionType.TAKE_PHOTO
                    takePhotoParam = ActionTakePhotoParam().apply {
                        payloadPositionIndex = 0
                        useGlobalPayloadLensIndex = false
                        payloadLensIndex = listOf(lens)
                        fileSuffix = lens.name.lowercase()
                    }
                }
            }
            WaypointAction.TAKE_PHOTO_EXPERIMENTAL -> {
                val photoCount = wp.photoCount.coerceAtLeast(1)
                val intervalSeconds = wp.photoIntervalSeconds.coerceAtLeast(0f)
                val actions = mutableListOf<WaylineActionInfo>()

                repeat(photoCount) { shotIndex ->
                    photoLensSequence.forEachIndexed { lensIndex, lens ->
                        actions.add(WaylineActionInfo().apply {
                            actionId = waypointIndex * 1000 + 100 + shotIndex * 10 + lensIndex
                            actionType = WaylineActionType.TAKE_PHOTO
                            takePhotoParam = ActionTakePhotoParam().apply {
                                payloadPositionIndex = 0
                                useGlobalPayloadLensIndex = false
                                payloadLensIndex = listOf(lens)
                                fileSuffix = "${lens.name.lowercase()}_${shotIndex + 1}"
                            }
                        })
                    }
                    if (shotIndex < photoCount - 1 && intervalSeconds > 0f) {
                        actions.add(WaylineActionInfo().apply {
                            actionId = waypointIndex * 1000 + 100 + shotIndex * 10 + 9
                            actionType = WaylineActionType.HOVER
                            aircraftHoverParam = ActionAircraftHoverParam().apply {
                                hoverTime = intervalSeconds.toDouble()
                            }
                        })
                    }
                }
                actions
            }
            WaypointAction.RECORD_START -> listOf(
                WaylineActionInfo().apply {
                    actionId = waypointIndex * 10
                    actionType = WaylineActionType.START_RECORD
                }
            )
            WaypointAction.RECORD_STOP -> listOf(
                WaylineActionInfo().apply {
                    actionId = waypointIndex * 10
                    actionType = WaylineActionType.STOP_RECORD
                }
            )
            WaypointAction.NONE -> null
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUSH KMZ + START
    // ─────────────────────────────────────────────────────────────────────────

    private fun buildExperimentalGimbalPitchAction(
        wp: WaypointData,
        waypointIndex: Int
    ): WaylineActionInfo {
        val pitch = (wp.gimbalPitch ?: -90f).coerceIn(-90f, 30f)
        return WaylineActionInfo().apply {
            actionId = waypointIndex * 1000 + 1
            actionType = WaylineActionType.GIMBAL_ROTATE
            gimbalRotateParam = ActionGimbalRotateParam().apply {
                payloadPositionIndex = 0
                rotateMode = WaylineGimbalActuatorRotateMode.ABSOLUTE_ANGLE
                enablePitch = true
                this.pitch = pitch.toDouble()
                enableRoll = false
                roll = 0.0
                enableYaw = false
                yaw = 0.0
                enableRotateTime = true
                rotateTime = 1.5
            }
        }
    }

    private fun buildSequentialActionNodes(actionCount: Int): List<WaylineActionNodeList> {
        if (actionCount <= 0) return emptyList()
        val nodes = mutableListOf<WaylineActionTreeNode>()
        nodes.add(WaylineActionTreeNode().apply {
            nodeType = WaylineActionsRelationType.SEQUENCE
            childrenNum = actionCount
            actionIndex = 0
        })
        repeat(actionCount) { actionIndex ->
            nodes.add(WaylineActionTreeNode().apply {
                nodeType = WaylineActionsRelationType.LEAF
                childrenNum = 0
                this.actionIndex = actionIndex
            })
        }
        return listOf(WaylineActionNodeList().apply {
            this.nodes = nodes
        })
    }

    private fun pushAndStart(kmzFile: File, onResult: (Boolean, String?) -> Unit) {
        val missionName = kmzFile.nameWithoutExtension

        missionManager.pushKMZFileToAircraft(
            kmzFile.absolutePath,
            object : CommonCallbacks.CompletionCallbackWithProgress<Double> {
                override fun onProgressUpdate(progress: Double) {
                    Log.d(TAG, "Upload KMZ: ${(progress * 100).toInt()}%")
                }
                override fun onSuccess() {
                    Log.i(TAG, "KMZ inviato, avvio missione...")
                    val waylineIds = missionManager.getAvailableWaylineIDs(kmzFile.absolutePath)
                    missionManager.startMission(
                        missionName,
                        waylineIds,
                        object : CommonCallbacks.CompletionCallback {
                            override fun onSuccess() {
                                Log.i(TAG, "Missione avviata ✅")
                                currentMissionName = missionName
                                onResult(true, null)
                            }
                            override fun onFailure(e: IDJIError) {
                                Log.e(TAG, "Start fallito: ${e.description()}")
                                onResult(false, e.description())
                            }
                        }
                    )
                }
                override fun onFailure(e: IDJIError) {
                    Log.e(TAG, "Push KMZ fallito: ${e.description()}")
                    onResult(false, e.description())
                }
            }
        )
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PAUSA / RIPRESA / STOP
    // ─────────────────────────────────────────────────────────────────────────

    fun pauseMission(onResult: (Boolean, String?) -> Unit) {
        missionManager.pauseMission(object : CommonCallbacks.CompletionCallback {
            override fun onSuccess()             { Log.i(TAG, "Pausa"); onResult(true, null) }
            override fun onFailure(e: IDJIError) { onResult(false, e.description()) }
        })
    }

    fun resumeMission(onResult: (Boolean, String?) -> Unit) {
        missionManager.resumeMission(object : CommonCallbacks.CompletionCallback {
            override fun onSuccess()             { Log.i(TAG, "Ripresa"); onResult(true, null) }
            override fun onFailure(e: IDJIError) { onResult(false, e.description()) }
        })
    }

    fun stopMission(missionName: String, onResult: (Boolean, String?) -> Unit) {
        missionManager.stopMission(
            missionName,
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess()             { Log.i(TAG, "Stop"); currentMissionName = null; onResult(true, null) }
                override fun onFailure(e: IDJIError) { onResult(false, e.description()) }
            }
        )
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LISTENER
    // ─────────────────────────────────────────────────────────────────────────

    fun addExecutionListeners(
        onStateChanged: (WaypointMissionExecuteState) -> Unit,
        onWaylineInfo:  (WaylineExecutingInfo) -> Unit
    ) {
        missionManager.addWaypointMissionExecuteStateListener { state ->
            Log.d(TAG, "Mission state: $state")
            onStateChanged(state)
        }

        missionManager.addWaylineExecutingInfoListener(object : WaylineExecutingInfoListener {
            override fun onWaylineExecutingInfoUpdate(info: WaylineExecutingInfo) {
                Log.d(TAG, "Wayline: wp=${info.currentWaypointIndex} mission=${info.missionFileName}")
                onWaylineInfo(info)
            }
            override fun onWaylineExecutingInterruptReasonUpdate(error: IDJIError?) {
                Log.w(TAG, "Interrupt: ${error?.description()}")
            }
        })

        missionManager.addWaypointActionListener(object : WaypointActionListener {
            // Metodi @Deprecated richiesti dall'interfaccia (singolo actionId)
            @Deprecated("Deprecated in Java")
            override fun onExecutionStart(actionId: Int) {
                Log.d(TAG, "Action start (legacy): id=$actionId")
            }
            @Deprecated("Deprecated in Java")
            override fun onExecutionFinish(actionId: Int, error: IDJIError?) {
                Log.d(TAG, "Action finish (legacy): id=$actionId err=${error?.description()}")
            }
            // Metodi attuali (actionGroup + actionId)
            override fun onExecutionStart(actionGroup: Int, actionId: Int) {
                Log.d(TAG, "Action start: group=$actionGroup id=$actionId")
            }
            override fun onExecutionFinish(actionGroup: Int, actionId: Int, error: IDJIError?) {
                Log.d(TAG, "Action finish: group=$actionGroup id=$actionId err=${error?.description()}")
            }
        })
    }

    fun removeListeners() {
        missionManager.clearAllWaypointMissionExecuteStateListener()
        missionManager.clearAllWaylineExecutingInfoListener()
        missionManager.clearAllWaypointActionListener()
    }
}
