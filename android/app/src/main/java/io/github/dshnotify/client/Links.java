package io.github.dshnotify.client;
import java.net.URI;
import java.util.Locale;

public final class Links {
  private Links() {}
  public static String base(String text) {
    URI u = URI.create(text.trim());
    if (!"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null || u.getUserInfo() != null || u.getQuery() != null || u.getFragment() != null)
      throw new IllegalArgumentException("请输入不含账号、参数或片段的 HTTPS 地址");
    String path = u.getRawPath();
    if (path == null || path.isEmpty()) path = "/";
    if (path.contains("%") || path.contains("..") || path.contains("\\")) throw new IllegalArgumentException("不支持该地址路径");
    if (!path.endsWith("/")) path += "/";
    String host = u.getHost().toLowerCase(Locale.ROOT);
    String port = u.getPort() == -1 || u.getPort() == 443 ? "" : ":" + u.getPort();
    return "https://" + host + port + path;
  }
  public static boolean allowed(String configured, String target) {
    try {
      URI a = URI.create(base(configured)), b = URI.create(target);
      int ap = a.getPort() == -1 ? 443 : a.getPort(), bp = b.getPort() == -1 ? 443 : b.getPort();
      return "https".equalsIgnoreCase(b.getScheme()) && b.getUserInfo() == null && b.getHost() != null && a.getHost().equalsIgnoreCase(b.getHost()) && ap == bp
        && b.getRawQuery() == null && b.getRawPath().startsWith(a.getRawPath()) && !b.getRawPath().contains("..") && !b.getRawPath().contains("%");
    } catch (Exception e) { return false; }
  }
}
