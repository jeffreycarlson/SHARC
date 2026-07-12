package com.iabtechlab.sharcg6harness;

import android.app.Activity;
import android.app.Application;
import android.os.Bundle;

import java.lang.ref.WeakReference;

public final class HarnessApplication extends Application implements Application.ActivityLifecycleCallbacks {
    private int startedCount = 0;
    private int resumedCount = 0;
    private WeakReference<MainActivity> activeHarness = new WeakReference<>(null);

    @Override
    public void onCreate() {
        super.onCreate();
        registerActivityLifecycleCallbacks(this);
    }

    void registerHarness(MainActivity activity) {
        activeHarness = new WeakReference<>(activity);
    }

    void unregisterHarness(MainActivity activity) {
        MainActivity current = activeHarness.get();
        if (current == activity) activeHarness = new WeakReference<>(null);
    }

    private MainActivity harness() {
        return activeHarness.get();
    }

    @Override
    public void onActivityStarted(Activity activity) {
        if (!(activity instanceof MainActivity)) return;
        startedCount += 1;
        if (startedCount == 1) {
            MainActivity harness = harness();
            if (harness != null) harness.pushHostLifecycle("passive");
        }
    }

    @Override
    public void onActivityResumed(Activity activity) {
        if (!(activity instanceof MainActivity)) return;
        resumedCount += 1;
        if (resumedCount == 1) {
            MainActivity harness = harness();
            if (harness != null) harness.pushActiveWithExposureReasserts();
        }
    }

    @Override
    public void onActivityPaused(Activity activity) {
        if (!(activity instanceof MainActivity)) return;
        resumedCount = Math.max(0, resumedCount - 1);
        if (resumedCount == 0) {
            MainActivity harness = harness();
            if (harness != null) harness.pushHostLifecycle("passive");
        }
    }

    @Override
    public void onActivityStopped(Activity activity) {
        if (!(activity instanceof MainActivity)) return;
        startedCount = Math.max(0, startedCount - 1);
        if (startedCount == 0) {
            MainActivity harness = harness();
            if (harness != null) {
                harness.pushHostLifecycle("hidden");
                harness.pushHostExposure(0);
                harness.pushHostLifecycle("frozen");
            }
        }
    }

    @Override public void onActivityCreated(Activity activity, Bundle savedInstanceState) {}
    @Override public void onActivitySaveInstanceState(Activity activity, Bundle outState) {}
    @Override public void onActivityDestroyed(Activity activity) {}
}
