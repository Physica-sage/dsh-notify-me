package io.github.dshnotify.client;
import android.content.Intent;
import androidx.test.core.app.ApplicationProvider;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class)
public class LinksTest {
  @Test public void canonicalBaseAndSubpath() { assertEquals("https://dsh.example/base/", Links.base("https://DSH.example/base")); }
  @Test public void onlySameHttpsOriginAllowed() {
    String base = "https://dsh.example/";
    assertTrue(Links.allowed(base, "https://dsh.example/#dsh-notify-session=session-1"));
    assertFalse(Links.allowed(base, "https://evil.example/#x"));
    assertFalse(Links.allowed(base, "http://dsh.example/"));
    assertFalse(Links.allowed(base, "intent://dsh.example/"));
    assertFalse(Links.allowed(base, "https://user@dsh.example/"));
    assertFalse(Links.allowed(base, "https://dsh.example:8443/"));
    assertFalse(Links.allowed(base, "https://dsh.example/?token=secret"));
  }
  @Test public void subpathCannotEscape() {
    assertTrue(Links.allowed("https://dsh.example/base/", "https://dsh.example/base/#x"));
    assertFalse(Links.allowed("https://dsh.example/base/", "https://dsh.example/other/"));
    assertFalse(Links.allowed("https://dsh.example/base/", "https://dsh.example/base/../bad"));
    assertFalse(Links.allowed("https://dsh.example/base/", "https://dsh.example/base/%2e%2e/"));
  }
  @Test(expected=IllegalArgumentException.class) public void rejectsCredentialInBase() { Links.base("https://user:password@dsh.example/"); }
  @Test public void notificationBrowserIntentAsksEdgeToReuseCallerTab() {
    android.content.Context context = ApplicationProvider.getApplicationContext();
    Intent open = PushService.browserOpen(context, "https://dsh.example/#dsh-notify-session=session-1");
    assertEquals(Intent.ACTION_VIEW, open.getAction());
    assertEquals(context.getPackageName(), open.getStringExtra(android.provider.Browser.EXTRA_APPLICATION_ID));
    assertEquals("dsh-notify-session=session-1", open.getData().getFragment());
    assertFalse(open.getBooleanExtra(android.provider.Browser.EXTRA_CREATE_NEW_TAB, false));
    assertTrue((open.getFlags() & Intent.FLAG_ACTIVITY_NEW_TASK) != 0);
  }
}
