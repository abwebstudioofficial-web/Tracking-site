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
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.List;

/**
 * Lets the website (running inside the app) control 24/7 tracking:
 * start/stop the background service and walk the driver through the permissions it needs.
 * Used from public/js/driver.js as Capacitor plugin "IbrayaTracker".
 */
@CapacitorPlugin(
    name = "IbrayaTracker",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" }),
        @Permission(alias = "background", strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }),
        @Permission(alias = "phone", strings = { Manifest.permission.READ_PHONE_STATE, Manifest.permission.READ_PHONE_NUMBERS })
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
        // A new sign-in: a route saved offline under an earlier account must not be uploaded as this one's.
        new OfflineRoute(getContext()).clear();
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
        new OfflineRoute(getContext()).clear();
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
     * "Allow all the time". Asking for it makes Android open the app's own location-permission
     * screen (the one with "Allow all the time"), on every brand. If Android refuses to ask again
     * (it does after the driver said no twice), open the app's settings page instead.
     */
    @PluginMethod
    public void openBackgroundLocationSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || getPermissionState("background") == PermissionState.GRANTED) {
            call.resolve(status(getContext()));
            return;
        }
        backgroundAskedAt = System.currentTimeMillis();
        requestPermissionForAlias("background", call, "afterBackground");
    }

    private long backgroundAskedAt = 0;

    @PermissionCallback
    private void afterBackground(PluginCall call) {
        // An answer within half a second means Android didn't show anything: fall back to settings.
        if (getPermissionState("background") != PermissionState.GRANTED
            && System.currentTimeMillis() - backgroundAskedAt < 500) {
            openAppSettings();
        }
        TrackerService.startIfConfigured(getContext());
        call.resolve(status(getContext()));
    }

    /**
     * The phone numbers of the SIM cards in this phone, so a driver can only sign in with a number
     * whose SIM is in the phone. Many SIMs don't store their own number: those count as "unreadable".
     * Result: { permitted, sims, unreadable, numbers: [...] }
     */
    @PluginMethod
    public void getSimNumbers(PluginCall call) {
        if (phonePermitted()) {
            call.resolve(simInfo());
        } else {
            requestPermissionForAlias("phone", call, "afterPhone");
        }
    }

    @PermissionCallback
    private void afterPhone(PluginCall call) {
        call.resolve(simInfo());
    }

    /** READ_PHONE_STATE is enough to list the SIMs (READ_PHONE_NUMBERS only exists on Android 8+). */
    private boolean phonePermitted() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED;
    }

    @SuppressWarnings({"MissingPermission", "deprecation"})
    private JSObject simInfo() {
        Context context = getContext();
        JSObject r = new JSObject();
        JSArray numbers = new JSArray();
        boolean permitted = phonePermitted();
        int sims = -1;
        int unreadable = 0;
        if (permitted) {
            try {
                SubscriptionManager sm = (SubscriptionManager) context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE);
                List<SubscriptionInfo> subs = sm.getActiveSubscriptionInfoList();
                sims = subs == null ? 0 : subs.size();
                if (subs != null) {
                    for (SubscriptionInfo info : subs) {
                        String n = null;
                        if (Build.VERSION.SDK_INT >= 33) {
                            try { n = sm.getPhoneNumber(info.getSubscriptionId()); } catch (Exception ignored) { }
                        }
                        if (n == null || n.isEmpty()) n = info.getNumber();
                        if ((n == null || n.isEmpty()) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                            try {
                                TelephonyManager tm = ((TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE))
                                    .createForSubscriptionId(info.getSubscriptionId());
                                n = tm.getLine1Number();
                            } catch (Exception ignored) { }
                        }
                        if (n == null || n.isEmpty()) unreadable++;
                        else numbers.put(n);
                    }
                }
            } catch (Exception e) {
                sims = -1;
            }
        }
        r.put("permitted", permitted);
        r.put("sims", sims);
        r.put("unreadable", unreadable);
        r.put("numbers", numbers);
        return r;
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

    /**
     * Xiaomi, Oppo/Realme, Vivo, Infinix/Tecno and Huawei have their own "autostart" switch; without it
     * tracking doesn't restart after a reboot. Opens that brand's screen, or the app's settings.
     */
    private static final String[][] AUTOSTART_SCREENS = {
        { "com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity" },
        { "com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity" },
        { "com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity" },
        { "com.oplus.safecenter", "com.oplus.safecenter.permission.startup.StartupAppListActivity" },
        { "com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity" },
        { "com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity" },
        { "com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity" },
        { "com.transsion.phonemaster", "com.cyin.himgr.autostart.AutoStartActivity" },
        { "com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity" },
    };

    @PluginMethod
    public void openAutostartSettings(PluginCall call) {
        Context context = getContext();
        boolean opened = false;
        for (String[] screen : AUTOSTART_SCREENS) {
            try {
                Intent intent = new Intent();
                intent.setClassName(screen[0], screen[1]);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(intent);
                opened = true;
                break;
            } catch (Exception ignored) {
                // not this brand
            }
        }
        if (!opened) openAppSettings();
        JSObject result = status(context);
        result.put("openedAutostart", opened);
        call.resolve(result);
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
