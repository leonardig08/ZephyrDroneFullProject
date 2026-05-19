package itiscuneo.zephyrdroneandroidserver

import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import android.os.Bundle
import androidx.activity.compose.BackHandler
import androidx.compose.ui.zIndex
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import android.content.res.Configuration
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.IntSize
import itiscuneo.zephyrdroneandroidserver.ui.theme.ZephyrDroneAndroidServerTheme
import kotlin.math.sin
import kotlin.math.cos
import kotlin.math.sqrt
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.WindowInsetsCompat
import androidx.fragment.app.FragmentActivity
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Collections
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.ui.text.input.KeyboardType
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.ViewGroup
import androidx.compose.ui.viewinterop.AndroidView

import android.view.TextureView
import android.graphics.SurfaceTexture
import kotlinx.coroutines.launch

// ── Palette ───────────────────────────────────────────────────────────────────
private val BgColor      = Color(0xFF020704)
private val BgCard       = Color(0xFF06130A)
private val BgCardLight  = Color(0xFF092014)
private val AccentCyan   = Color(0xFF52F77A)
private val AccentBlue   = Color(0xFFA7FF6A)
private val AccentGreen  = Color(0xFF52F77A)
private val AccentRed    = Color(0xFFFF4A6B)
private val AccentYellow = Color(0xFFFFD166)

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = android.graphics.Color.TRANSPARENT
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
        }
        setContent {
            ZephyrDroneAndroidServerTheme {
                MainScreen()
            }
        }
    }
}

// ── Animated dot grid background ──────────────────────────────────────────────
@Composable
fun AnimatedBackground() {
    val infiniteTransition = rememberInfiniteTransition(label = "bg")
    val pulse by infiniteTransition.animateFloat(
        initialValue  = 0f,
        targetValue   = 2f * Math.PI.toFloat(),
        animationSpec = infiniteRepeatable(
            animation  = tween(8000, easing = LinearEasing),
            repeatMode = RepeatMode.Restart
        ),
        label = "pulse"
    )
    Canvas(modifier = Modifier.fillMaxSize()) {
        val cols = (size.width / 40).toInt() + 1
        val rows = (size.height / 40).toInt() + 1
        for (row in 0..rows) {
            for (col in 0..cols) {
                val x    = col * 40f
                val y    = row * 40f
                val dist = (x - size.width / 2) * (x - size.width / 2) +
                        (y - size.height / 2) * (y - size.height / 2)
                val wave = sin(pulse + dist / 80000f) * 0.5f + 0.5f
                drawCircle(
                    color  = AccentCyan.copy(alpha = 0.035f + wave * 0.04f),
                    radius = 1.5f,
                    center = Offset(x, y)
                )
            }
        }
    }
}

// ── Radar ring animation ──────────────────────────────────────────────────────
@Composable
fun RadarRings(isRunning: Boolean, modifier: Modifier = Modifier) {
    val infiniteTransition = rememberInfiniteTransition(label = "orb")
    val rotation by infiniteTransition.animateFloat(
        initialValue  = 0f, targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(6000, easing = LinearEasing), RepeatMode.Restart),
        label = "rot"
    )
    val rotation2 by infiniteTransition.animateFloat(
        initialValue  = 360f, targetValue = 0f,
        animationSpec = infiniteRepeatable(tween(9000, easing = LinearEasing), RepeatMode.Restart),
        label = "rot2"
    )
    val pulse by infiniteTransition.animateFloat(
        initialValue  = 0.85f, targetValue = 1.15f,
        animationSpec = infiniteRepeatable(tween(1800, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "pulse"
    )
    val rayAlpha by infiniteTransition.animateFloat(
        initialValue  = 0.0f, targetValue = 1.0f,
        animationSpec = infiniteRepeatable(tween(2400, easing = LinearEasing), RepeatMode.Restart),
        label = "ray"
    )

    val orbColor  = if (isRunning) AccentGreen else AccentCyan
    val orbColor2 = if (isRunning) AccentCyan  else AccentBlue

    Canvas(modifier = modifier) {
        val cx   = size.width  / 2f
        val cy   = size.height / 2f
        val maxR = minOf(cx, cy)
        val orbR = maxR * 0.38f * pulse

        drawCircle(
            brush  = Brush.radialGradient(
                colors = listOf(orbColor.copy(alpha = 0.18f), Color.Transparent),
                center = Offset(cx, cy), radius = maxR * 0.95f
            ),
            radius = maxR * 0.95f, center = Offset(cx, cy)
        )

        val rayCount = 8
        for (i in 0 until rayCount) {
            val baseAngle = rotation + i * (360f / rayCount)
            val angleRad  = Math.toRadians(baseAngle.toDouble())
            val startR    = orbR * 1.1f
            val progress  = ((rayAlpha + i.toFloat() / rayCount) % 1f)
            val endR      = startR + (maxR - startR) * progress
            val alpha     = (1f - progress) * 0.35f
            val startOff  = Offset(cx + startR * cos(angleRad).toFloat(), cy + startR * sin(angleRad).toFloat())
            val endOff    = Offset(cx + endR   * cos(angleRad).toFloat(), cy + endR   * sin(angleRad).toFloat())
            drawLine(
                brush       = Brush.linearGradient(colors = listOf(orbColor.copy(alpha = alpha), Color.Transparent), start = startOff, end = endOff),
                start       = startOff, end = endOff,
                strokeWidth = 1.8f, cap = StrokeCap.Round
            )
        }

        val orbitR1 = maxR * 0.72f
        for (i in 0 until 120) {
            val a = Math.toRadians((rotation + i * 3.0))
            drawCircle(color = orbColor.copy(alpha = (i / 120f) * 0.55f), radius = 1.2f, center = Offset(cx + orbitR1 * cos(a).toFloat(), cy + orbitR1 * sin(a).toFloat()))
        }

        val orbitR2 = maxR * 0.55f
        for (i in 0 until 90) {
            val a = Math.toRadians((rotation2 + i * 4.0))
            drawCircle(color = orbColor2.copy(alpha = (i / 90f) * 0.4f), radius = 1.0f, center = Offset(cx + orbitR2 * cos(a).toFloat(), cy + orbitR2 * sin(a).toFloat()))
        }

        for (i in 0..2) {
            val a = Math.toRadians((rotation + i * 120.0))
            val x = cx + orbitR1 * cos(a).toFloat(); val y = cy + orbitR1 * sin(a).toFloat()
            drawCircle(color = orbColor.copy(alpha = 0.9f),  radius = 3.5f, center = Offset(x, y))
            drawCircle(color = orbColor.copy(alpha = 0.25f), radius = 7f,   center = Offset(x, y))
        }

        for (i in 0..1) {
            val a = Math.toRadians((rotation2 + i * 180.0))
            val x = cx + orbitR2 * cos(a).toFloat(); val y = cy + orbitR2 * sin(a).toFloat()
            drawCircle(color = orbColor2.copy(alpha = 0.8f), radius = 2.5f, center = Offset(x, y))
            drawCircle(color = orbColor2.copy(alpha = 0.2f), radius = 5f,   center = Offset(x, y))
        }

        drawCircle(
            brush  = Brush.radialGradient(colors = listOf(orbColor.copy(alpha = 0.55f), orbColor.copy(alpha = 0.15f), Color.Transparent), center = Offset(cx, cy), radius = orbR),
            radius = orbR, center = Offset(cx, cy)
        )
        drawCircle(
            brush  = Brush.radialGradient(colors = listOf(Color.White.copy(alpha = 0.6f), orbColor.copy(alpha = 0.3f), Color.Transparent), center = Offset(cx, cy), radius = orbR * 0.35f),
            radius = orbR * 0.35f, center = Offset(cx, cy)
        )
    }
}

// ── Main Screen ───────────────────────────────────────────────────────────────
@Composable
fun MainScreen() {

    var showDjiLive by remember { mutableStateOf(false) }
    var showInfo by remember { mutableStateOf(false) }
    var simulatorEnabled by remember { mutableStateOf(false) }

    val vm: ServerViewModel = viewModel()
    val appState   by vm.appState.collectAsStateWithLifecycle()
    val isRunning  = appState.phase == AppPhase.RUNNING
    val isStarting = appState.phase in listOf(
        AppPhase.INITIALIZING_SDK, AppPhase.WAITING_DRONE, AppPhase.SERVER_STARTING
    )
    val context = LocalContext.current
    val activity = context as AppCompatActivity

    val onToggle: () -> Unit = {
        if (isRunning || isStarting) vm.stopServer()
        else vm.startServer(activity)
    }

    val configuration = LocalConfiguration.current
    val isLandscape   = configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

    LaunchedEffect(isRunning) {
        if (!isRunning) showDjiLive = false
    }

    val statusColor by animateColorAsState(
        targetValue   = when {
            isRunning  -> AccentGreen
            isStarting -> Color(0xFFFFD04A)
            else       -> AccentRed
        },
        animationSpec = tween(600),
        label         = "statusColor"
    )
    val buttonScale by animateFloatAsState(
        targetValue   = if (isRunning) 1.5f else 1.4f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy),
        label         = "buttonScale"
    )

    Box(modifier = Modifier.fillMaxSize().background(BgColor)) {
        AnimatedBackground()

        Row(
            modifier              = Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 20.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment     = Alignment.CenterVertically
        ) {
            StatusBadge(isRunning = isRunning, isStarting = isStarting, statusColor = statusColor)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(20.dp))
                        .background(AccentCyan.copy(alpha = 0.08f))
                        .border(1.dp, AccentCyan.copy(alpha = 0.2f), RoundedCornerShape(20.dp))
                        .padding(horizontal = 10.dp, vertical = 4.dp)
                ) {
                    Text("v1.3", color = AccentCyan.copy(alpha = 0.6f), fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                }
                Spacer(Modifier.width(8.dp))
                IconButton(onClick = { showInfo = true }) {
                    Icon(Icons.Default.Info, contentDescription = "Info", tint = AccentCyan.copy(alpha = 0.8f))
                }


            }
        }

        if (isLandscape) {
            LandscapeLayout(
                appState = appState,
                isRunning = isRunning,
                isStarting = isStarting,
                buttonScale = buttonScale,
                onToggle = onToggle,
                onOpenDjiLive = { showDjiLive = true }
            )
        } else {
            PortraitLayout(
                appState = appState,
                isRunning = isRunning,
                isStarting = isStarting,
                buttonScale = buttonScale,
                onToggle = onToggle,
                onOpenDjiLive = { showDjiLive = true }
            )
        }
        if (showDjiLive) {
            DjiLiveFullscreenPanel(
                vm = vm,
                onClose = { showDjiLive = false }
            )
        }


        Text(
            text          = "ITISCUNEO  ·  Gli Astronauti del Kebab",
            color         = Color.White.copy(alpha = 0.15f),
            fontSize      = 9.sp,
            fontFamily    = FontFamily.Monospace,
            letterSpacing = 1.5.sp,
            modifier      = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 10.dp)
        )
    }

    if (showInfo) InfoDialog(
        onDismiss         = { showInfo = false },
        simulatorEnabled  = simulatorEnabled,
        onSimulatorToggle = { simulatorEnabled = it; vm.setSimulator(it) },
        serverIp          = vm.getServerIp(),
        onServerIpSave    = { vm.saveServerIp(it) },
        vm                = vm
    )
}

