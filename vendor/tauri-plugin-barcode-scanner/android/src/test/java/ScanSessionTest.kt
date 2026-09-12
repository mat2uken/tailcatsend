// SPDX-License-Identifier: Apache-2.0 OR MIT

package app.tauri.barcodescanner

import org.junit.Assert.*
import org.junit.Test

class ScanSessionTest {
    @Test
    fun cancelBeforeProviderReadyInvalidatesCallbackAndReturnsPendingScanOnce() {
        val session = ScanSession<String>()
        val token = session.begin("first scan")
        assertEquals("first scan", session.finish())
        assertFalse(session.isCurrent(token))
        assertNull(session.finish(token))
        assertNull(session.finish())
    }

    @Test
    fun cancelledProviderAndAnalysisCallbacksCannotCompleteTheNextScan() {
        val session = ScanSession<String>()
        val old = session.begin("cancelled scan")
        session.finish()
        val current = session.begin("new scan")
        assertFalse(session.isCurrent(old))
        assertNull(session.finish(old))
        assertTrue(session.isCurrent(current))
        assertEquals("new scan", session.finish(current))
        assertFalse(session.isCurrent(current))
    }

    @Test
    fun completionThenCancelCannotResolveOrRejectTheScanTwice() {
        val session = ScanSession<String>()
        val token = session.begin("completed scan")
        assertEquals("completed scan", session.finish(token))
        assertNull(session.finish())
        assertNull(session.finish(token))
    }
}
