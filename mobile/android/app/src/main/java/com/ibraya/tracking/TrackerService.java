package com.ibraya.tracking;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.os.BatteryManager;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Scanner;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Keeps sending the phone's location to Ibraya Logistics, 24/7, as an Android foreground
 * service (the same kind navigation apps use). It keeps running with the screen off, after the
 * app is closed, and is restarted after a reboot by {@link BootReceiver}.
 *
 * It authenticates with a per-phone device token (see public.track_with_device_token in
 * supabase/migrations), so it doesn't depend on the website's login session.
 */
public class TrackerService extends Service implements LocationListener {
    private static final String TAG = "IbrayaTracker";

    static final String PREFS = "ibraya_tracker";
    static final String KEY_TOKEN = "token";
    static final String KEY_URL = "supabaseUrl";
    static final String KEY_APIKEY = "apiKey";
    static final String KEY_LAST_SENT = "lastSentAt";
    static final String KEY_LAST_ERROR = "lastError";
    static final String KEY_SIGNED_OUT = "signedOut";

    private static final String CHANNEL_ID = "tracking";
    private static final String CHANNEL_ALERTS = "alerts";
    private static final int NOTIFICATION_ID = 1;
    private static final int NOTIFICATION_SIGNED_OUT = 2;

    private static final long GPS_INTERVAL_MS = 2_000;       // ask the GPS for a reading every 2 s
    private static final long SEND_MOVING_MS = 5_000;        // send every 5 s while moving
    private static final long SEND_PARKED_MS = 30_000;       // every 30 s while parked (admin map: offline after 2 min)
    private static final long STOPPED_AFTER_MS = 15_000;     // no new reading for 15 s = not moving
    private static final float MOVING_MPS = 1.4f;            // ~5 km/h, same as the admin map's "Active"
    private static final long NO_FIX_AFTER_MS = 3 * 60_000;  // no position for 3 min = tell the admin "no GPS"

    private static volatile boolean running = false;

    private LocationManager locationManager;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private PowerManager.WakeLock wakeLock;

    private Location lastLocation;
    private long lastFixAt = 0;
    private long lastSentAt = 0;
    private Location prevForSpeed;
    private boolean sending = false;
    private String reportedProblem = null; // last problem told to the admin (cleared by the next location)
    private long startedAt = 0;