// ── Portrait layout ───────────────────────────────────────────────────────────
@Composable
fun PortraitLayout(
    appState: AppState,
    isRunning: Boolean,
    isStarting: Boolean,
    buttonScale: Float,
    onToggle: () -> Unit,
    onOpenDjiLive: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .padding(horizontal = 28.dp)
            .padding(top = 56.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        TitleBlock()
        Spacer(Modifier.height(36.dp))
        GlowDivider()
        Spacer(Modifier.height(36.dp))
        Box(contentAlignment = Alignment.Center, modifier = Modifier.size(220.dp)) {
            RadarRings(isRunning = isRunning, modifier = Modifier.fillMaxSize())
            StartStopButton(isRunning = isRunning, isStarting = isStarting, scale = buttonScale, onClick = onToggle, size = 160)
        }
        Spacer(Modifier.height(36.dp))
        TelemetryGrid(isRunning = isRunning, isStarting = isStarting, batteryPercent = appState.lastBatteryPercent)
        Spacer(Modifier.height(16.dp))
        StatusCard(appState = appState)
        Spacer(Modifier.height(14.dp))
        if (isRunning) {
            Button(
                onClick = onOpenDjiLive,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = AccentCyan.copy(alpha = 0.12f)
                ),
                border = androidx.compose.foundation.BorderStroke(
                    1.dp,
                    AccentCyan.copy(alpha = 0.4f)
                )
            ) {
                Text(
                    "APRI LIVE DJI",
                    color = AccentCyan,
                    fontFamily = FontFamily.Monospace,
                    letterSpacing = 2.sp,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold
                )
            }
        }


    }
}

// ── Landscape layout ──────────────────────────────────────────────────────────
@Composable
fun LandscapeLayout(appState: AppState, isRunning: Boolean, isStarting: Boolean, buttonScale: Float, onToggle: () -> Unit, onOpenDjiLive: () -> Unit) {
    Row(
        modifier              = Modifier.fillMaxSize().navigationBarsPadding().padding(horizontal = 36.dp, vertical = 8.dp).padding(top = 20.dp),
        verticalAlignment     = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(32.dp)
    ) {
        Column(modifier = Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Spacer(Modifier.height(15.dp))
            TitleBlock()
            Spacer(Modifier.height(20.dp))
            GlowDivider()
            Spacer(Modifier.height(20.dp))
            TelemetryGrid(isRunning = isRunning, isStarting = isStarting, batteryPercent = appState.lastBatteryPercent)
        }

        Box(contentAlignment = Alignment.Center, modifier = Modifier.size(200.dp)) {
            RadarRings(isRunning = isRunning, modifier = Modifier.fillMaxSize())
            StartStopButton(isRunning = isRunning, isStarting = isStarting, scale = buttonScale, onClick = onToggle, size = 140)
        }

        Column(modifier = Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Spacer(Modifier.height(20.dp))
            StatusCard(appState = appState)
            if (isRunning) {
                Button(
                    onClick = onOpenDjiLive,
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = AccentCyan.copy(alpha = 0.12f)
                    ),
                    border = androidx.compose.foundation.BorderStroke(
                        1.dp,
                        AccentCyan.copy(alpha = 0.4f)
                    )
                ) {
                    Text(
                        "APRI LIVE DJI",
                        color = AccentCyan,
                        fontFamily = FontFamily.Monospace,
                        letterSpacing = 2.sp,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }

        }


    }
}

// ── Components ────────────────────────────────────────────────────────────────

@Composable
fun TitleBlock() {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(Brush.verticalGradient(listOf(AccentCyan.copy(alpha = 0.07f), Color.Transparent)))
            .padding(horizontal = 16.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("ZEPHYR",       color = AccentCyan,                     fontSize = 42.sp, fontWeight = FontWeight.Black, fontFamily = FontFamily.Monospace, letterSpacing = 5.sp, softWrap = false, maxLines = 1)
            Text("DRONE",        color = Color.White.copy(alpha = 0.8f), fontSize = 15.sp, fontWeight = FontWeight.Light, fontFamily = FontFamily.Monospace, letterSpacing = 8.sp)
            Spacer(Modifier.height(2.dp))
            Text("◆  SERVER  ◆", color = AccentBlue.copy(alpha = 0.5f),  fontSize = 9.sp,  fontFamily = FontFamily.Monospace, letterSpacing = 4.sp)
        }
    }
}

