package io.github.dshnotify.client;
import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.*;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

public final class SyncWorker extends Worker {
  public SyncWorker(@NonNull Context c, @NonNull WorkerParameters p) { super(c, p); }
  private static OneTimeWorkRequest.Builder request(Data data) {
    return new OneTimeWorkRequest.Builder(SyncWorker.class).setInputData(data)
      .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS);
  }
  public static void token(Context c) {
    DevicePrefs p = new DevicePrefs(c); if (!p.paired() || p.token().isEmpty()) return;
    Data d = new Data.Builder().putString("kind", "token").putString("binding", p.binding()).build();
    WorkManager.getInstance(c).enqueueUniqueWork("dsh-token", ExistingWorkPolicy.REPLACE, request(d).build());
  }
  public static void decision(Context c, String requestId, String sid, String outcome, String tag, String url, String binding) {
    DevicePrefs p = new DevicePrefs(c); if (!p.paired() || !p.binding().equals(binding)) return;
    Data d = new Data.Builder().putString("kind", "decision").putString("binding", binding).putString("requestId", requestId)
      .putString("sessionId", sid).putString("outcome", outcome).putString("tag", tag).putString("url", url).build();
    WorkManager.getInstance(c).enqueueUniqueWork("dsh-decision-" + requestId, ExistingWorkPolicy.KEEP, request(d).setInitialDelay(0, TimeUnit.SECONDS).build());
  }
  @NonNull @Override public Result doWork() {
    DevicePrefs p = new DevicePrefs(getApplicationContext());
    if (!p.paired() || !p.binding().equals(getInputData().getString("binding"))) return Result.failure();
    boolean decision = "decision".equals(getInputData().getString("kind"));
    try {
      JSONObject data = new JSONObject();
      String endpoint;
      if (decision) {
        endpoint = "decision";
        data.put("requestId", getInputData().getString("requestId")).put("sessionId", getInputData().getString("sessionId")).put("outcome", getInputData().getString("outcome"));
      } else {
        endpoint = "device"; data.put("action", "token").put("token", p.token()).put("revision", p.revision());
      }
      DeviceApi.post(p.base(), endpoint, data, p.bearer());
      p.status(decision ? "审批已提交" : "设备 Token 已同步");
      if (decision) PushService.result(getApplicationContext(), getInputData(), "allowed-once".equals(getInputData().getString("outcome")) ? "已允许本次操作" : "已拒绝操作");
      return Result.success();
    } catch (DeviceApi.ApiException e) {
      if (e.retryable() && getRunAttemptCount() < 4) return Result.retry();
      p.status(e.status == 401 ? "配对已失效，请重新配对" : "请求未完成：" + e.status);
      if (decision) PushService.result(getApplicationContext(), getInputData(), e.status == 409 ? "审批已处理或过期，请查看会话" : "审批提交失败，请查看会话");
      return Result.failure();
    } catch (Exception e) {
      if (getRunAttemptCount() < 4) return Result.retry();
      p.status("网络或凭据错误，请打开应用检查");
      if (decision) PushService.result(getApplicationContext(), getInputData(), "审批未提交，请查看会话");
      return Result.failure();
    }
  }
}
