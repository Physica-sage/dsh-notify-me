package io.github.dshnotify.client;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Not exported. Only explicit, immutable notification PendingIntents reach here. */
public final class DecisionReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context c, Intent i) {
    if (!"io.github.dshnotify.client.DECIDE".equals(i.getAction())) return;
    android.app.KeyguardManager lock = c.getSystemService(android.app.KeyguardManager.class);
    if (lock != null && lock.isDeviceLocked()) return;
    String outcome = i.getStringExtra("outcome"), id = i.getStringExtra("requestId"), sid = i.getStringExtra("sessionId");
    if (!("allowed-once".equals(outcome) || "rejected".equals(outcome)) || id == null || sid == null || id.length() > 200 || sid.length() > 200) return;
    SyncWorker.decision(c, id, sid, outcome, i.getStringExtra("tag"), i.getStringExtra("url"), i.getStringExtra("binding"));
  }
}