@Composable
fun GlowDivider() {
    Box(modifier = Modifier.fillMaxWidth(0.6f).height(1.dp).background(Brush.horizontalGradient(listOf(Color.Transparent, AccentCyan.copy(alpha = 0.7f), Color.Transparent))))
    Spacer(Modifier.height(2.dp))
    Box(modifier = Modifier.fillMaxWidth(0.3f).height(1.dp).background(Brush.horizontalGradient(listOf(Color.Transparent, AccentCyan.copy(alpha = 0.25f), Color.Transparent))))
}

@Composable
fun TelemetryGrid(isRunning: Boolean, isStarting: Boolean, batteryPercent: Int?) {
    val infiniteTransition = rememberInfiniteTransition(label = "tele")
    val blink by infiniteTransition.animateFloat(
        initialValue  = 0.4f, targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(900, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "blink"
    )
    Row(modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Max), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        TelemetryChip(
            label    = "SIGNAL",
            value    = if (isRunning) "STRONG" else "NONE",
            color    = if (isRunning) AccentGreen else AccentRed,
            blink    = if (isRunning) 1f else blink,
            modifier = Modifier.weight(1f).fillMaxHeight()
        )
        TelemetryChip(
            label    = "MODE",
            value    = when { isRunning -> "LIVE"; isStarting -> "START"; else -> "IDLE" },
            color    = if (isRunning) AccentCyan else AccentBlue.copy(alpha = 0.7f),
            blink    = 1f,
            modifier = Modifier.weight(1f).fillMaxHeight()
        )
        BatteryChip(batteryPercent = batteryPercent, modifier = Modifier.weight(1f).fillMaxHeight())
    }
}

@Composable
fun TelemetryChip(label: String, value: String, color: Color, blink: Float, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .background(color.copy(alpha = 0.07f))
            .border(1.dp, color.copy(alpha = 0.25f * blink), RoundedCornerShape(8.dp))
            .padding(vertical = 10.dp, horizontal = 6.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center, modifier = Modifier.fillMaxHeight()) {
            Text(label, color = color.copy(alpha = 0.5f), fontSize = 8.sp,  fontFamily = FontFamily.Monospace, letterSpacing = 1.sp)
            Spacer(Modifier.height(6.dp))
            Text(value, color = color.copy(alpha = blink), fontSize = 11.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
        }
    }
}

@Composable
fun BatteryChip(batteryPercent: Int?, modifier: Modifier = Modifier) {
    val infiniteTransition = rememberInfiniteTransition(label = "bat")
    val glow by infiniteTransition.animateFloat(
        initialValue  = 0.5f, targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1200, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "batglow"
    )

    val batteryLevel = batteryPercent ?: 0
    val hasData      = batteryPercent != null
    val batColor = when {
        !hasData          -> AccentBlue.copy(alpha = 0.5f)
        batteryLevel > 50 -> AccentGreen
        batteryLevel > 20 -> AccentYellow
        else              -> AccentRed
    }

    Box(
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .background(batColor.copy(alpha = 0.07f))
            .border(1.dp, batColor.copy(alpha = 0.25f), RoundedCornerShape(8.dp))
            .padding(vertical = 10.dp, horizontal = 6.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center, modifier = Modifier.fillMaxHeight()) {
            Text("BATTERY", color = batColor.copy(alpha = 0.5f), fontSize = 8.sp, fontFamily = FontFamily.Monospace, letterSpacing = 1.sp)
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .width(28.dp).height(13.dp)
                        .clip(RoundedCornerShape(2.dp))
                        .border(1.dp, batColor.copy(alpha = 0.7f), RoundedCornerShape(2.dp))
                        .padding(2.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxHeight()
                            .fillMaxWidth(if (hasData) batteryLevel / 100f else 0f)
                            .clip(RoundedCornerShape(1.dp))
                            .background(Brush.horizontalGradient(listOf(batColor.copy(alpha = 0.9f), batColor.copy(alpha = 0.5f))))
                    )
                }
                Box(modifier = Modifier.width(3.dp).height(6.dp).clip(RoundedCornerShape(topEnd = 2.dp, bottomEnd = 2.dp)).background(batColor.copy(alpha = 0.7f)))
            }
            Spacer(Modifier.height(4.dp))
            Text(
                text       = if (hasData) "$batteryLevel%" else "---",
                color      = batColor.copy(alpha = glow),
                fontSize   = 11.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace
            )
        }
    }
}

