package xyz.nexus404.hecate;
import org.json.JSONObject;
public final class AppUpdateTest {
  public static void main(String[] args) throws Exception {
    JSONObject release = new JSONObject().put("version", "0.1.39").put("code", 40).put("sha256", new String(new char[64]).replace('\0', 'a'));
    if (!AppUpdate.newer(release, 39) || AppUpdate.newer(release, 40) || AppUpdate.newer(release, 41) || AppUpdate.newer(null, 39)) throw new AssertionError();
    release.put("version", "https://bad.example");
    if (AppUpdate.newer(release, 39)) throw new AssertionError();
    release.put("version", "0.1.39").put("sha256", "invalid");
    if (AppUpdate.newer(release, 39)) throw new AssertionError();
    System.out.println("APK update metadata: malformed, equal and downgrade releases rejected OK");
  }
}
