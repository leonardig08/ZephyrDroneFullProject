package itiscuneo.zephyrdroneandroidserver

import android.content.Context
import androidx.multidex.MultiDex
import androidx.multidex.MultiDexApplication
import com.cySdkyc.clx.Helper

class App : MultiDexApplication() {
    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(base)
        MultiDex.install(this)
        Helper.install(this)  // ← questo era il pezzo mancante
    }
}