@Composable
fun StartStopButton(isRunning: Boolean, isStarting: Boolean, scale: Float, onClick: () -> Unit, size: Int) {
    val btnColor = when {
        isRunning  -> AccentRed
        isStarting -> Color(0xFFFFD04A)
        else       -> AccentGreen
    }
    val btnBg = when {
        isStarting -> Color(0xFF6B7A99).copy(alpha = 0.18f)
        else       -> btnColor.copy(alpha = 0.1f)
    }
    val glowAlpha by rememberInfiniteTransition(label = "glow").animateFloat(
        initialValue  = 0.25f,
        targetValue   = if (isStarting) 0.9f else 0.7f,
        animationSpec = infiniteRepeatable(tween(900, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "glowA"
    )
    val spinProgress by rememberInfiniteTransition(label = "spin").animateFloat(
        initialValue  = 0f, targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1000, easing = LinearEasing), RepeatMode.Restart),
        label = "spinP"
    )

    Button(
        onClick   = { if (!isStarting) onClick() },
        modifier  = Modifier
            .size(size.dp).scale(scale)
            .border(
                width = 1.5.dp,
                brush = Brush.linearGradient(listOf(btnColor.copy(alpha = glowAlpha), btnColor.copy(alpha = 0.1f))),
                shape = CircleShape
            ),
        shape     = CircleShape,
        colors    = ButtonDefaults.buttonColors(containerColor = btnBg),
        elevation = ButtonDefaults.buttonElevation(0.dp)
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.size((size * 0.62f).dp)) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                when {
                    isStarting -> {
                        val lit = (spinProgress * 3).toInt()
                        Text(
                            text      = listOf("●","●","●").mapIndexed { i, d -> if (i == lit) d else "○" }.joinToString(" "),
                            color     = btnColor.copy(alpha = glowAlpha),
                            fontSize  = (size * 0.12f).sp,
                            textAlign = TextAlign.Center,
                            modifier  = Modifier.fillMaxWidth()
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text          = "STARTING",
                            color         = btnColor,
                            fontSize      = (size * 0.058f).sp,
                            fontWeight    = FontWeight.ExtraBold,
                            fontFamily    = FontFamily.Monospace,
                            letterSpacing = 1.5.sp,
                            textAlign     = TextAlign.Center,
                            modifier      = Modifier.fillMaxWidth()
                        )
                    }
                    else -> {
                        Spacer(Modifier.size(14.dp))
                        Text(if (isRunning) "■" else "▶", color = btnColor, fontSize = (size * 0.20f).sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
                        Text(
                            text          = if (isRunning) "STOP" else "START",
                            color         = btnColor, fontSize = (size * 0.09f).sp,
                            fontWeight    = FontWeight.ExtraBold, fontFamily = FontFamily.Monospace,
                            letterSpacing = 3.sp, textAlign = TextAlign.Center,
                            modifier      = Modifier.fillMaxWidth()
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun StatusCard(appState: AppState) {
    fun getLocalIpAddress(): String {
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces()
            for (intf in Collections.list(interfaces)) {
                for (addr in Collections.list(intf.inetAddresses)) {
                    if (!addr.isLoopbackAddress && addr is Inet4Address) {
                        return addr.hostAddress ?: "N/A"
                    }
                }
            }
        } catch (e: Exception) {
            return "N/A"
        }
        return "N/A"
    }
    val ip = remember { getLocalIpAddress() }
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(Brush.verticalGradient(listOf(BgCardLight, BgCard)))
            .border(1.dp, Brush.linearGradient(listOf(AccentCyan.copy(alpha = 0.25f), AccentBlue.copy(alpha = 0.1f))), RoundedCornerShape(16.dp))
            .padding(18.dp)
    ) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(modifier = Modifier.size(6.dp).clip(CircleShape).background(AccentCyan.copy(alpha = 0.5f)))
                Spacer(Modifier.width(8.dp))
                Text("SYSTEM STATUS", color = AccentCyan.copy(alpha = 0.6f), fontSize = 9.sp, fontFamily = FontFamily.Monospace, letterSpacing = 2.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.height(12.dp))
            Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(AccentCyan.copy(alpha = 0.08f)))
            Spacer(Modifier.height(12.dp))
            StatusRow("SERVER",  if (appState.phase == AppPhase.RUNNING) "HTTP :8081" else "OFFLINE", if (appState.phase == AppPhase.RUNNING) AccentGreen else AccentRed)
            Spacer(Modifier.height(10.dp))
            StatusRow("DRONE",   appState.droneProductName ?: "NOT CONNECTED",                        if (appState.droneProductName != null) AccentGreen else AccentRed)
            Spacer(Modifier.height(10.dp))
            StatusRow("NETWORK", ip,                                                       AccentBlue)
            Spacer(Modifier.height(10.dp))
            StatusRow("SDK",     "DJI v5.17.0",                                                       AccentCyan)
        }
    }
}

@Composable
fun StatusBadge(isRunning: Boolean, isStarting: Boolean, statusColor: Color) {
    val infiniteTransition = rememberInfiniteTransition(label = "badge")
    val dotAlpha by infiniteTransition.animateFloat(
        initialValue  = 0.3f, targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(if (isStarting) 500 else 800), RepeatMode.Reverse),
        label = "dot"
    )
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(20.dp))
            .background(statusColor.copy(alpha = 0.1f))
            .border(1.dp, statusColor.copy(alpha = 0.3f), RoundedCornerShape(20.dp))
            .padding(horizontal = 12.dp, vertical = 6.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(modifier = Modifier.size(7.dp).clip(CircleShape).background(statusColor.copy(alpha = if (isRunning) 1f else dotAlpha)))
            Spacer(Modifier.width(7.dp))
            Text(
                text          = when { isRunning -> "RUNNING"; isStarting -> "INITIALIZING"; else -> "STOPPED" },
                color         = statusColor,
                fontSize      = 10.sp,
                fontWeight    = FontWeight.ExtraBold,
                fontFamily    = FontFamily.Monospace,
                letterSpacing = 2.sp
            )
        }
    }
}

@Composable
fun StatusRow(label: String, value: String, valueColor: Color = Color.White.copy(alpha = 0.7f)) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = AccentCyan.copy(alpha = 0.45f), fontSize = 10.sp, fontFamily = FontFamily.Monospace, letterSpacing = 1.5.sp)
        Box(modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(valueColor.copy(alpha = 0.07f)).padding(horizontal = 6.dp, vertical = 2.dp)) {
            Text(value, color = valueColor, fontSize = 10.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold)
        }
    }
}

// ── Info dialog ───────────────────────────────────────────────────────────────

