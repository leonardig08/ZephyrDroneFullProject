package itiscuneo.zephyrdroneandroidserver

import android.util.Log
import dji.sdk.keyvalue.key.FlightControllerKey
import dji.sdk.keyvalue.key.KeyTools
import dji.sdk.keyvalue.value.common.LocationCoordinate2D
import dji.v5.common.callback.CommonCallbacks
import dji.v5.common.error.IDJIError
import dji.v5.manager.KeyManager
import dji.v5.manager.aircraft.simulator.InitializationSettings
import dji.v5.manager.aircraft.simulator.SimulatorManager
import dji.v5.manager.areacode.AreaCodeManager

class SimulatorHelper {

    private val simulatorManager = SimulatorManager.getInstance()

    fun isEnabled(): Boolean {
        return simulatorManager.isSimulatorEnabled
    }

    fun enable(
        lat: Double = 44.37833333333333,
        lon: Double = 7.527,
        satelliteCount: Int = 10,
        areaCode: String = "IT",
        onResult: (Boolean, String?) -> Unit = { _, _ -> }
    ) {
        if (isEnabled()) {
            Log.i("SimulatorHelper", "Simulatore già attivo")
            onResult(true, null)
            return
        }

        // 1. Imposta area code prima di tutto
        val areaError = AreaCodeManager.getInstance().updateAreaCode(areaCode)
        if (areaError != null) {
            Log.w("SimulatorHelper", "Area code warning: $areaError")
        } else {
            Log.i("SimulatorHelper", "Area code impostato: $areaCode ✅")
        }

        // 2. Aspetta un momento poi attiva simulatore
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            val location = LocationCoordinate2D(lat, lon)
            val settings = InitializationSettings.createInstance(location, satelliteCount)
            simulatorManager.enableSimulator(
                settings,
                object : CommonCallbacks.CompletionCallback {
                    override fun onSuccess() {
                        Log.i("SimulatorHelper", "Simulatore attivato ✅")

                        // 3. Imposta home point uguale alla posizione simulatore
                        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                            val homeLocation = LocationCoordinate2D(lat, lon)
                            KeyManager.getInstance().setValue(
                                KeyTools.createKey(FlightControllerKey.KeyHomeLocation),
                                homeLocation,
                                object : CommonCallbacks.CompletionCallback {
                                    override fun onSuccess() {
                                        Log.i("SimulatorHelper", "Home point impostata ✅")
                                        onResult(true, null)
                                    }
                                    override fun onFailure(error: IDJIError) {
                                        Log.w("SimulatorHelper", "Home point fallita: ${error.errorCode()} - procedo comunque")
                                        onResult(true, null)
                                    }
                                }
                            )
                        }, 2000)
                    }
                    override fun onFailure(error: IDJIError) {
                        Log.e("SimulatorHelper", "Errore attivazione: code=${error.errorCode()} desc=${error.description()}")
                        onResult(false, error.errorCode())
                    }
                }
            )
        }, 500)
    }

    fun disable(onResult: (Boolean, String?) -> Unit = { _, _ -> }) {
        if (!isEnabled()) {
            Log.i("SimulatorHelper", "Simulatore già disattivo")
            onResult(true, null)
            return
        }

        simulatorManager.disableSimulator(
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() {
                    Log.i("SimulatorHelper", "Simulatore disattivato ✅")
                    onResult(true, null)
                }
                override fun onFailure(error: IDJIError) {
                    Log.e("SimulatorHelper", "Errore disattivazione: ${error.errorCode()}")
                    onResult(false, error.errorCode())
                }
            }
        )
    }
}