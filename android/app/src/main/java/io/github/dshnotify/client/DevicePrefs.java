package io.github.dshnotify.client;
import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.security.KeyStore;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

public final class DevicePrefs {
  private final SharedPreferences prefs;
  public DevicePrefs(Context context) { prefs = context.getSharedPreferences("dsh_native", Context.MODE_PRIVATE); }
  private SecretKey key() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
    if (!store.containsAlias("dsh_device_secret")) {
      KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
      gen.init(new KeyGenParameterSpec.Builder("dsh_device_secret", KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()); gen.generateKey();
    }
    return (SecretKey) store.getKey("dsh_device_secret", null);
  }
  public synchronized void pair(String base, String name, JSONObject response) throws Exception {
    String bearer = response.getString("deviceId") + "." + response.getString("deviceSecret");
    Cipher c = Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.ENCRYPT_MODE, key());
    String encrypted = Base64.encodeToString(c.doFinal(bearer.getBytes(java.nio.charset.StandardCharsets.UTF_8)), Base64.NO_WRAP);
    if (!prefs.edit().putString("base", Links.base(base)).putString("name", name).putString("binding", UUID.randomUUID().toString())
      .putString("credential", encrypted).putString("iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP)).commit()) throw new Exception("无法保存配对");
  }
  public String bearer() throws Exception {
    Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
    c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(prefs.getString("iv", ""), Base64.NO_WRAP)));
    return new String(c.doFinal(Base64.decode(prefs.getString("credential", ""), Base64.NO_WRAP)), java.nio.charset.StandardCharsets.UTF_8);
  }
  public String base() { return prefs.getString("base", ""); }
  public String name() { return prefs.getString("name", "Android"); }
  public String binding() { return prefs.getString("binding", ""); }
  public boolean paired() { return !binding().isEmpty() && !base().isEmpty(); }
  public void clear() { prefs.edit().remove("credential").remove("iv").remove("base").remove("binding").commit(); }
  public void token(String value) {
    synchronized (DevicePrefs.class) {
      if (!value.equals(prefs.getString("token", ""))) {
        long rev = Math.max(prefs.getLong("revision", 0) + 1, System.currentTimeMillis());
        prefs.edit().putString("token", value).putLong("revision", rev).commit();
      }
    }
  }
  public String token() { return prefs.getString("token", ""); }
  public long revision() { return prefs.getLong("revision", 1); }
  public String status() { return prefs.getString("status", "等待配对"); }
  public void status(String value) { prefs.edit().putString("status", value).apply(); }
}