@Composable
fun InfoDialog(
    onDismiss: () -> Unit,
    simulatorEnabled: Boolean,
    onSimulatorToggle: (Boolean) -> Unit,
    serverIp: String,                        // ← aggiunto
    onServerIpSave: (String) -> Unit,
    vm: ServerViewModel
){
    Dialog(onDismissRequest = onDismiss) {
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(20.dp))
                .background(Brush.verticalGradient(listOf(BgCardLight, BgCard)))
                .border(1.dp, Brush.linearGradient(listOf(AccentCyan.copy(alpha = 0.4f), AccentBlue.copy(alpha = 0.15f))), RoundedCornerShape(20.dp))
                .padding(28.dp)
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.verticalScroll(rememberScrollState())) {
                Box(
                    modifier = Modifier
                        .size(200.dp)
                        .clip(RoundedCornerShape(100.dp))
                        .background(Brush.radialGradient(listOf(AccentCyan.copy(alpha = 0.15f), Color.Transparent)))
                        .border(1.dp, AccentCyan.copy(alpha = 0.3f), RoundedCornerShape(16.dp)),
                    contentAlignment = Alignment.Center
                ) {
                    androidx.compose.foundation.Image(
                        painter            = painterResource(id = R.drawable.logo),
                        contentDescription = "App Icon",
                        contentScale       = ContentScale.Crop,
                        modifier           = Modifier.size(200.dp).graphicsLayer(scaleX = 1.1f, scaleY = 1.1f)
                    )
                }
                Spacer(Modifier.height(16.dp))
                Text("ZEPHYR DRONE SERVER",     color = AccentCyan,                     fontSize = 13.sp, fontWeight = FontWeight.ExtraBold, fontFamily = FontFamily.Monospace, letterSpacing = 2.sp, textAlign = TextAlign.Center)
                Spacer(Modifier.height(3.dp))
                Text("Android Controller v2.5", color = Color.White.copy(alpha = 0.3f), fontSize = 10.sp, fontFamily = FontFamily.Monospace, textAlign = TextAlign.Center)
                Spacer(Modifier.height(20.dp))
                Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(Brush.horizontalGradient(listOf(Color.Transparent, AccentCyan.copy(alpha = 0.3f), Color.Transparent))))
                Spacer(Modifier.height(16.dp))

                InfoSection("PROGETTO") {
                    InfoItem("Nome",   "ZephyrDrone 2025/2026")
                    InfoItem("Team",   "Gli Astronauti del Kebab")
                    InfoItem("Autori", "G. Leonardi Rovetto\nCani Gabriel")
                }
                Spacer(Modifier.height(10.dp))
                InfoSection("STACK TECNICO") {
                    InfoItem("SDK DJI",  "Enterprise v5.17.0")
                    InfoItem("Server",   "Python HTTP/WebSocket")
                    InfoItem("UI",       "React Native")
                    InfoItem("Platform", "Android (arm64)")
                }
                Spacer(Modifier.height(20.dp))

                Spacer(Modifier.height(10.dp))
                InfoSection("IMPOSTAZIONI") {
                    ThermalPaletteSelector(vm = vm)

                    Spacer(Modifier.height(8.dp))
                    Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(AccentCyan.copy(alpha = 0.08f)))
                    Spacer(Modifier.height(8.dp))

                    // ── Simulatore ──────────────────────────────────────────────────────
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column {
                            Text(
                                "SIMULATORE DJI",
                                color = AccentCyan.copy(alpha = 0.45f),
                                fontSize = 10.sp,
                                fontFamily = FontFamily.Monospace
                            )
                            Text(
                                if (simulatorEnabled) "Drone fisico richiesto" else "Off",
                                color = Color.White.copy(alpha = 0.3f),
                                fontSize = 8.sp,
                                fontFamily = FontFamily.Monospace
                            )
                        }
                        Switch(
                            checked = simulatorEnabled,
                            onCheckedChange = onSimulatorToggle,
                            colors = SwitchDefaults.colors(
                                checkedThumbColor   = AccentCyan,
                                checkedTrackColor   = AccentCyan.copy(alpha = 0.3f),
                                uncheckedThumbColor = Color.White.copy(alpha = 0.4f),
                                uncheckedTrackColor = Color.White.copy(alpha = 0.1f)
                            )
                        )
                    }

                    // ── IP Server PC ─────────────────────────────────────────────────────
                    Spacer(Modifier.height(8.dp))
                    Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(AccentCyan.copy(alpha = 0.08f)))
                    Spacer(Modifier.height(8.dp))

                    var ipValue by remember { mutableStateOf(serverIp) }

                    Text(
                        "IP SERVER PC",
                        color = AccentCyan.copy(alpha = 0.45f),
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace
                    )
                    Spacer(Modifier.height(6.dp))
                    OutlinedTextField(
                        value         = ipValue,
                        onValueChange = { ipValue = it },
                        label         = { Text("es. 192.168.1.100", fontFamily = FontFamily.Monospace, fontSize = 9.sp) },
                        singleLine    = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                        colors        = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor   = AccentCyan,
                            unfocusedBorderColor = AccentCyan.copy(alpha = 0.3f),
                            focusedTextColor     = Color.White,
                            unfocusedTextColor   = Color.White.copy(alpha = 0.7f),
                            cursorColor          = AccentCyan,
                            focusedLabelColor    = AccentCyan.copy(alpha = 0.5f),
                            unfocusedLabelColor  = AccentCyan.copy(alpha = 0.3f)
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )
                    Spacer(Modifier.height(8.dp))
                    Button(
                        onClick  = { onServerIpSave(ipValue) },
                        modifier = Modifier.fillMaxWidth(),
                        shape    = RoundedCornerShape(8.dp),
                        colors   = ButtonDefaults.buttonColors(containerColor = AccentCyan.copy(alpha = 0.12f)),
                        border   = androidx.compose.foundation.BorderStroke(1.dp, AccentCyan.copy(alpha = 0.4f))
                    ) {
                        Text("SALVA IP", color = AccentCyan, fontFamily = FontFamily.Monospace, letterSpacing = 3.sp, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                    }
                }

                Button(
                    onClick  = onDismiss,
                    modifier = Modifier.fillMaxWidth(),
                    shape    = RoundedCornerShape(10.dp),
                    colors   = ButtonDefaults.buttonColors(containerColor = AccentCyan.copy(alpha = 0.12f)),
                    border   = androidx.compose.foundation.BorderStroke(1.dp, AccentCyan.copy(alpha = 0.4f))
                ) {
                    Text("CHIUDI", color = AccentCyan, fontFamily = FontFamily.Monospace, letterSpacing = 3.sp, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

@Composable
fun InfoSection(title: String, content: @Composable () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(title, color = AccentBlue.copy(alpha = 0.7f), fontSize = 8.sp, fontFamily = FontFamily.Monospace, letterSpacing = 2.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(10.dp))
                .background(Color.White.copy(alpha = 0.02f))
                .border(1.dp, AccentCyan.copy(alpha = 0.08f), RoundedCornerShape(10.dp))
                .padding(12.dp)
        ) {
            Column { content() }
        }
    }
}

@Composable
fun InfoItem(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
        Text(label, color = AccentCyan.copy(alpha = 0.45f), fontSize = 10.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(0.4f))
        Text(value, color = Color.White.copy(alpha = 0.75f), fontSize = 10.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(0.6f), textAlign = TextAlign.End)
    }
}

