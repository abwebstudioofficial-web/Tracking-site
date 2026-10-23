package com.ibraya.tracking;

import android.content.Context;
import android.location.Location;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * Positions recorded while the phone has no internet, kept in a small file so they survive the
 * app or phone restarting. {@link TrackerService} uploads them (public.track_backlog) once a
 * location gets through again, so the admin's trip history shows the road taken during the gap.
 *
 * Thinned like the server's history: a point every 20 s or 50 m while driving, every 2 min while
 * parked. One line per point: "epochMillis,lat,lng,speed" (speed -1 if unknown).
 */
class OfflineRoute {
    private static final long MIN_GAP_MS = 20_000;
    private static final long PARKED_GAP_MS = 2 * 60_000;
    private static final float MIN_METRES = 50f;
    private static final int MAX_POINTS = 20_000; // ~4 days of driving; the oldest go first
    static final int BATCH = 500;

    private final File file;
    private Location last;
    private int count = -1;

    OfflineRoute(Context context) {
        file = new File(context.getFilesDir(), "offline-route.csv");
    }

    /** Remembers a position that couldn't be sent (if it adds something to the route). */
    synchronized void add(Location location, float speed) {
        long t = location.getTime() > 0 ? location.getTime() : System.currentTimeMillis();
        if (last != null) {
            long gap = t - last.getTime();
            if (gap < MIN_GAP_MS) return;
            if (gap < PARKED_GAP_MS && location.distanceTo(last) < MIN_METRES) return;
        }
        last = new Location(location);
        last.setTime(t);
        try (FileWriter out = new FileWriter(file, true)) {
            out.write(t + "," + location.getLatitude() + "," + location.getLongitude() + "," + (speed >= 0 ? speed : -1) + "\n");
        } catch (IOException e) {
            return;
        }
        if (count >= 0) count++;
        if (size() > MAX_POINTS) keepLast(MAX_POINTS * 9 / 10);
    }

    synchronized int size() {
        if (count < 0) count = readLines().size();
        return count;
    }

    /** The oldest BATCH lines, as the JSON array track_backlog takes (damaged lines are left out). */
    synchronized JSONArray firstBatch() {
        List<String> lines = readLines();
        JSONArray points = new JSONArray();
        for (int i = 0; i < lines.size() && i < BATCH; i++) {
            String[] f = lines.get(i).split(",");
            if (f.length < 4) continue;
            try {
                JSONArray p = new JSONArray();
                p.put(Long.parseLong(f[0]));
                p.put(Double.parseDouble(f[1]));
                p.put(Double.parseDouble(f[2]));
                double speed = Double.parseDouble(f[3]);
                p.put(speed >= 0 ? (Object) speed : JSONObject.NULL);
                points.put(p);
            } catch (Exception ignored) {
                // a damaged line: skip it
            }
        }
        return points;
    }

    /** Forgets the first n lines (they were uploaded). */
    synchronized void dropFirst(int n) {
        List<String> lines = readLines();
        write(lines.subList(Math.min(n, lines.size()), lines.size()));
    }

    synchronized void clear() {
        file.delete();
        count = 0;
        last = null;
    }

    private void keepLast(int n) {
        List<String> lines = readLines();
        write(lines.subList(Math.max(0, lines.size() - n), lines.size()));
    }

    private void write(List<String> lines) {
        try (FileWriter out = new FileWriter(file, false)) {
            for (String line : lines) out.write(line + "\n");
            count = lines.size();
        } catch (IOException e) {
            count = -1;
        }
        if (lines.isEmpty()) last = null;
    }

    private List<String> readLines() {
        List<String> lines = new ArrayList<>();
        if (!file.exists()) return lines;
        try (BufferedReader in = new BufferedReader(new FileReader(file))) {
            String line;
            while ((line = in.readLine()) != null) if (!line.isEmpty()) lines.add(line);
        } catch (IOException ignored) {
            // unreadable: treat as empty
        }
        return lines;
    }
}
