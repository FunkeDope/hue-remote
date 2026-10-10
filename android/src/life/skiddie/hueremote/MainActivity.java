package life.skiddie.hueremote;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * A WebView shell. The whole UI lives in assets/ (HTML/CSS/JS); this class only
 * gives that page the things a WebView can't do on its own: HTTP to the bridge
 * without CORS getting in the way, LAN discovery, and persistent settings.
 */
public class MainActivity extends Activity {
    private WebView web;
    private SharedPreferences prefs;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private volatile boolean destroyed;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("hue", MODE_PRIVATE);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#131118"));
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        web.setWebChromeClient(new WebChromeClient()); // enables confirm() dialogs
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return true; // single local page, never navigate anywhere else
            }
        });
        web.addJavascriptInterface(new NativeBridge(), "Native");
        setContentView(web);
        web.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        pool.shutdownNow();
        web.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        // Let the page close its own dialogs/screens first.
        web.evaluateJavascript("window.handleBack ? window.handleBack() : false", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String handled) {
                if (!"true".equals(handled)) MainActivity.super.onBackPressed();
            }
        });
    }

    /** Hands a result back to the page: window.__nativeCb({id, ok, ...}). */
    private void deliver(String id, JSONObject result) {
        try {
            result.put("id", id);
        } catch (JSONException ignored) {
        }
        final String js = "window.__nativeCb(" + result.toString() + ")";
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (!destroyed) web.evaluateJavascript(js, null);
            }
        });
    }

    private static JSONObject failure(Exception e) {
        JSONObject r = new JSONObject();
        try {
            r.put("ok", false);
            String msg = e.getMessage();
            r.put("error", e.getClass().getSimpleName() + (msg == null ? "" : ": " + msg));
        } catch (JSONException ignored) {
        }
        return r;
    }

    private class NativeBridge {
        @JavascriptInterface
        public void http(final String id, final String method, final String url, final String body) {
            pool.execute(new Runnable() {
                @Override
                public void run() {
                    JSONObject r;
                    try {
                        r = request(method, url, body, 4000, 8000);
                    } catch (Exception e) {
                        r = failure(e);
                    }
                    deliver(id, r);
                }
            });
        }

        @JavascriptInterface
        public void discover(final String id) {
            pool.execute(new Runnable() {
                @Override
                public void run() {
                    JSONObject r = new JSONObject();
                    try {
                        r.put("ok", true);
                        r.put("bridges", new JSONArray(findBridges()));
                    } catch (Exception e) {
                        r = failure(e);
                    }
                    deliver(id, r);
                }
            });
        }

        @JavascriptInterface
        public String getPref(String key) {
            return prefs.getString(key, "");
        }

        @JavascriptInterface
        public void setPref(String key, String value) {
            prefs.edit().putString(key, value).apply();
        }

        @JavascriptInterface
        public String deviceName() {
            return Build.MODEL == null ? "android" : Build.MODEL;
        }
    }

    private static JSONObject request(String method, String url, String body, int connectMs, int readMs)
            throws IOException, JSONException {
        if (!url.startsWith("http://") && !url.startsWith("https://")) throw new IOException("Bad URL");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(connectMs);
            c.setReadTimeout(readMs);
            c.setRequestMethod(method);
            c.setUseCaches(false);
            // The old bridge is flaky with reused keep-alive connections.
            c.setRequestProperty("Connection", "close");
            if (body != null && body.length() > 0) {
                byte[] bytes = body.getBytes("UTF-8");
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                c.setFixedLengthStreamingMode(bytes.length);
                OutputStream out = c.getOutputStream();
                out.write(bytes);
                out.close();
            }
            int status = c.getResponseCode();
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            JSONObject r = new JSONObject();
            r.put("ok", true);
            r.put("status", status);
            r.put("body", in == null ? "" : readAll(in, 1 << 20));
            return r;
        } finally {
            c.disconnect();
        }
    }

    private static String readAll(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        try {
            while ((n = in.read(chunk)) != -1 && buf.size() < limit) buf.write(chunk, 0, n);
        } finally {
            in.close();
        }
        return buf.toString("UTF-8");
    }

    // ---- Bridge discovery: SSDP first, then a /24 sweep if nothing answered ----

    private List<String> findBridges() {
        Set<String> found = Collections.synchronizedSet(new LinkedHashSet<String>());
        WifiManager.MulticastLock lock = null;
        try {
            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                lock = wifi.createMulticastLock("hue-discovery");
                lock.setReferenceCounted(false);
                lock.acquire();
            }
        } catch (Exception ignored) {
        }
        try {
            ssdpSearch(found);
        } catch (Exception ignored) {
        } finally {
            if (lock != null && lock.isHeld()) lock.release();
        }
        if (found.isEmpty()) sweepSubnet(found);
        synchronized (found) {
            return new ArrayList<String>(found);
        }
    }

    private static void ssdpSearch(Set<String> found) throws IOException {
        byte[] msg = ("M-SEARCH * HTTP/1.1\r\n"
                + "HOST: 239.255.255.250:1900\r\n"
                + "MAN: \"ssdp:discover\"\r\n"
                + "MX: 2\r\n"
                + "ST: ssdp:all\r\n\r\n").getBytes("UTF-8");
        InetAddress group = InetAddress.getByName("239.255.255.250");
        DatagramSocket socket = new DatagramSocket();
        try {
            socket.setSoTimeout(300);
            byte[] buf = new byte[2048];
            long end = System.currentTimeMillis() + 3000;
            long nextSend = 0;
            int sent = 0;
            while (System.currentTimeMillis() < end) {
                if (sent < 2 && System.currentTimeMillis() >= nextSend) {
                    socket.send(new DatagramPacket(msg, msg.length, group, 1900));
                    sent++;
                    nextSend = System.currentTimeMillis() + 1000;
                }
                DatagramPacket packet = new DatagramPacket(buf, buf.length);
                try {
                    socket.receive(packet);
                } catch (SocketTimeoutException e) {
                    continue;
                }
                String reply = new String(packet.getData(), 0, packet.getLength(), "UTF-8").toLowerCase(Locale.US);
                // v1 bridges announce "IpBridge" in SERVER; newer ones add hue-bridgeid.
                if (reply.contains("ipbridge") || reply.contains("hue-bridgeid")) {
                    found.add(packet.getAddress().getHostAddress());
                }
            }
        } finally {
            socket.close();
        }
    }

    private void sweepSubnet(final Set<String> found) {
        String prefix = localSubnetPrefix();
        if (prefix == null) return;
        ExecutorService sweep = Executors.newFixedThreadPool(32);
        List<Callable<Void>> jobs = new ArrayList<Callable<Void>>();
        for (int i = 1; i < 255; i++) {
            final String ip = prefix + i;
            jobs.add(new Callable<Void>() {
                @Override
                public Void call() {
                    try {
                        JSONObject r = request("GET", "http://" + ip + "/description.xml", null, 700, 1500);
                        String body = r.optString("body").toLowerCase(Locale.US);
                        if (r.optInt("status") == 200 && (body.contains("hue bridge") || body.contains("meethue"))) {
                            found.add(ip);
                        }
                    } catch (Exception ignored) {
                    }
                    return null;
                }
            });
        }
        try {
            sweep.invokeAll(jobs, 20, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        } finally {
            sweep.shutdownNow();
        }
    }

    /** "a.b.c." for the phone's Wi-Fi/Ethernet IPv4 address, or null. */
    private static String localSubnetPrefix() {
        String fallback = null;
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                String name = ni.getName().toLowerCase(Locale.US);
                for (InetAddress addr : Collections.list(ni.getInetAddresses())) {
                    if (!(addr instanceof Inet4Address) || !addr.isSiteLocalAddress()) continue;
                    String ip = addr.getHostAddress();
                    String prefix = ip.substring(0, ip.lastIndexOf('.') + 1);
                    if (name.startsWith("wlan") || name.startsWith("eth")) return prefix;
                    // Skip mobile data, VPNs and the like, which often use 10.x too.
                    if (fallback == null && !name.startsWith("rmnet") && !name.startsWith("ccmni")
                            && !name.startsWith("tun") && !name.startsWith("dummy")) {
                        fallback = prefix;
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return fallback;
    }
}