@Composable
fun ThermalPaletteSelector(vm: ServerViewModel) {
    var options by remember { mutableStateOf<List<ThermalPaletteOption>>(emptyList()) }
    var selectedId by remember { mutableStateOf<String?>(null) }
    var status by remember { mutableStateOf("Apri IR e carica le palette disponibili dal drone.") }
    val scope = rememberCoroutineScope()

    fun refreshPalettes() {
        val state = vm.getThermalPaletteState()
        options = state.options
        selectedId = state.current?.id ?: selectedId
        status = state.error ?: if (state.options.isEmpty()) {
            "Nessuna palette letta. Server/drone non pronto o camera non IR."
        } else {
            "Palette disponibili: ${state.options.size}"
        }
    }

    LaunchedEffect(Unit) {
        refreshPalettes()
    }

    Column(modifier = Modifier.fillMaxWidth()) {
        Text(
            "IR COLOR SCHEME",
            color = AccentCyan.copy(alpha = 0.45f),
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace
        )
        Spacer(Modifier.height(8.dp))
        Button(
            onClick = {
                status = "Passo a IR e leggo le palette..."
                vm.switchLiveCamera(DroneCamera.IR) { ok, error ->
                    scope.launch {
                        if (!ok) {
                            status = error ?: "Switch a IR fallito"
                            return@launch
                        }
                        kotlinx.coroutines.delay(350)
                        refreshPalettes()
                    }
                }
            },
            modifier = Modifier.fillMaxWidth().height(34.dp),
            shape = RoundedCornerShape(8.dp),
            colors = ButtonDefaults.buttonColors(containerColor = AccentCyan.copy(alpha = 0.10f)),
            border = androidx.compose.foundation.BorderStroke(1.dp, AccentCyan.copy(alpha = 0.35f)),
            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)
        ) {
            Text("CARICA PALETTE IR", color = AccentCyan, fontFamily = FontFamily.Monospace, letterSpacing = 2.sp, fontSize = 9.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.height(8.dp))
        if (options.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                options.chunked(2).forEach { rowItems ->
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                        rowItems.forEach { option ->
                            val selected = option.id == selectedId
                            Button(
                                onClick = {
                                    status = "Imposto ${option.label}..."
                                    vm.setThermalPalette(option.id) { ok, error ->
                                        scope.launch {
                                            if (ok) {
                                                selectedId = option.id
                                                status = "IR palette: ${option.label}"
                                            } else {
                                                status = error ?: "Cambio palette IR fallito"
                                            }
                                        }
                                    }
                                },
                                modifier = Modifier.weight(1f).height(34.dp),
                                shape = RoundedCornerShape(8.dp),
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = if (selected) AccentCyan.copy(alpha = 0.18f) else Color.White.copy(alpha = 0.025f),
                                    contentColor = if (selected) AccentCyan else Color.White.copy(alpha = 0.68f)
                                ),
                                border = androidx.compose.foundation.BorderStroke(
                                    1.dp,
                                    if (selected) AccentCyan.copy(alpha = 0.65f) else AccentCyan.copy(alpha = 0.16f)
                                ),
                                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)
                            ) {
                                Text(option.label, fontFamily = FontFamily.Monospace, fontSize = 8.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.6.sp, maxLines = 1, softWrap = false)
                            }
                        }
                        if (rowItems.size == 1) {
                            Spacer(modifier = Modifier.weight(1f))
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(6.dp))
        Text(status, color = Color.White.copy(alpha = 0.36f), fontSize = 8.sp, fontFamily = FontFamily.Monospace)
    }
}
@Composable
fun DjiLiveFullscreen(
    vm: ServerViewModel,
    onClose: () -> Unit
) {
    var currentSurface by remember { mutableStateOf<Surface?>(null) }
    var statusText by remember { mutableStateOf("Preparazione live DJI...") }

    DisposableEffect(Unit) {
        onDispose {
            vm.detachCameraSurface(currentSurface)
            currentSurface?.release()
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
    ) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { context ->
                TextureView(context).apply {
                    surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                        override fun onSurfaceTextureAvailable(
                            surfaceTexture: SurfaceTexture,
                            width: Int,
                            height: Int
                        ) {
                            val surface = Surface(surfaceTexture)
                            currentSurface = surface

                            vm.attachCameraSurface(surface, width, height) { ok, err ->
                                statusText = if (ok) "" else (err ?: "Live DJI non disponibile")
                            }
                        }

                        override fun onSurfaceTextureSizeChanged(
                            surfaceTexture: SurfaceTexture,
                            width: Int,
                            height: Int
                        ) {
                            val surface = currentSurface ?: Surface(surfaceTexture).also {
                                currentSurface = it
                            }

                            vm.attachCameraSurface(surface, width, height) { ok, err ->
                                statusText = if (ok) "" else (err ?: "Live DJI non disponibile")
                            }
                        }

                        override fun onSurfaceTextureDestroyed(surfaceTexture: SurfaceTexture): Boolean {
                            vm.detachCameraSurface(currentSurface)
                            currentSurface?.release()
                            currentSurface = null
                            return true
                        }

                        override fun onSurfaceTextureUpdated(surfaceTexture: SurfaceTexture) {}
                    }
                }
            }
        )

        Button(
            onClick = onClose,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .statusBarsPadding()
                .padding(16.dp),
            shape = CircleShape,
            colors = ButtonDefaults.buttonColors(
                containerColor = Color.Black.copy(alpha = 0.75f)
            ),
            border = androidx.compose.foundation.BorderStroke(
                1.dp,
                AccentCyan.copy(alpha = 0.7f)
            )
        ) {
            Text("✕", color = AccentCyan, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        }

        if (statusText.isNotBlank()) {
            Text(
                text = statusText,
                color = AccentCyan,
                fontSize = 13.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.align(Alignment.Center)
            )
        }
    }
}

