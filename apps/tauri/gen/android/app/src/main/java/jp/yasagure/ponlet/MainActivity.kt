package jp.yasagure.ponlet

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    PonletPort.attachToContentView(this)
  }

  override fun onResume() {
    super.onResume()
    PonletPort.attachToContentView(this)
  }
}
