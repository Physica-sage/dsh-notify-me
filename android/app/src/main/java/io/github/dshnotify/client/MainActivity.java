package io.github.dshnotify.client;
import android.Manifest;
import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.widget.*;
import android.content.Intent;
import android.net.Uri;
import com.google.firebase.messaging.FirebaseMessaging;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public final class MainActivity extends Activity {
  private final ExecutorService io = Executors.newSingleThreadExecutor();
  private EditText url, code, name;
  private TextView status;
  private DevicePrefs prefs;
  private Button pair;
  @Override public void onCreate(Bundle state) {
    super.onCreate(state); prefs = new DevicePrefs(this); PushService.channels(this);
    if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
    ScrollView scroll = new ScrollView(this); LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
    int pad = (int) (24 * getResources().getDisplayMetrics().density); root.setPadding(pad, pad + 24, pad, pad); scroll.addView(root); setContentView(scroll);
    TextView title = new TextView(this); title.setText("DSH Notify"); title.setTextSize(28); root.addView(title);
    TextView hint = new TextView(this); hint.setText("轻量 FCM 通知与一次性审批\n不内置浏览器，不轮询，不运行常驻前台服务。\n需要 Google Play 服务和可用的推送网络。"); root.addView(hint);
    url = input(root, "DSH HTTPS 地址", prefs.paired() ? prefs.base() : ""); url.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    name = input(root, "设备名称", prefs.name());
    code = input(root, "服务器生成的一次性配对码（5 分钟内有效）", ""); code.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
    pair = button(root, "配对此设备", v -> pair());
    button(root, "同步设备 Token", v -> refreshToken());
    button(root, "打开 DSH", v -> { try { String u = Links.base(prefs.paired() ? prefs.base() : url.getText().toString()); startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(u))); } catch (Exception e) { show("地址无效"); } });
    button(root, "解除配对", v -> unpair());
    status = new TextView(this); status.setTextSize(16); root.addView(status); render();
    if (prefs.paired()) refreshToken();
  }
  private EditText input(LinearLayout root, String hint, String value) { EditText t = new EditText(this); t.setHint(hint); t.setText(value); t.setSingleLine(true); root.addView(t); return t; }
  private Button button(LinearLayout root, String text, View.OnClickListener onClick) { Button b = new Button(this); b.setText(text); b.setOnClickListener(onClick); root.addView(b); return b; }
  private void show(String text) { runOnUiThread(() -> { if (!isDestroyed()) { status.setText(text); pair.setEnabled(true); } }); }
  private void render() { status.setText((prefs.paired() ? "已配对：" + prefs.name() + "\n" + prefs.base() : "尚未配对") + "\n" + prefs.status()); }
  private void pair() {
    final String base, pairing = code.getText().toString().trim(), deviceName = name.getText().toString().trim();
    if (prefs.paired()) { show("请先解除现有配对，再绑定其他服务器。"); return; }
    try { base = Links.base(url.getText().toString()); } catch (Exception e) { show(e.getMessage()); return; }
    if (pairing.length() < 20) { show("请输入服务器生成的配对码"); return; }
    pair.setEnabled(false); status.setText("正在取得 FCM Token…");
    FirebaseMessaging.getInstance().setAutoInitEnabled(true);
    FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> io.execute(() -> {
      try {
        JSONObject result = DeviceApi.post(base, "pair", new JSONObject().put("pairingCode", pairing).put("token", token).put("name", deviceName), null);
        if (!Links.base(result.getString("publicUrl")).equals(base)) throw new Exception("服务端地址与配对地址不一致");
        prefs.pair(base, deviceName, result); prefs.token(token); prefs.status("配对成功"); SyncWorker.token(this);
        runOnUiThread(() -> { code.setText(""); pair.setEnabled(true); render(); });
      } catch (DeviceApi.ApiException e) { show(e.status == 403 ? "配对码无效或过期，请重新生成" : "配对失败：" + e.status); }
      catch (Exception e) { show("配对失败，请检查 HTTPS 地址、网络和插件配置"); }
    })).addOnFailureListener(e -> show("无法取得 FCM Token，请检查 Google Play 服务和 Google 推送网络"));
  }
  private void refreshToken() {
    if (!prefs.paired()) { show("请先配对"); return; }
    FirebaseMessaging.getInstance().setAutoInitEnabled(true);
    FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> { prefs.token(token); SyncWorker.token(this); show("已安排 Token 同步；联网后自动完成。"); })
      .addOnFailureListener(e -> show("FCM Token 不可用，请检查 Google Play 服务"));
  }
  private void unpair() {
    if (!prefs.paired()) { show("尚未配对"); return; }
    io.execute(() -> { try {
      DeviceApi.post(prefs.base(), "device", new JSONObject().put("action", "unpair"), prefs.bearer());
      prefs.clear(); FirebaseMessaging.getInstance().setAutoInitEnabled(false);
      androidx.work.WorkManager.getInstance(this).cancelAllWork(); show("已解除配对");
    } catch (Exception e) { show("解除失败：保持原配对。请联网重试或在服务端撤销设备。"); } });
  }
  @Override protected void onResume() { super.onResume(); if (status != null) render(); }
  @Override protected void onDestroy() { io.shutdown(); super.onDestroy(); }
}