@Composable
fun DjiLiveFullscreenPanel(
    vm: ServerViewModel,
    onClose: () -> Unit
) {
    var currentSurface by remember { mutableStateOf<Surface?>(null) }
    var statusText by remember { mutableStateOf("Preparazione live DJI...") }
    var selectedCamera by remember { mutableStateOf(DroneCamera.WIDE) }
    var zoomRatio by remember { mutableFloatStateOf(1f) }
    var zoomLensRatio by remember { mutableFloatStateOf(1f) }
    var gimbalVector by remember { mutableStateOf(Offset.Zero) }
    var gimbalSpeedScale by remember { mutableFloatStateOf(0.45f) }
    var thermalMeasureEnabled by remember { mutableStateOf(false) }
    var thermalSpot by remember { mutableStateOf<ThermalSpotUi?>(null) }
    var thermalTapRequestId by remember { mutableIntStateOf(0) }
    var thermalPollInFlight by remember { mutableStateOf(false) }
    var thermalTapInFlight by remember { mutableStateOf(false) }
    var liveFeedSize by remember { mutableStateOf(IntSize.Zero) }
    val zoomEnabled = selectedCamera == DroneCamera.ZOOM
    val zoomRange = 1f..56f

    FullscreenSystemBars(active = true)
    BackHandler(onBack = onClose)

    LaunchedEffect(gimbalVector, gimbalSpeedScale) {
        val pitchSpeed = -gimbalVector.y * (gimbalSpeedScale * 40f)
        val yawSpeed = gimbalVector.x * (gimbalSpeedScale * 40f)
        if (pitchSpeed == 0f && yawSpeed == 0f) {
            vm.setLiveGimbalSpeed(0.0, 0.0) { _, err -> if (err != null) statusText = err }
            return@LaunchedEffect
        }
        while (true) {
            vm.setLiveGimbalSpeed(pitchSpeed.toDouble(), yawSpeed.toDouble()) { _, err -> if (err != null) statusText = err }
            kotlinx.coroutines.delay(80L)
        }
    }

    LaunchedEffect(selectedCamera) {
        if (selectedCamera != DroneCamera.IR) {
            thermalMeasureEnabled = false
            thermalSpot = null
        }
    }

    LaunchedEffect(thermalMeasureEnabled, selectedCamera, thermalSpot?.normX, thermalSpot?.normY) {
        val spot = thermalSpot ?: return@LaunchedEffect
        if (!thermalMeasureEnabled || selectedCamera != DroneCamera.IR) return@LaunchedEffect
        while (true) {
            if (!thermalPollInFlight && !thermalTapInFlight) {
                thermalPollInFlight = true
                thermalSpot = thermalSpot?.let { current ->
                    if (current.temperature == null) current.copy(pending = true, error = null) else current
                }
                vm.measureThermalSpot(spot.normX, spot.normY) { ok, err, measurement ->
                    thermalPollInFlight = false
                    thermalSpot = thermalSpot?.let { current ->
                        if (current.normX == spot.normX && current.normY == spot.normY) {
                            current.copy(
                                temperature = measurement?.temperature,
                                pending = false,
                                error = if (ok) null else err ?: "Temperatura non disponibile"
                            )
                        } else {
                            current
                        }
                    }
                }
            }
            kotlinx.coroutines.delay(80L)
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            vm.detachCameraSurface(currentSurface)
            currentSurface?.release()
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
    ) {
        AndroidView(
            modifier = Modifier
                .fillMaxSize()
                .onSizeChanged { liveFeedSize = it },
            factory = { context ->
                TextureView(context).apply {
                    surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                        override fun onSurfaceTextureAvailable(surfaceTexture: SurfaceTexture, width: Int, height: Int) {
                            val surface = Surface(surfaceTexture)
                            currentSurface = surface
                            vm.attachCameraSurface(surface, width, height) { ok, err ->
                                statusText = if (ok) "" else (err ?: "Live DJI non disponibile")
                            }
                        }

                        override fun onSurfaceTextureSizeChanged(surfaceTexture: SurfaceTexture, width: Int, height: Int) {
                            val surface = currentSurface ?: Surface(surfaceTexture).also { currentSurface = it }
                            vm.attachCameraSurface(surface, width, height) { ok, err ->
                                statusText = if (ok) "" else (err ?: "Live DJI non disponibile")
                            }
                        }

                        override fun onSurfaceTextureDestroyed(surfaceTexture: SurfaceTexture): Boolean {
                            vm.detachCameraSurface(currentSurface)
                            currentSurface?.release()
                            currentSurface = null
                            return true
                        }

                        override fun onSurfaceTextureUpdated(surfaceTexture: SurfaceTexture) = Unit
                    }
                }
            }
        )

        if (selectedCamera == DroneCamera.IR && thermalMeasureEnabled) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .zIndex(0.5f)
                    .pointerInput(liveFeedSize) {
                        detectTapGestures { tap ->
                            if (liveFeedSize.width <= 0 || liveFeedSize.height <= 0) return@detectTapGestures
                            val nx = (tap.x / liveFeedSize.width).coerceIn(0f, 1f).toDouble()
                            val ny = (tap.y / liveFeedSize.height).coerceIn(0f, 1f).toDouble()
                            val requestId = ++thermalTapRequestId
                            thermalSpot = ThermalSpotUi(
                                normX = nx,
                                normY = ny,
                                viewX = tap.x,
                                viewY = tap.y,
                                pending = true
                            )
                            thermalTapInFlight = true
                            vm.measureThermalSpot(nx, ny) { ok, err, measurement ->
                                if (requestId != thermalTapRequestId) return@measureThermalSpot
                                thermalTapInFlight = false
                                thermalSpot = thermalSpot?.let { current ->
                                    if (current.normX == nx && current.normY == ny) {
                                        current.copy(
                                            temperature = measurement?.temperature,
                                            pending = false,
                                            error = if (ok) null else err ?: "Temperatura non disponibile"
                                        )
                                    } else {
                                        current
                                    }
                                }
                            }
                        }
                    }
            )
        }

        if (selectedCamera == DroneCamera.IR && thermalSpot != null) {
            ThermalSpotOverlay(
                spot = thermalSpot!!,
                modifier = Modifier
                    .fillMaxSize()
                    .zIndex(0.6f)
            )
        }

        if (statusText.isNotBlank()) {
            Text(
                text = statusText,
                color = AccentCyan,
                fontSize = 13.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.align(Alignment.Center)
            )
        }

        CloseLiveButton(
            modifier = Modifier
                .zIndex(2f)
                .align(Alignment.TopEnd)
                .padding(end = 12.dp, top = 12.dp),
            onClick = onClose
        )

        GimbalPrecisionPanel(
            modifier = Modifier
                .zIndex(1.5f)
                .align(Alignment.CenterEnd)
                .padding(end = 8.dp),
            vector = gimbalVector,
            speedScale = gimbalSpeedScale,
            onVectorChange = { gimbalVector = it },
            onSpeedScaleChange = { gimbalSpeedScale = it },
            onReset = {
                gimbalVector = Offset.Zero
                vm.setLiveGimbalSpeed(0.0, 0.0) { _, _ -> }
                vm.resetLiveGimbal { _, err -> if (err != null) statusText = err }
            }
        )

        Column(
            modifier = Modifier
                .zIndex(1.5f)
                .align(Alignment.BottomCenter)
                .fillMaxWidth(0.6f)
                .background(Color.Black.copy(alpha = 0.62f))
                .clip(RoundedCornerShape(14.dp))
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                LiveCameraChip(
                    label = "WIDE",
                    selected = selectedCamera == DroneCamera.WIDE,
                    onClick = {
                        vm.switchLiveCamera(DroneCamera.WIDE) { ok, err ->
                            statusText = if (ok) {
                                selectedCamera = DroneCamera.WIDE
                                zoomRatio = 1f
                                ""
                            } else err ?: "Cambio camera non riuscito"
                        }
                    },
                    modifier = Modifier.weight(1f)
                )
                LiveCameraChip(
                    label = "ZOOM",
                    selected = selectedCamera == DroneCamera.ZOOM,
                    onClick = {
                        vm.switchLiveCamera(DroneCamera.ZOOM) { ok, err ->
                            statusText = if (ok) {
                                val restoredZoom = zoomLensRatio.coerceIn(1f, 56f)
                                selectedCamera = DroneCamera.ZOOM
                                zoomRatio = restoredZoom
                                vm.setLiveZoom(DroneCamera.ZOOM, restoredZoom)
                                ""
                            } else err ?: "Cambio camera non riuscito"
                        }
                    },
                    modifier = Modifier.weight(1f)
                )
                LiveCameraChip(
                    label = "IR",
                    selected = selectedCamera == DroneCamera.IR,
                    onClick = {
                        vm.switchLiveCamera(DroneCamera.IR) { ok, err ->
                            statusText = if (ok) {
                                selectedCamera = DroneCamera.IR
                                ""
                            } else err ?: "Cambio camera non riuscito"
                        }
                    },
                    modifier = Modifier.weight(1f)
                )
            }

            if (zoomEnabled) {
                Column {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "ZOOM",
                        color = AccentCyan.copy(alpha = 0.72f),
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace
                    )
                    Text(
                        text = "${zoomRatio.toInt()}x",
                        color = Color.White.copy(alpha = 0.92f),
                        fontSize = 9.sp,
                        fontFamily = FontFamily.Monospace
                    )
                }
                Slider(
                    value = zoomRatio,
                    onValueChange = { value ->
                        val snapped = value.coerceIn(zoomRange.start, zoomRange.endInclusive)
                        zoomRatio = snapped
                        if (zoomEnabled) {
                            if (selectedCamera == DroneCamera.ZOOM) {
                                zoomLensRatio = snapped
                            }
                            vm.setLiveZoom(selectedCamera, snapped)
                        }
                    },
                    valueRange = zoomRange,
                    enabled = zoomEnabled,
                    steps = 54,
                    modifier = Modifier.height(18.dp),
                    colors = SliderDefaults.colors(
                        thumbColor = AccentCyan,
                        activeTrackColor = AccentCyan,
                        inactiveTrackColor = Color.White.copy(alpha = 0.22f)
                    )
                )
            }
            } else if (selectedCamera == DroneCamera.IR) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Checkbox(
                        checked = thermalMeasureEnabled,
                        onCheckedChange = {
                            thermalMeasureEnabled = it
                            thermalSpot = null
                        },
                        colors = CheckboxDefaults.colors(
                            checkedColor = AccentYellow,
                            uncheckedColor = AccentCyan.copy(alpha = 0.65f),
                            checkmarkColor = Color.Black
                        )
                    )
                    Text(
                        text = "MISURA TEMPERATURA SPOT",
                        color = Color.White.copy(alpha = 0.92f),
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        text = if (thermalMeasureEnabled) "Tocca il feed" else "OFF",
                        color = AccentCyan.copy(alpha = 0.74f),
                        fontSize = 9.sp,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.weight(1f),
                        textAlign = TextAlign.End
                    )
                }
            }
        }
    }
}

