package io.github.dshnotify.client;
import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;
import java.net.URL;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

public final class DeviceApi {
  public static final class ApiException extends Exception {
    public final int status;
    ApiException(int code) { super("服务端响应 " + code); status = code; }
    public boolean retryable() { return status == 408 || status == 429 || status >= 500; }
  }
  public static JSONObject post(String base, String action, JSONObject data, String bearer) throws Exception {
    if (!java.util.Arrays.asList("pair", "device", "decision").contains(action)) throw new IllegalArgumentException("Unknown endpoint");
    HttpsURLConnection conn = (HttpsURLConnection) new URL(Links.base(base) + "__dsh-notify-me/fcm/" + action).openConnection();
    conn.setInstanceFollowRedirects(false); conn.setConnectTimeout(10000); conn.setReadTimeout(10000);
    conn.setRequestMethod("POST"); conn.setDoOutput(true); conn.setRequestProperty("Content-Type", "application/json");
    if (bearer != null) conn.setRequestProperty("Authorization", "Bearer " + bearer);
    byte[] body = data.toString().getBytes(StandardCharsets.UTF_8); conn.setFixedLengthStreamingMode(body.length);
    try {
      try (java.io.OutputStream out = conn.getOutputStream()) { out.write(body); }
      int code = conn.getResponseCode(); if (code < 200 || code >= 300) throw new ApiException(code);
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      try (InputStream in = conn.getInputStream()) { byte[] buffer = new byte[2048]; int n; while ((n = in.read(buffer)) != -1) { if (out.size() + n > 16384) throw new Exception("响应过大"); out.write(buffer, 0, n); } }
      JSONObject result = new JSONObject(out.toString("UTF-8"));
      if (!result.optBoolean("ok")) throw new Exception("服务端拒绝请求");
      return result;
    } finally { conn.disconnect(); }
  }
}
