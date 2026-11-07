package io.github.dshnotify.client;
import org.junit.Test;
import static org.junit.Assert.*;
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
}