    /** The driver switches the phone off: tell the admin before it goes dark. */
    private final BroadcastReceiver shutdownReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            final PendingResult pending = goAsync();
            new Thread(() -> {
                try {
                    // Shutting down at 0-2 % without a charger = the battery died, not the driver.
                    int level = batteryLevel(context);
                    boolean dead = level >= 0 && level <= 2 && !isCharging(context);
                    reportNow(dead ? "battery_dead" : "phone_off", 4_000);
                } finally {
                    pending.finish();
                }
            }).start();
        }
    };

    static boolean isRunning() {
        return running;
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean hasLocationPermission(Context context) {
        return ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    /** Battery level 0-100, or -1 if unknown. */
    static int batteryLevel(Context context) {
        try {
            BatteryManager bm = (BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
            int level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
            return level >= 0 && level <= 100 ? level : -1;
        } catch (Exception e) {
            return -1;
        }
    }

    static boolean isCharging(Context context) {
        try {
            Intent battery = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            int plugged = battery == null ? 0 : battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
            return plugged != 0;
        } catch (Exception e) {
            return false;
        }
    }

    /** Starts the service if this phone has a device token and location permission. */
    static boolean startIfConfigured(Context context) {
        if (prefs(context).getString(KEY_TOKEN, null) == null || !hasLocationPermission(context)) return false;
        try {
            ContextCompat.startForegroundService(context, new Intent(context, TrackerService.class));
            return true;
        } catch (Exception e) {
            // e.g. Android 12+ refusing a start from the background without "Allow all the time"
            Log.w(TAG, "Could not start tracking service", e);
            prefs(context).edit().putString(KEY_LAST_ERROR, "start: " + e.getMessage()).apply();
            return false;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "IbrayaTracking::send");
        wakeLock.setReferenceCounted(false);
        createChannels();
        try {
            ContextCompat.registerReceiver(this, shutdownReceiver, new IntentFilter(Intent.ACTION_SHUTDOWN), ContextCompat.RECEIVER_EXPORTED);
        } catch (Exception e) {
            Log.w(TAG, "Could not watch for shutdown", e);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (prefs(this).getString(KEY_TOKEN, null) == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!hasLocationPermission(this)) {
            // The driver took away the app's location permission: tell the admin, then stop.
            new Thread(() -> {
                reportNow("location_off", 10_000);
                handler.post(this::stopSelf);
            }).start();
            return START_NOT_STICKY;
        }
        try {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0;
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type);
        } catch (Exception e) {
            Log.w(TAG, "startForeground failed", e);
            prefs(this).edit().putString(KEY_LAST_ERROR, "foreground: " + e.getMessage()).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!running) {
            running = true;
            startedAt = System.currentTimeMillis();
            startLocationUpdates();
            handler.postDelayed(heartbeat, SEND_PARKED_MS);
        }
        // If Android ever kills the service to free memory, it restarts it.
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        handler.removeCallbacksAndMessages(null);
        try {
            unregisterReceiver(shutdownReceiver);
        } catch (Exception ignored) {
        }
        try {
            locationManager.removeUpdates(this);
        } catch (Exception ignored) {
        }
        network.shutdown();
        if (wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------- location ----------

    @SuppressWarnings("MissingPermission")
    private void startLocationUpdates() {
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, GPS_INTERVAL_MS, 0f, this, Looper.getMainLooper());
            }
        } catch (Exception e) {
            Log.w(TAG, "GPS updates failed", e);
        }
        try {
            // Mobile-network / Wi-Fi location: works indoors and gives a first position quickly.
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, GPS_INTERVAL_MS * 2, 0f, this, Looper.getMainLooper());
            }
        } catch (Exception e) {
            Log.w(TAG, "Network location updates failed", e);
        }
        try {
            Location last = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            if (last == null) last = locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            if (last != null) lastLocation = last;
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onLocationChanged(Location location) {
        // Prefer GPS: ignore a rough network reading if a GPS reading arrived recently.
        boolean isGps = LocationManager.GPS_PROVIDER.equals(location.getProvider());
        if (!isGps && lastLocation != null && LocationManager.GPS_PROVIDER.equals(lastLocation.getProvider())
            && System.currentTimeMillis() - lastFixAt < 20_000) {
            return;
        }
        lastLocation = location;
        lastFixAt = System.currentTimeMillis();
        float speed = speedOf(location);
        long interval = speed >= MOVING_MPS ? SEND_MOVING_MS : SEND_PARKED_MS;
        if (System.currentTimeMillis() - lastSentAt >= interval) send(location, speed);
    }

    /** GPS speed in m/s if the phone gives one, else worked out from the previous reading. */
    private float speedOf(Location location) {
        float speed = -1;
        if (location.hasSpeed()) {
            speed = location.getSpeed();
        } else if (prevForSpeed != null) {
            float seconds = (location.getTime() - prevForSpeed.getTime()) / 1000f;
            float metres = location.distanceTo(prevForSpeed);
            float error = Math.max(location.getAccuracy(), prevForSpeed.getAccuracy());
            if (seconds >= 3) speed = metres < error ? 0 : metres / seconds;
        }
        if (location.getAccuracy() <= 50) prevForSpeed = location;
        return speed > 70 ? -1 : speed; // ignore impossible jumps (> ~250 km/h)
    }

    /**
     * Re-sends the last position while parked, so the admin map keeps the truck as "Idle".
     * If location is switched off, or there has been no position for 3 minutes, the old position
     * is NOT re-sent (that would hide where the truck really is): the admin is told instead.
     */
    private final Runnable heartbeat = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            long now = System.currentTimeMillis();
            if (!locationEnabled()) {
                report("location_off");
            } else if (now - Math.max(lastFixAt, startedAt) > NO_FIX_AFTER_MS) {
                report("no_gps");
            } else if (lastLocation != null && lastFixAt > 0 && now - lastSentAt >= SEND_PARKED_MS - 1_000) {
                boolean stale = now - lastFixAt > STOPPED_AFTER_MS;
                send(lastLocation, stale ? 0 : speedOf(lastLocation));
            }
            handler.postDelayed(this, SEND_PARKED_MS);
        }
    };

    private boolean locationEnabled() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return locationManager.isLocationEnabled();
            return locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)
                || locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception e) {
            return true;
        }
    }

    // Unused on new Android versions, required on old ones.
    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {
    }

    @Override
    public void onProviderEnabled(String provider) {
        startLocationUpdates();
    }

    @Override
    public void onProviderDisabled(String provider) {
        if (!locationEnabled()) report("location_off");
    }

    // ---------- sending ----------

    private void send(Location location, float speed) {
        if (sending) return;
        SharedPreferences p = prefs(this);
        String token = p.getString(KEY_TOKEN, null);
        String url = p.getString(KEY_URL, null);
        String apiKey = p.getString(KEY_APIKEY, null);
        if (token == null || url == null || apiKey == null) {
            stopSelf();
            return;
        }
        sending = true;
        lastSentAt = System.currentTimeMillis();
        final double lat = location.getLatitude();
        final double lng = location.getLongitude();
        final Float accuracy = location.hasAccuracy() ? location.getAccuracy() : null;
        final Float heading = location.hasBearing() ? location.getBearing() : null;
        final Float spd = speed >= 0 ? speed : null;
        final int battery = batteryLevel(this);
        wakeLock.acquire(30_000);
        network.execute(() -> {
            String result = null;
            String error = null;
            try {
                JSONObject body = new JSONObject();
                body.put("p_token", token);
                body.put("p_lat", lat);
                body.put("p_lng", lng);
                body.put("p_accuracy", accuracy == null ? JSONObject.NULL : accuracy.doubleValue());
                body.put("p_speed", spd == null ? JSONObject.NULL : spd.doubleValue());
                body.put("p_heading", heading == null ? JSONObject.NULL : heading.doubleValue());
                body.put("p_battery", battery >= 0 ? battery : JSONObject.NULL);
                result = post(url + "/rest/v1/rpc/track_with_device_token", apiKey, body.toString(), 15_000);
            } catch (Exception e) {
                error = e.getClass().getSimpleName() + ": " + e.getMessage();
            }
            final String finalResult = result;
            final String finalError = error;
            handler.post(() -> afterSend(finalResult, finalError));
        });
    }

    private void afterSend(String result, String error) {
        sending = false;
        if (wakeLock.isHeld()) wakeLock.release();
        SharedPreferences.Editor edit = prefs(this).edit();
        if (error != null) {
            // No signal etc.: keep going, the next reading will try again.
            edit.putString(KEY_LAST_ERROR, error).apply();
            lastSentAt = System.currentTimeMillis() - SEND_PARKED_MS + 10_000; // retry in ~10 s
            return;
        }
        if ("false".equals(result != null ? result.trim() : null)) {
            tokenRevoked();
            return;
        }
        edit.putLong(KEY_LAST_SENT, System.currentTimeMillis()).remove(KEY_LAST_ERROR).apply();
        reportedProblem = null; // a location got through, so the admin sees the truck again
    }

    // ---------- telling the admin why there is no location ----------

    /** Reports a problem once (until a location gets through again). */
    private void report(String problem) {
        if (problem.equals(reportedProblem)) return;
        reportedProblem = problem;
        wakeLock.acquire(30_000);
        network.execute(() -> {
            String result = reportNow(problem, 15_000);
            handler.post(() -> {
                if (wakeLock.isHeld() && !sending) wakeLock.release();
                if (result == null) reportedProblem = null; // not sent (no signal): try again next time
                else if ("false".equals(result.trim())) tokenRevoked();
            });
        });
    }

    /** Sends a problem report straight away; returns the server's answer, or null if it failed. */
    private String reportNow(String problem, int timeoutMs) {
        SharedPreferences p = prefs(this);
        String token = p.getString(KEY_TOKEN, null);
        String url = p.getString(KEY_URL, null);
        String apiKey = p.getString(KEY_APIKEY, null);
        if (token == null || url == null || apiKey == null) return null;
        try {
            JSONObject body = new JSONObject();
            body.put("p_token", token);
            body.put("p_problem", problem);
            int battery = batteryLevel(this);
            body.put("p_battery", battery >= 0 ? battery : JSONObject.NULL);
            return post(url + "/rest/v1/rpc/tracker_report_problem", apiKey, body.toString(), timeoutMs);
        } catch (Exception e) {
            Log.w(TAG, "Could not report " + problem, e);
            return null;
        }
    }

    /** The token is no longer valid: signed out on another phone, or the driver was removed. */
    private void tokenRevoked() {
        prefs(this).edit().remove(KEY_TOKEN).putBoolean(KEY_SIGNED_OUT, true).putString(KEY_LAST_ERROR, "signed out").apply();
        notifySignedOut();
        stopSelf();
    }

    private static String post(String address, String apiKey, String json, int timeoutMs) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(address).openConnection();
        try {
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("apikey", apiKey);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(json.getBytes(StandardCharsets.UTF_8));
            }
            int code = conn.getResponseCode();
            InputStream in = code < 400 ? conn.getInputStream() : conn.getErrorStream();
            String text = "";
            if (in != null) {
                try (Scanner s = new Scanner(in, "UTF-8").useDelimiter("\\A")) {
                    text = s.hasNext() ? s.next() : "";
                }
            }
            if (code >= 400) throw new Exception("HTTP " + code + " " + text);
            return text;
        } finally {
            conn.disconnect();
        }
    }

    // ---------- notifications ----------

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel tracking = new NotificationChannel(CHANNEL_ID, "Location tracking", NotificationManager.IMPORTANCE_LOW);
        tracking.setDescription("Shows while Ibraya Logistics is tracking this truck");
        tracking.setShowBadge(false);
        nm.createNotificationChannel(tracking);
        NotificationChannel alerts = new NotificationChannel(CHANNEL_ALERTS, "Tracking alerts", NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription("Tells you if tracking stopped and you need to open the app");
        nm.createNotificationChannel(alerts);
    }

    private PendingIntent openAppIntent() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification buildNotification() {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_tracking)
            .setContentTitle("Ibraya Tracking is on")
            .setContentText("Sharing this truck's location with Ibraya Logistics")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openAppIntent())
            .build();
    }

    private void notifySignedOut() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_tracking)
            .setContentTitle("Tracking stopped")
            .setContentText("Open Ibraya Tracking and sign in again.")
            .setAutoCancel(true)
            .setContentIntent(openAppIntent())
            .build();
        try {
            nm.notify(NOTIFICATION_SIGNED_OUT, n);
        } catch (SecurityException ignored) {
            // notifications not allowed
        }
    }
}
