package com.peakage.packing

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.print.PrintAttributes
import android.print.PrintManager
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.FileProvider
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class MainActivity : Activity() {

    private lateinit var web: WebView
    private var printWeb: WebView? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var photoUri: Uri? = null
    private val pool = Executors.newFixedThreadPool(4)
    private val main = Handler(Looper.getMainLooper())

    companion object {
        private const val REQ_CAMERA = 1001
        private const val APP_HOST = "appassets.androidplatform.net"
        private const val USER_AGENT = "PeakAgePacking/1.0 (Android)"
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false
        web.settings.allowContentAccess = true

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                return assetLoader.shouldInterceptRequest(request.url)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == APP_HOST) return false
                // Tracking links and anything else open in the phone's browser.
                startActivity(Intent(Intent.ACTION_VIEW, request.url))
                return true
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = filePathCallback
                return openCamera()
            }
        }

        web.addJavascriptInterface(Bridge(), "AndroidBridge")
        web.loadUrl("https://$APP_HOST/assets/www/index.html")
    }

    private fun openCamera(): Boolean {
        return try {
            val dir = File(cacheDir, "photos").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() }
            val file = File(dir, "pack_${System.currentTimeMillis()}.jpg")
            val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
            photoUri = uri
            val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                putExtra(MediaStore.EXTRA_OUTPUT, uri)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            @Suppress("DEPRECATION")
            startActivityForResult(intent, REQ_CAMERA)
            true
        } catch (e: Exception) {
            fileCallback?.onReceiveValue(null)
            fileCallback = null
            false
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_CAMERA) return
        val cb = fileCallback ?: return
        fileCallback = null
        val uri = photoUri
        if (resultCode == RESULT_OK && uri != null) cb.onReceiveValue(arrayOf(uri)) else cb.onReceiveValue(null)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        web.evaluateJavascript("window.appBack ? window.appBack() : false") { result ->
            if (result != "true") {
                @Suppress("DEPRECATION")
                super.onBackPressed()
            }
        }
    }

    private fun deliver(id: String, status: Int, text: String) {
        val js = "window.__httpDone(${JSONObject.quote(id)}, $status, ${JSONObject.quote(text)})"
        main.post { web.evaluateJavascript(js, null) }
    }

    inner class Bridge {
        /** HTTP from native code, so the store's API is reached without browser CORS rules. */
        @JavascriptInterface
        fun http(id: String, method: String, url: String, headersJson: String, body: String, bodyIsBase64: String) {
            pool.execute {
                var conn: HttpURLConnection? = null
                try {
                    conn = (URL(url).openConnection() as HttpURLConnection).apply {
                        requestMethod = method
                        connectTimeout = 20000
                        readTimeout = 60000
                        setRequestProperty("User-Agent", USER_AGENT)
                        val headers = JSONObject(headersJson)
                        val keys = headers.keys()
                        while (keys.hasNext()) {
                            val k = keys.next()
                            setRequestProperty(k, headers.getString(k))
                        }
                    }
                    if (body.isNotEmpty()) {
                        val bytes = if (bodyIsBase64 == "1") Base64.decode(body, Base64.DEFAULT) else body.toByteArray(Charsets.UTF_8)
                        conn.doOutput = true
                        conn.setFixedLengthStreamingMode(bytes.size)
                        conn.outputStream.use { it.write(bytes) }
                    }
                    val code = conn.responseCode
                    val stream = if (code >= 400) conn.errorStream else conn.inputStream
                    val text = stream?.use { s ->
                        val out = ByteArrayOutputStream()
                        s.copyTo(out)
                        out.toString("UTF-8")
                    } ?: ""
                    deliver(id, code, text)
                } catch (e: Exception) {
                    deliver(id, 0, e.message ?: e.javaClass.simpleName)
                } finally {
                    conn?.disconnect()
                }
            }
        }

        /** Prints an HTML document through Android's print service. */
        @JavascriptInterface
        fun print(html: String, jobName: String) {
            main.post {
                val pw = WebView(this@MainActivity)
                printWeb = pw
                pw.webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView, url: String) {
                        val pm = getSystemService(PRINT_SERVICE) as PrintManager
                        pm.print(
                            jobName,
                            view.createPrintDocumentAdapter(jobName),
                            PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.NA_LETTER).build()
                        )
                    }
                }
                pw.loadDataWithBaseURL("https://$APP_HOST/", html, "text/html", "UTF-8", null)
            }
        }
    }
}
