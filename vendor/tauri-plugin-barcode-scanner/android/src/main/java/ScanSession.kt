// SPDX-License-Identifier: Apache-2.0 OR MIT

package app.tauri.barcodescanner

/** Main-thread state shared by scan, cancel, provider and analysis callbacks. */
internal class ScanSession<T : Any> {
    private var generation = 0L
    private var pending: T? = null

    fun begin(value: T): Long {
        check(pending == null) { "Previous scan must be completed before starting another" }
        generation++
        pending = value
        return generation
    }

    fun isCurrent(token: Long): Boolean = token == generation && pending != null

    fun finish(token: Long? = null): T? {
        if (token != null && !isCurrent(token)) return null
        val value = pending
        pending = null
        generation++
        return value
    }
}
