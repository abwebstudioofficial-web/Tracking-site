package com.ibraya.tracking;

import android.os.Bundle;
import android.view.View;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TrackerPlugin.class);
        super.onCreate(savedInstanceState);
        keepPageBetweenSystemBars();
        // If tracking was on before (e.g. the app was closed), make sure it's running.
        TrackerService.startIfConfigured(this);
    }

    // The page must sit below the status bar and above the back/home buttons (and the keyboard),
    // on every Android version and brand. Done the same way everywhere: the app draws behind the
    // bars and the page area is padded by exactly their size.
    private void keepPageBetweenSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars()
                | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(content);
    }
}
