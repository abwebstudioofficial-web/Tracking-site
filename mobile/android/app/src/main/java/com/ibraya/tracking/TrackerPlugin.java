package com.ibraya.tracking;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Lets the website (running inside the app) control 24/7 tracking:
 * start/stop the background service and walk the driver through the permissions it needs.
 * Used from public/js/driver.js as Capacitor plugin "IbrayaTracker".
 */
@CapacitorPlugin(
    name = "IbrayaTracker",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class TrackerPlugin extends Plugin {

    /** Saves the device token and starts the background service. */
    @PluginMethod
    public void start(PluginCall call) {
        String token = call.getString("token");
        String url = call.getString("supabaseUrl");
        String apiKey = call.getString("apiKey");
        if (token == null || url == null || apiKey == null) {
            call.reject("token, supabaseUrl and apiKey are required");
            return;
        }
        TrackerService.prefs(getContext()).edit()
            .putString(TrackerService.KEY_TOKEN, token)
            .putString(TrackerService.KEY_URL, url)
            .putString(TrackerService.KEY_APIKEY, apiKey)
            .remove(TrackerService.KEY_SIGNED_OUT)
            .apply();
        boolean started = TrackerService.startIfConfigured(getContext());
        JSObject result = status(getContext());
        result.put("started", started);
        call.resolve(result);
    }

    /** Stops tracking and forgets the token (sign-out). */
    @PluginMethod
    public void stop(PluginCall call) {
        TrackerService.prefs(getContext()).edit().clear().apply();
        getContext().stopService(new Intent(getContext(), TrackerService.class));
        call.resolve(status(getContext()));
    }

    /** Everything the setup screen needs to show. */
    @PluginMethod
    public void getStatus(PluginCall call) {
        // Restart the service if it should be running but isn't (e.g. permissions were just granted).
        if (!TrackerService.isRunning()) TrackerService.startIfConfigured(getContext());
        call.resolve(status(getContext()));
    }

    @PluginMethod
    public void requestLocation(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) {
            afterLocation(call);
        } else {
            requestPermissionForAlias("location", call, "afterLocation");
        }
    }

    @PermissionCallback
    private void afterLocation(PluginCall call) {
        TrackerService.startIfConfigured(getContext());
        call.resolve(status(getContext()));
    }

    /**
     * "Allow all the time" can't be granted from a pop-up on Android 11+; the driver has to pick it
     * in the app's location settings, so open that screen.
     */
    @PluginMethod
    public void openBackgroundLocationSettings(PluginCall call) {
        openAppSettings();
        call.resolve(status(getContext()));
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(status(getContext()));
        } else {
            requestPermissionForAlias("notifications", call, "afterNotifications");
        }
    }

    @PermissionCallback
    private void afterNotifications(PluginCall call) {
        call.resolve(status(getContext()));
    }

    /** Asks Android not to put the app to sleep to save battery (the system shows a Yes/No dialog). */
    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        Context context = getContext();
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Exception e) {
            openAppSettings();
        }
        call.resolve(status(context));
    }

    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve(status(getContext()));
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        openAppSettings();
        call.resolve(status(getContext()));
    }

    private void openAppSettings() {
        Context context = getContext();
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + context.getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }

    static JSObject status(Context context) {
        SharedPreferences p = TrackerService.prefs(context);
        JSObject s = new JSObject();
        s.put("hasToken", p.getString(TrackerService.KEY_TOKEN, null) != null);
        s.put("signedOut", p.getBoolean(TrackerService.KEY_SIGNED_OUT, false));
        s.put("running", TrackerService.isRunning());
        s.put("location", TrackerService.hasLocationPermission(context));
        boolean background = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
        s.put("background", background);
        s.put("notifications", NotificationManagerCompat.from(context).areNotificationsEnabled());
        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        s.put("battery", pm.isIgnoringBatteryOptimizations(context.getPackageName()));
        LocationManager lm = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        boolean gpsOn;
        try {
            gpsOn = lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception e) {
            gpsOn = false;
        }
        s.put("gpsOn", gpsOn);
        long lastSent = p.getLong(TrackerService.KEY_LAST_SENT, 0);
        s.put("lastSentAt", lastSent == 0 ? null : lastSent);
        s.put("lastError", p.getString(TrackerService.KEY_LAST_ERROR, null));
        s.put("androidVersion", Build.VERSION.SDK_INT);
        s.put("device", Build.MANUFACTURER + " " + Build.MODEL);
        return s;
    }
}
