package jp.yasagure.ponlet.platform

import androidx.core.content.FileProvider

// A distinct component keeps our restricted received-file paths separate from
// Tauri's provider when Android merges the application and plugin manifests.
class ReceivedFileProvider : FileProvider()
