package io.github.dshnotify.client;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import androidx.work.Data;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

public final class PushService extends FirebaseMessagingService {
  private static final String ATTENTION = "dsh_attention", DONE = "dsh_done";
  public static void channels(Context c) {
    NotificationManager nm = c.getSystemService(NotificationManager.class);
    nm.createNotificationChannel(new NotificationChannel(ATTENTION, "需要你处理", NotificationManager.IMPORTANCE_HIGH));
    nm.createNotificationChannel(new NotificationChannel(DONE, "完成与状态", NotificationManager.IMPORTANCE_DEFAULT));
  }
  @Override public void onNewToken(String token) { DevicePrefs p = new DevicePrefs(this); p.token(token); SyncWorker.token(this); }
  @Override public void onMessageReceived(RemoteMessage message) {
    Map<String, String> data = message.getData(); DevicePrefs prefs = new DevicePrefs(this);
    if (!prefs.paired() || !"1".equals(data.get("schema"))) return;
    try {
      if (Long.parseLong(data.getOrDefault("expiresAt", "0")) < System.currentTimeMillis()) return;
      String url = data.get("url"), tag = data.get("notificationId");
      if (tag == null || tag.length() > 600 || !Links.allowed(prefs.base(), url)) return;
      String event = data.getOrDefault("event", ""), sid = data.getOrDefault("sessionId", "");
      boolean approval = "approval".equals(event) && !data.getOrDefault("requestId", "").isEmpty();
      Notification.Builder n = note(this, tag, data.getOrDefault("title", "DSH"), data.getOrDefault("sessionTitle", ""), data.getOrDefault("body", ""), url, !"completed".equals(event));
      if (approval) {
        n.addAction(action(this, data, "allowed-once", "允许一次"));
        n.addAction(action(this, data, "rejected", "拒绝"));
      }
      display(this, tag, n.build()); prefs.status("最近收到：" + data.getOrDefault("title", "DSH"));
    } catch (Exception ignored) { prefs.status("收到无效或过期通知"); }
  }
  private static Notification.Action action(Context c, Map<String, String> data, String outcome, String label) {
    String id = data.get("requestId");
    Intent i = new Intent(c, DecisionReceiver.class).setAction("io.github.dshnotify.client.DECIDE")
      .setData(Uri.parse("dshnotify://decision/" + Uri.encode(id) + "/" + outcome))
      .putExtra("requestId", id).putExtra("sessionId", data.get("sessionId")).putExtra("outcome", outcome)
      .putExtra("tag", data.get("notificationId")).putExtra("url", data.get("url")).putExtra("binding", new DevicePrefs(c).binding());
    PendingIntent pi = PendingIntent.getBroadcast(c, (id + outcome).hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    Notification.Action.Builder b = new Notification.Action.Builder(Icon.createWithResource(c, R.drawable.ic_notify), label, pi);
    if (Build.VERSION.SDK_INT >= 31) b.setAuthenticationRequired(true);
    return b.build();
  }
  static Notification.Builder note(Context c, String tag, String title, String session, String text, String url, boolean attention) {
    channels(c);
    Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    PendingIntent click = PendingIntent.getActivity(c, tag.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    return new Notification.Builder(c, attention ? ATTENTION : DONE).setSmallIcon(R.drawable.ic_notify)
      .setContentTitle(title + (session.isEmpty() ? "" : " · " + session)).setContentText(text)
      .setStyle(new Notification.BigTextStyle().bigText(text)).setContentIntent(click).setAutoCancel(true)
      .setOnlyAlertOnce(true).setVisibility(Notification.VISIBILITY_PRIVATE).setCategory(attention ? Notification.CATEGORY_MESSAGE : Notification.CATEGORY_STATUS);
  }
  static void display(Context c, String tag, Notification note) {
    if (Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
    c.getSystemService(NotificationManager.class).notify(tag, 0, note);
  }
  static void result(Context c, Data data, String text) {
    String url = data.getString("url"), tag = data.getString("tag");
    if (tag == null || !Links.allowed(new DevicePrefs(c).base(), url)) return;
    display(c, tag, note(c, tag, "DSH · 审批结果", "", text, url, false).build());
  }
}