private data class ThermalSpotUi(
    val normX: Double,
    val normY: Double,
    val viewX: Float,
    val viewY: Float,
    val temperature: Double? = null,
    val pending: Boolean = false,
    val error: String? = null
)

@Composable
private fun ThermalSpotOverlay(
    spot: ThermalSpotUi,
    modifier: Modifier = Modifier
) {
    Box(modifier = modifier) {
        Box(
            modifier = Modifier
                .offset(
                    x = (spot.viewX / LocalContext.current.resources.displayMetrics.density - 8f).dp,
                    y = (spot.viewY / LocalContext.current.resources.displayMetrics.density - 8f).dp
                )
                .size(16.dp)
                .border(2.dp, AccentYellow, RoundedCornerShape(2.dp))
                .background(AccentYellow.copy(alpha = 0.12f))
        )
        Box(
            modifier = Modifier
                .offset(
                    x = (spot.viewX / LocalContext.current.resources.displayMetrics.density + 14f).dp,
                    y = (spot.viewY / LocalContext.current.resources.displayMetrics.density - 18f).dp
                )
                .clip(RoundedCornerShape(8.dp))
                .background(Color.Black.copy(alpha = 0.74f))
                .border(1.dp, AccentYellow.copy(alpha = 0.65f), RoundedCornerShape(8.dp))
                .padding(horizontal = 8.dp, vertical = 5.dp)
        ) {
            Text(
                text = when {
                    spot.pending && spot.temperature == null -> "..."
                    spot.error != null -> spot.error
                    spot.temperature != null -> String.format("%.1f C", spot.temperature)
                    else -> "..."
                },
                color = AccentYellow,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 1
            )
        }
    }
}

@Composable
private fun FullscreenSystemBars(active: Boolean) {
    val context = LocalContext.current
    val view = LocalView.current
    DisposableEffect(active, context, view) {
        val activity = context as? AppCompatActivity
        val window = activity?.window
        val controller = window?.let { WindowInsetsControllerCompat(it, view) }
        if (active && window != null && controller != null) {
            WindowCompat.setDecorFitsSystemWindows(window, false)
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        }
        onDispose {
            if (window != null && controller != null) {
                controller.show(WindowInsetsCompat.Type.systemBars())
                WindowCompat.setDecorFitsSystemWindows(window, false)
            }
        }
    }
}

@Composable
private fun LiveCameraChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Button(
        onClick = onClick,
        modifier = modifier,
        contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp),
        shape = RoundedCornerShape(9.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = if (selected) AccentCyan.copy(alpha = 0.22f) else Color.White.copy(alpha = 0.08f)
        ),
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (selected) AccentCyan.copy(alpha = 0.8f) else Color.White.copy(alpha = 0.18f)
        )
    ) {
        Text(
            text = label,
            color = if (selected) AccentCyan else Color.White.copy(alpha = 0.82f),
            fontFamily = FontFamily.Monospace,
            fontSize = 9.sp,
            fontWeight = FontWeight.Bold
        )
    }
}

@Composable
private fun CloseLiveButton(
    modifier: Modifier = Modifier,
    onClick: () -> Unit
) {
    Button(
        onClick = onClick,
        modifier = modifier.height(34.dp),
        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 0.dp),
        shape = RoundedCornerShape(10.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = Color.Black.copy(alpha = 0.78f),
            contentColor = AccentCyan
        ),
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            AccentCyan.copy(alpha = 0.52f)
        )
    ) {
        Icon(Icons.Default.Close, contentDescription = "Chiudi live DJI", modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(5.dp))
        Text(
            text = "CHIUDI LIVE",
            fontFamily = FontFamily.Monospace,
            fontSize = 9.sp,
            fontWeight = FontWeight.Bold
        )
    }
}

@Composable
private fun GimbalPrecisionPanel(
    modifier: Modifier = Modifier,
    vector: Offset,
    speedScale: Float,
    onVectorChange: (Offset) -> Unit,
    onSpeedScaleChange: (Float) -> Unit,
    onReset: () -> Unit
) {
    val knobRadius = 14.dp
    Column(
        modifier = modifier
            .width(118.dp)
            .background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(18.dp))
            .border(1.dp, Color.White.copy(alpha = 0.12f), RoundedCornerShape(18.dp))
            .padding(horizontal = 8.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("GMBL", color = AccentCyan, fontFamily = FontFamily.Monospace, fontSize = 9.sp, fontWeight = FontWeight.Bold)
            TextButton(
                onClick = onReset,
                contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp)
            ) {
                Text("RST", color = Color.White.copy(alpha = 0.88f), fontFamily = FontFamily.Monospace, fontSize = 8.sp)
            }
        }

        BoxWithConstraints(
            modifier = Modifier
                .size(86.dp)
                .align(Alignment.CenterHorizontally)
                .background(Color.White.copy(alpha = 0.06f), CircleShape)
                .border(1.dp, Color.White.copy(alpha = 0.16f), CircleShape)
                .pointerInput(Unit) {
                    detectDragGestures(
                        onDragStart = { offset ->
                            val center = Offset(size.width / 2f, size.height / 2f)
                            onVectorChange(normalizedJoystickVector(offset - center))
                        },
                        onDrag = { change, _ ->
                            val center = Offset(size.width / 2f, size.height / 2f)
                            onVectorChange(normalizedJoystickVector(change.position - center))
                        },
                        onDragEnd = { onVectorChange(Offset.Zero) },
                        onDragCancel = { onVectorChange(Offset.Zero) }
                    )
                },
            contentAlignment = Alignment.Center
        ) {
            Box(
                modifier = Modifier
                    .size(3.dp)
                    .background(Color.White.copy(alpha = 0.36f), CircleShape)
            )
            Box(
                modifier = Modifier
                    .offset(
                        x = (vector.x * 30f).dp,
                        y = (vector.y * 30f).dp
                    )
                    .size(knobRadius * 2)
                    .background(AccentCyan.copy(alpha = 0.82f), CircleShape)
                    .border(1.dp, Color.White.copy(alpha = 0.45f), CircleShape)
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("VEL", color = Color.White.copy(alpha = 0.82f), fontFamily = FontFamily.Monospace, fontSize = 8.sp)
            Text("${(speedScale * 100).toInt()}%", color = Color.White.copy(alpha = 0.92f), fontFamily = FontFamily.Monospace, fontSize = 8.sp)
        }
        Slider(
            value = speedScale,
            onValueChange = onSpeedScaleChange,
            valueRange = 0.15f..1f,
            steps = 8,
            modifier = Modifier.height(16.dp),
            colors = SliderDefaults.colors(
                thumbColor = Color.White,
                activeTrackColor = Color.White.copy(alpha = 0.88f),
                inactiveTrackColor = Color.White.copy(alpha = 0.16f)
            )
        )
    }
}

private fun normalizedJoystickVector(offset: Offset): Offset {
    val radius = 43f
    val len = sqrt(offset.x * offset.x + offset.y * offset.y)
    if (len <= 1f) return Offset.Zero
    val scale = if (len > radius) radius / len else 1f
    return Offset(
        x = (offset.x * scale / radius).coerceIn(-1f, 1f),
        y = (offset.y * scale / radius).coerceIn(-1f, 1f)
    )
}
