package com.ibraya.tracking;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TrackerPlugin.class);
        super.onCreate(savedInstanceState);
        // If tracking was on before (e.g. the app was closed), make sure it's running.
        TrackerService.startIfConfigured(this);
    }
}
